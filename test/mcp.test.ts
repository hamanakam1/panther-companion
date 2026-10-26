import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const server = new URL("../mcp/server.js", import.meta.url).pathname;

/**
 * Drive the compiled MCP server the way a client does: write requests, then
 * close stdin. Every response must arrive whole — a client that closes the pipe
 * right after its last request is the normal case, not an edge case.
 */
function run(requests: unknown[], env: Record<string, string> = {}, finalNewline = true): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) { reject(new Error(`server exited ${code}: ${err}`)); return; }
      resolve(out.split("\n").filter(line => line.trim()));
    });
    child.stdin.end(requests.map(request => JSON.stringify(request)).join("\n") + (finalNewline ? "\n" : ""));
  });
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "panther-mcp-"));
  return { dir, db: join(dir, "state.sqlite"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("MCP stdio server", () => {
  it("drains a complete final request without a trailing newline", async () => {
    const s = scratch();
    try {
      const lines = await run([{jsonrpc: "2.0", id: 9, method: "ping"}], {PANTHER_DB: s.db, PANTHER_HOME: s.dir}, false);
      assert.deepEqual(lines.map(line => JSON.parse(line)), [{jsonrpc: "2.0", id: 9, result: {}}]);
    } finally {s.done();}
  });
  it("rejects malformed envelopes without an unhandled rejection and keeps notifications silent", async () => {
    const s = scratch();
    try {
      const lines = await run([null, [], {jsonrpc: "2.0", id: 1}, {jsonrpc: "2.0", id: 2, method: 42},
        {jsonrpc: "2.0", id: {}, method: "ping"}, {jsonrpc: "1.0", id: 3, method: "ping"},
        {jsonrpc: "2.0", id: 4, method: "tools/call", params: []},
        {jsonrpc: "2.0", method: "notifications/initialized"}, {jsonrpc: "2.0", method: "ping"},
        {jsonrpc: "2.0", id: 5, method: "ping"}], {PANTHER_DB: s.db, PANTHER_HOME: s.dir});
      assert.equal(lines.length, 8);
      const replies = lines.map(line => JSON.parse(line));
      assert.ok(replies.slice(0, -1).every(reply => reply.error?.code === -32600));
      assert.deepEqual(replies.at(-1), {jsonrpc: "2.0", id: 5, result: {}});
    } finally {s.done();}
  });

  it("fails explicitly at the shutdown deadline when an accepted handler never settles", {timeout: 5000}, async () => {
    const s = scratch();
    const config = join(s.dir, "config.json");
    const preload = join(s.dir, "fake-runtime.mjs");
    writeFileSync(config, JSON.stringify({reasoning: {provider: "ollama", ollamaUrl: "http://127.0.0.1:1/api/generate", model: "synthetic", fallbackToLocal: false}}));
    // Only this owned child gets a stalled transport and accelerated timers.
    // No model or network service is invoked; production has no test knob.
    writeFileSync(preload, 'globalThis.fetch = () => new Promise(() => {}); const timer = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...args) => timer(fn, Math.min(ms, 50), ...args);');
    const child = spawn(process.execPath, ["--import", preload, server], {env: {...process.env, PANTHER_DB: s.db, PANTHER_HOME: s.dir, PANTHER_CONFIG: config,
      PANTHER_TERMINAL_LOG: join(s.dir, "terminal.jsonl"), PANTHER_BROWSER_LOG: join(s.dir, "browser.jsonl"), PANTHER_AGENT_LOG: join(s.dir, "agent.jsonl")}, stdio: ["pipe", "pipe", "pipe"]});
    let output = "", errors = "";
    child.stdout.on("data", chunk => {output += chunk;}); child.stderr.on("data", chunk => {errors += chunk;});
    const closed = once(child, "close");
    try {
      child.stdin.end(JSON.stringify({jsonrpc: "2.0", id: 7, method: "tools/call", params: {name: "panther_explain"}}) + "\n");
      const [code] = await closed;
      assert.equal(code, 1); assert.equal(output, "");
      assert.match(errors, /shutdown timed out.*completion is unconfirmed/);
      const {claimWriter} = await import("../src/state/writer.js");
      const successor = claimWriter(s.db, "synthetic timeout successor");
      try {assert.equal(successor.owned, true);} finally {successor.release();}
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL"); await closed; s.done();
    }
  });

  for (const ending of ["EOF", "SIGTERM"] as const) it(`drains an accepted asynchronous response before ${ending} releases the writer`, { timeout: 8000 }, async () => {
    const s = scratch();
    let deliver!: (responses: ServerResponse[]) => void;
    const entered = new Promise<ServerResponse[]>(resolve => { deliver = resolve; });
    const responses: ServerResponse[] = [];
    const model = createServer((request, response) => { request.resume(); responses.push(response); if (responses.length === 2) deliver(responses); });
    model.listen(0, "127.0.0.1"); await once(model, "listening");
    const address = model.address(); assert.ok(address && typeof address !== "string");
    const config = join(s.dir, "config.json");
    writeFileSync(config, JSON.stringify({reasoning: {provider: "ollama", ollamaUrl: `http://127.0.0.1:${address.port}/api/generate`, model: "synthetic", fallbackToLocal: false}}));
    const child = spawn(process.execPath, [server], {env: {...process.env, PANTHER_DB: s.db, PANTHER_HOME: s.dir, PANTHER_CONFIG: config,
      PANTHER_TERMINAL_LOG: join(s.dir, "terminal.jsonl"), PANTHER_BROWSER_LOG: join(s.dir, "browser.jsonl"), PANTHER_AGENT_LOG: join(s.dir, "agent.jsonl")}, stdio: ["pipe", "pipe", "pipe"]});
    let output = ""; let errors = "";
    child.stdout.on("data", chunk => {output += chunk;}); child.stderr.on("data", chunk => {errors += chunk;});
    const closed = once(child, "close");
    const {claimWriter} = await import("../src/state/writer.js");
    try {
      // Initialize the default goal before concurrent requests capture its
      // revision; goal creation itself correctly fences stale observations.
      child.stdin.write(JSON.stringify({jsonrpc: "2.0", id: 40, method: "tools/call", params: {name: "panther_get_goal"}}) + "\n");
      for (const id of [41, 42]) child.stdin.write(JSON.stringify({jsonrpc: "2.0", id, method: "tools/call", params: {name: "panther_explain"}}) + "\n");
      const responses = await Promise.race([entered, closed.then(() => {throw new Error(`MCP exited before fake model request: ${errors}`);}),
        delay(3000).then(() => {throw new Error("Synthetic model requests were not accepted in time");})]);
      if (ending === "EOF") child.stdin.end(); else child.kill("SIGTERM");
      await delay(60);
      assert.equal(child.exitCode, null, `${ending} waits for the accepted asynchronous tool`);
      const competitor = claimWriter(s.db, "synthetic competing writer");
      try {assert.equal(competitor.owned, false, "writer authority remains held while the request drains");} finally {competitor.release();}
      const body = JSON.stringify({done: true, response: JSON.stringify({whatItMeans: "Delayed synthetic response", whyItMattersHere: "Synthetic shutdown test", nextCheck: "Review the complete response",
        usedObservationIds: [], observed: Array.from({length: 40}, (_, index) => `Synthetic line ${index}: ` + "x".repeat(2000)), inferred: [], unknown: [], confidence: .9, topic: "shutdown-test", decisionNeeded: false, routineSuccess: false})});
      responses[1].end(body); await delay(40);
      assert.equal(child.exitCode, null, "finishing one handler does not abandon the other");
      responses[0].end(body);
      const [code] = await closed;
      assert.equal(code, ending === "EOF" ? 0 : 143, errors);
      const results = output.trim().split("\n").map(line => JSON.parse(line)); assert.equal(results.length, 3);
      assert.deepEqual(results.map(result => result.id).sort(), [40, 41, 42]);
      for (const result of results.filter(result => result.id !== 40)) {assert.equal(result.result.isError, false); assert.match(result.result.content[0].text, /Delayed synthetic response/);}
      assert.ok(output.length > 64_000, "the full large response is flushed");
      const successor = claimWriter(s.db, "synthetic successor");
      try {assert.equal(successor.owned, true, "the claim is released after shutdown");} finally {successor.release();}
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await closed;
      model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
      s.done();
    }
  });
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
    const claim = claimWriter(s.db, "Panther Companion panel");
    const owner = Store.open(s.db, {writer: claim});
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
    } finally { owner.close(); claim.release(); s.done(); }
  });
});
