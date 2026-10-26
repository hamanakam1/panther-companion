import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state/store.js";
import { claimWriter, currentWriter, describeHolder, isHolderGone, writerLeasePath } from "../src/state/writer.js";
import type { Observation } from "../src/domain.js";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "panther-writer-"));
  return { dir, db: join(dir, "state.sqlite"), lease: writerLeasePath(join(dir, "state.sqlite")), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const observation = (id: string): Observation => ({ id, providerId: "terminal", capturedAt: "2026-10-26T00:00:00Z", label: "npm test", locator: "/app", summary: "npm test failed", payload: { exitCode: 1 }, signature: `sig-${id}` });
const writerModule = new URL("../src/state/writer.js", import.meta.url).href;
function childClaim(db: string, home: string): ChildProcess {
  return spawn(process.execPath, ["--input-type=module", "-e", `
    import { claimWriter } from ${JSON.stringify(writerModule)};
    let claim;
    process.on('message', message => {
      if (message === 'claim') { claim = claimWriter(process.env.PANTHER_DB, 'test child'); process.send({owned:claim.owned}); }
      if (message === 'release') { claim?.release(); process.exit(0); }
    });
    process.send({ready:true});
  `], { env: { ...process.env, PANTHER_DB: db, PANTHER_HOME: home }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
}
async function message(child: ChildProcess): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("child did not report before deadline")), 5000);
    const onMessage = (value: unknown) => finish(undefined, value as Record<string, unknown>);
    const onExit = () => finish(new Error("child exited before reporting"));
    const finish = (error?: Error, value?: Record<string, unknown>) => { clearTimeout(timeout); child.off("message", onMessage); child.off("exit", onExit); error ? reject(error) : resolve(value!); };
    child.once("message", onMessage); child.once("exit", onExit);
  });
}
async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, "close"); child.kill("SIGKILL"); await ended;
}

describe("single writer arbitration", () => {
  it("creates a private missing parent and releases only after the writable store closes", () => {
    const s = scratch(); const db = join(s.dir, "new-home", "state.sqlite");
    const owner = Store.open(db, { surface: "test owner" });
    try {
      assert.ok(existsSync(db));
      assert.throws(() => Store.open(db), /Another Companion surface owns/);
      assert.match(describeHolder(currentWriter(db)!), /test owner/);
    } finally { owner.close(); }
    const next = claimWriter(db, "successor");
    try { assert.equal(next.owned, true); } finally { next.release(); s.done(); }
  });

  it("refuses a second writer even when a live owner's heartbeat is old or metadata is missing", () => {
    const s = scratch(); const own = claimWriter(s.db, "panel", () => 0);
    try {
      assert.equal(isHolderGone(currentWriter(s.db)!), false);
      assert.equal(claimWriter(s.db, "server").owned, false);
      rmSync(s.lease);
      assert.equal(claimWriter(s.db, "server").owned, false, "the SQLite lock, not JSON, is authority");
      writeFileSync(s.lease, "not JSON");
      assert.equal(claimWriter(s.db, "server").owned, false);
      own.heartbeat();
      assert.equal(currentWriter(s.db)?.protocol, "sqlite-lock-v1");
    } finally { own.release(); s.done(); }
  });

  it("refuses a live legacy JSON-only owner regardless of heartbeat age", () => {
    const s = scratch();
    try {
      writeFileSync(s.lease, JSON.stringify({ token: "legacy", pid: process.pid, surface: "v1.2.1 panel", startedAt: "1970-01-01T00:00:00Z", heartbeatAt: "1970-01-01T00:00:00Z" }));
      const guest = claimWriter(s.db, "updated command");
      assert.equal(guest.owned, false); assert.equal(guest.holder?.surface, "v1.2.1 panel");
      assert.match(readFileSync(s.lease, "utf8"), /legacy/);
    } finally { s.done(); }
  });

  it("gives exactly one simultaneously released child the writer lock", async () => {
    const s = scratch(); const children: ChildProcess[] = [];
    try {
      const ready = Array.from({ length: 8 }, () => { const child = childClaim(s.db, join(s.dir, "home")); children.push(child); return message(child); });
      await Promise.all(ready);
      const answers = children.map(child => { const answer = message(child); child.send("claim"); return answer; });
      const results = await Promise.all(answers);
      assert.equal(results.filter(value => value.owned).length, 1);
      assert.equal(claimWriter(s.db, "parent").owned, false, "winner remains alive while every contender reports");
    } finally { await Promise.all(children.map(terminate)); s.done(); }
  });

  it("fails closed when a possible legacy owner record cannot be verified", () => {
    const s = scratch();
    try {
      writeFileSync(s.lease, '{"token":');
      const claim = claimWriter(s.db, "updated command");
      assert.equal(claim.owned, false); assert.throws(() => claim.assertOwned(s.db), /writer record cannot be verified/);
      assert.equal(readFileSync(s.lease, "utf8"), '{"token":');
    } finally { s.done(); }
  });

  it("releases authority after a crashed child without waiting for heartbeat expiry", async () => {
    const s = scratch(); const child = childClaim(s.db, join(s.dir, "home"));
    try {
      await message(child); const answer = message(child); child.send("claim"); assert.equal((await answer).owned, true);
      await terminate(child);
      const successor = claimWriter(s.db, "successor");
      try { assert.equal(successor.owned, true); } finally { successor.release(); }
    } finally { await terminate(child); s.done(); }
  });

  it("normalizes directory symlinks so aliases cannot obtain another writer", () => {
    const s = scratch(); const alias = `${s.dir}-alias`; const own = claimWriter(s.db, "panel");
    try { symlinkSync(s.dir, alias, "dir"); assert.equal(claimWriter(join(alias, "state.sqlite"), "alias").owned, false); }
    finally { own.release(); rmSync(alias, { force: true }); s.done(); }
  });

  it("a released claim cannot open a writable store or remove its successor", () => {
    const s = scratch(); const old = claimWriter(s.db, "panel"); old.release(); const next = claimWriter(s.db, "successor");
    try {
      assert.equal(old.owned, false); assert.throws(() => Store.open(s.db, { writer: old }), /closed/);
      old.release(); old.heartbeat(); assert.equal(currentWriter(s.db)?.surface, "successor");
    } finally { next.release(); s.done(); }
  });

  it("read-only guests never initialize the goal or allow evidence writes", () => {
    const s = scratch(); const owner = Store.open(s.db); const before = owner.stateRevision();
    try {
      const guest = Store.open(s.db, { readOnly: true });
      try {
        assert.throws(() => guest.insertObservation(observation("one")), /readonly|read-only|SQLITE/i);
        assert.equal(guest.getGoal("2026-10-26T00:00:00Z").correctedByUser, false);
        assert.equal(guest.stateRevision(), before); assert.equal(owner.latestObservations().length, 0);
      } finally { guest.close(); }
      owner.insertObservation(observation("two")); assert.equal(owner.latestObservations().length, 1);
    } finally { owner.close(); s.done(); }
  });

  it("read-only access to absent state does not create any directories", () => {
    const s = scratch(); const home = join(s.dir, "missing");
    try { assert.throws(() => Store.open(join(home, "state.sqlite"), { readOnly: true }), /No readable Companion state/); assert.equal(existsSync(home), false); }
    finally { s.done(); }
  });
});
