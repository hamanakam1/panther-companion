#!/usr/bin/env node
/**
 * test-mcp.mjs — end-to-end test of the Panther MCP stdio server.
 *
 * Spawns `node dist/mcp/server.js`, speaks newline-delimited JSON-RPC 2.0:
 *   initialize -> notifications/initialized -> tools/list -> tools/call
 */
import { spawn } from "node:child_process";

const proc = spawn("node", ["dist/mcp/server.js"], {
  env: { ...process.env, PANTHER_DB: "/tmp/panther-mcp-test.sqlite" },
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
const pending = new Map();
let nextId = 1;

proc.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {}
  }
});
proc.stderr.on("data", (chunk) => process.stderr.write(`[mcp-stderr] ${chunk}`));

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

async function main() {
  const init = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "panther-test", version: "0.0.1" } });
  console.log("INITIALIZE OK:", JSON.stringify(init.result ?? init.error));
  notify("notifications/initialized", {});

  const tools = await send("tools/list", {});
  console.log("TOOLS LIST OK:", JSON.stringify(tools.result ?? tools.error));

  const explain = await send("tools/call", { name: "panther_explain", arguments: {} });
  console.log("TOOLS CALL EXPLAIN OK:", JSON.stringify(explain.result ?? explain.error));

  const status = await send("tools/call", { name: "panther_status", arguments: {} });
  console.log("TOOLS CALL STATUS OK:", JSON.stringify(status.result ?? status.error));

  const bad = await send("tools/call", { name: "panther_nonexistent", arguments: {} });
  console.log("TOOLS CALL BAD TOOL OK (error expected):", JSON.stringify(bad.error ?? bad.result));

  proc.kill();
}

main().catch((err) => {
  console.error("MCP TEST FAILED:", err);
  proc.kill();
  process.exit(1);
});
