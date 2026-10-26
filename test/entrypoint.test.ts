import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Store } from "../src/state/store.js";
import { claimWriter, currentWriter } from "../src/state/writer.js";
import { ownerCleanup } from "../src/electron/owner.js";

const exec = promisify(execFile);
const cli = new URL("../src/cli.js", import.meta.url).pathname;
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "panther-entrypoint-"));
  const home = join(dir, "fresh-home"); const db = join(home, "state.sqlite");
  const config = join(dir, "config.json"); writeFileSync(config, "{}");
  const env = { ...process.env, PANTHER_HOME: home, PANTHER_DB: db, PANTHER_CONFIG: config, PANTHER_TERMINAL_LOG: join(home, "terminal.jsonl"), PANTHER_AGENT_LOG: "", PANTHER_BROWSER_LOG: "" };
  return { dir, home, db, env, done: () => rmSync(dir, { recursive: true, force: true }) };
}
async function run(args: string[], env: NodeJS.ProcessEnv) {
  try { const result = await exec(process.execPath, [cli, ...args], { env, timeout: 8000 }); return { code: 0, ...result }; }
  catch (error) { const result = error as Error & { code: number; stdout: string; stderr: string }; return { code: result.code, stdout: result.stdout, stderr: result.stderr }; }
}
async function freePort(): Promise<number> {
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve())); return port;
}

describe("CLI store ownership", () => {
  it("refuses every mutating one-shot and follow command while another host owns the store", async () => {
    const s = scratch(); const owner = Store.open(s.db, { surface: "test panel" }); const revision = owner.stateRevision();
    try {
      for (const args of [["explain"], ["prepare"], ["follow"], ["goal", "set", "Changed without ownership"], ["feedback", "AlreadyKnow"], ["serve"]]) {
        const result = await run(args, s.env);
        assert.equal(result.code, 1, args.join(" "));
        assert.match(result.stderr, /Another Companion surface owns.*test panel/);
      }
      assert.equal(owner.stateRevision(), revision); assert.equal(owner.latestObservations().length, 0);
    } finally { owner.close(); s.done(); }
  });

  it("status and goal show remain read-only guests and never initialize an absent goal", async () => {
    const s = scratch(); const owner = Store.open(s.db, { surface: "test panel" }); const revision = owner.stateRevision(); const token = currentWriter(s.db)?.token;
    try {
      for (const args of [["status"], ["goal", "show"]]) {
        const result = await run(args, s.env); assert.equal(result.code, 0, result.stderr);
        assert.ok(JSON.parse(result.stdout)); assert.equal(owner.stateRevision(), revision); assert.equal(currentWriter(s.db)?.token, token);
      }
    } finally { owner.close(); s.done(); }
  });

  it("read commands on a fresh home explain recovery without creating state", async () => {
    const s = scratch();
    try {
      for (const args of [["status"], ["goal", "show"]]) {
        const result = await run(args, s.env); assert.equal(result.code, 1); assert.match(result.stderr, /No readable Companion state/); assert.equal(existsSync(s.home), false);
      }
    } finally { s.done(); }
  });

  it("a fresh one-shot writer creates state and releases it for the next command", async () => {
    const s = scratch();
    try {
      const result = await run(["goal", "set", "Make the workflow clear"], s.env); assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).hypothesis, "Make the workflow clear");
      const next = claimWriter(s.db, "next host"); try { assert.equal(next.owned, true); } finally { next.release(); }
      const read = await run(["goal", "show"], s.env); assert.equal(JSON.parse(read.stdout).hypothesis, "Make the workflow clear");
    } finally { s.done(); }
  });

  it("serve starts in a nonexistent home and releases its writer after graceful shutdown", async () => {
    const s = scratch(); const port = await freePort();
    const child = spawn(process.execPath, [cli, "serve"], { env: { ...s.env, PANTHER_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(child, "close");
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("owned server did not start")), 5000);
        child.stdout.on("data", chunk => { if (String(chunk).includes(`127.0.0.1:${port}`)) { clearTimeout(timeout); resolve(); } });
        child.once("exit", () => { clearTimeout(timeout); reject(new Error("owned server exited before startup")); });
      });
      const response = await fetch(`http://127.0.0.1:${port}/api/status`); assert.equal(response.status, 200);
      assert.equal(claimWriter(s.db, "contender").owned, false);
      child.kill("SIGTERM"); await closed;
      const next = claimWriter(s.db, "successor"); try { assert.equal(next.owned, true); } finally { next.release(); }
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } s.done(); }
  });
});

describe("desktop writer lifecycle", () => {
  it("closes a partially initialized store before giving its authority away", () => {
    const s = scratch(); const claim = claimWriter(s.db, "test panel"); const store = Store.open(s.db, { writer: claim });
    const cleanup = ownerCleanup(() => ({ claim, store }));
    try {
      cleanup(); cleanup();
      assert.throws(() => store.stateRevision(), /closed|not open/i);
      const next = claimWriter(s.db, "successor"); try { assert.equal(next.owned, true); } finally { next.release(); }
    } finally { store.close(); s.done(); }
  });

  it("keeps writer authority until accepted HTTP requests drain even when controller stop fails", () => {
    const s = scratch(); const claim = claimWriter(s.db, "test panel"); const store = Store.open(s.db, { writer: claim });
    let finish: (() => void) | undefined;
    const cleanup = ownerCleanup(() => ({ claim, store, controller: { stop() { throw new Error("stop failed"); } }, server: { listening: true, close(callback) { finish = callback; } } }));
    try {
      assert.throws(cleanup, /stop failed/);
      assert.equal(claimWriter(s.db, "too early").owned, false);
      assert.equal(store.stateRevision(), "initial", "accepted requests still have a usable store while draining");
      finish!(); assert.equal(claim.owned, false);
      const next = claimWriter(s.db, "successor"); try { assert.equal(next.owned, true); } finally { next.release(); }
    } finally { store.close(); s.done(); }
  });
});
