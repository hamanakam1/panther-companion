import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/state/store.js";
import { claimWriter, currentWriter, describeHolder, isHolderGone, WRITER_STALE_MS, writerLeasePath } from "../src/state/writer.js";
import type { Observation } from "../src/domain.js";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "panther-writer-"));
  return { dir, db: join(dir, "state.sqlite"), lease: writerLeasePath(join(dir, "state.sqlite")), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const observation = (id: string): Observation => ({
  id, providerId: "terminal", capturedAt: "2026-10-26T00:00:00Z", label: "npm test",
  locator: "/app", summary: "npm test failed", payload: { exitCode: 1 }, signature: `sig-${id}`,
});

describe("single writer arbitration", () => {
  it("gives the store to one process and names the holder to the next", () => {
    const s = scratch();
    try {
      const first = claimWriter(s.db, "Panther Companion panel");
      assert.equal(first.owned, true);
      const second = claimWriter(s.db, "Panther Companion server");
      assert.equal(second.owned, false, "a second writer must not be granted the store");
      assert.equal(second.holder?.surface, "Panther Companion panel");
      assert.equal(second.holder?.pid, process.pid);
      assert.match(describeHolder(second.holder!), /Panther Companion panel \(PID \d+/);
      first.release();
    } finally { s.done(); }
  });

  it("reclaims a lease whose owner is gone, and one that stopped beating", () => {
    const s = scratch();
    try {
      writeFileSync(s.lease, JSON.stringify({ token: "dead", pid: 999_999, surface: "ghost", startedAt: "", heartbeatAt: new Date().toISOString() }));
      assert.equal(claimWriter(s.db, "panel").owned, true, "a dead pid must not hold the store forever");
      rmSync(s.lease, { force: true });

      const old = new Date(Date.now() - WRITER_STALE_MS - 5_000).toISOString();
      writeFileSync(s.lease, JSON.stringify({ token: "slow", pid: process.pid, surface: "stalled", startedAt: old, heartbeatAt: old }));
      assert.equal(claimWriter(s.db, "panel").owned, true, "a live process that stopped beating must not hold it either");
    } finally { s.done(); }
  });

  it("keeps the store with an owner that is still beating", () => {
    const s = scratch();
    try {
      const own = claimWriter(s.db, "panel");
      own.heartbeat();
      assert.equal(isHolderGone(currentWriter(s.db)!), false);
      assert.equal(claimWriter(s.db, "server").owned, false);
      own.release();
      assert.equal(currentWriter(s.db), null, "a released lease leaves nobody holding the store");
      assert.equal(claimWriter(s.db, "server").owned, true, "release hands the store over cleanly");
    } finally { s.done(); }
  });

  it("never deletes a lease that has already passed to another owner", () => {
    const s = scratch();
    try {
      const own = claimWriter(s.db, "panel");
      writeFileSync(s.lease, JSON.stringify({ token: "successor", pid: process.pid, surface: "server", startedAt: "", heartbeatAt: new Date().toISOString() }));
      own.release();
      assert.match(readFileSync(s.lease, "utf8"), /successor/, "the old owner must not evict its successor");
      own.heartbeat();
      assert.match(readFileSync(s.lease, "utf8"), /successor/, "a lapsed owner must not resurrect its claim");
    } finally { s.done(); }
  });

  it("attaches read-only when it does not own the store, and refuses writes there", () => {
    const s = scratch();
    try {
      claimWriter(s.db, "panel");
      const owner0 = Store.open(s.db); owner0.close(); // the owner creates the store before any guest attaches
      const guest = Store.open(s.db, { readOnly: true });
      try {
        assert.equal(guest.readOnly, true);
        assert.throws(() => guest.insertObservation(observation("one")), /readonly|read-only|SQLITE/i);
        assert.equal(guest.latestObservations().length, 0, "reading still works");
        assert.equal(guest.getGoal("2026-10-26T00:00:00Z").correctedByUser, false, "a missing goal is reported without being written");
      } finally { guest.close(); }
      const owner = Store.open(s.db);
      try { owner.insertObservation(observation("two")); assert.equal(owner.latestObservations().length, 1); } finally { owner.close(); }
    } finally { s.done(); }
  });
});
