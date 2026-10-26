import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const server = new URL("../mcp/server.js", import.meta.url).pathname;

/**
 * Drive the compiled MCP server the way a client does: write requests, then
 * close stdin. Every response must arrive whole — a client that closes the pipe
 * right after its last request is the normal case, not an edge case.
 */
function run(requests: unknown[], env: Record<string, string> = {}): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0 && !out) { reject(new Error(`server exited ${code}: ${err}`)); return; }
      resolve(out.split("\n").filter(line => line.trim()));
    });
    for (const request of requests) child.stdin.write(JSON.stringify(request) + "\n");
    child.stdin.end();
  });
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "panther-mcp-"));
  return { dir, db: join(dir, "state.sqlite"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("MCP stdio server", () => {
  it("returns every response whole when the client closes stdin right after its last request", async () => {
    const s = scratch();
    try {
      const lines = await run([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "panther_status", arguments: {} } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "panther_status", arguments: {} } },
      ], { PANTHER_DB: s.db });
      assert.equal(lines.length, 3, "one line per request, none truncated");
      const parsed = lines.map(line => JSON.parse(line) as { id: number; result?: { content?: { text: string }[] } });
      assert.deepEqual(parsed.map(response => response.id), [1, 2, 3]);
      for (const response of parsed.slice(1)) {
        const payload: unknown = JSON.parse(response.result!.content![0].text);
        assert.ok(payload && typeof payload === "object", "the tool payload is complete JSON");
      }
    } finally { s.done(); }
  });
  it("records an observation when it owns the store", async () => {
    const s = scratch();
    try {
      const [, , recorded] = await run([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "panther_feed_observation", arguments: { providerId: "terminal", label: "npm test", summary: "one failure", payload: { exitCode: 1 } } } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "panther_status", arguments: {} } },
      ], { PANTHER_DB: s.db });
      const parsed = JSON.parse(recorded) as { result?: { isError?: boolean } };
      assert.equal(parsed.result?.isError, false, "the owner may record");
    } finally { s.done(); }
  });
  it("refuses to record while another surface owns the store, and still reads", async () => {
    const s = scratch();
    const { Store } = await import("../src/state/store.js");
    const { claimWriter } = await import("../src/state/writer.js");
    const owner = Store.open(s.db);
    const claim = claimWriter(s.db, "Panther Companion panel");
    try {
      const lines = await run([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "panther_status", arguments: {} } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "panther_feed_observation", arguments: { providerId: "terminal", label: "npm test" } } },
      ], { PANTHER_DB: s.db });
      const responses = lines.map(line => JSON.parse(line) as { id: number; result?: unknown; error?: { message: string } });
      assert.equal(responses.find(response => response.id === 2)?.error, undefined, "reading is still allowed");
      assert.match(responses.find(response => response.id === 3)!.error!.message, /being written by Panther Companion panel \(PID \d+/);
      assert.equal(owner.latestObservations().length, 0, "the guest never wrote to the store");
    } finally { claim.release(); owner.close(); s.done(); }
  });
});
