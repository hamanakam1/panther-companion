#!/usr/bin/env node
/**
 * panther-mcp — minimal stdio MCP server for Panther Companion.
 *
 * Implements the MCP stdio JSON-RPC subset directly (no SDK dependency) so the
 * companion stays dependency-light:
 *   - initialize / notifications / ping
 *   - tools/list
 *   - tools/call  -> panther_get_goal, panther_status, panther_explain,
 *                    panther_feed_observation, panther_feedback
 *
 * Other tools (Claude, Cursor, Codex, ...) can read the current goal or feed
 * observations into the same reasoning core the desktop surface uses.
 */
import { Store } from "../src/state/store.js";
import { Panther } from "../src/ingest.js";
import { TerminalAdapter } from "../src/adapters/terminal.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { AgentEventAdapter } from "../src/adapters/agent.js";
import { LocalReasoner } from "../src/core/reasoner.js";
import { OllamaReasoner } from "../src/reasoning/ollama.js";
import { loadConfig } from "../src/config.js";
import { pantherHome } from "../src/paths.js";
import type { Observation } from "../src/domain.js";

const HOME = pantherHome();
const DEFAULT_DB = `${HOME}/state.sqlite`;
const config = loadConfig(null);
const store = Store.open(process.env.PANTHER_DB ?? DEFAULT_DB);
const adapters = [new TerminalAdapter(), new BrowserAdapter(), new AgentEventAdapter()];
const reasoner = config.reasoning.provider === "ollama"
  ? new OllamaReasoner(config.reasoning.ollamaUrl, config.reasoning.model, { fallbackToLocal: config.reasoning.fallbackToLocal })
  : new LocalReasoner();
const panther = new Panther({ store, adapters, reasoner, threshold: config.threshold, followMinutes: config.followMinutes, insightTtlMinutes: config.insightTtlMinutes });

const nowIso = () => new Date().toISOString();

type Request = { jsonrpc: "2.0"; id: string | number | null; method: string; params?: Record<string, unknown> };
type Response = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

function respond(id: Request["id"], result: unknown): Response {
  return { jsonrpc: "2.0", id, result };
}
function errorResponse(id: Request["id"], code: number, message: string): Response {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const TOOLS: Array<{ name: string; description: string; inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] } }> = [
  { name: "panther_get_goal", description: "Read the current goal hypothesis", inputSchema: { type: "object", properties: {} } },
  { name: "panther_status", description: "Live card, gate, insight counts", inputSchema: { type: "object", properties: {} } },
  { name: "panther_explain", description: "Run one-shot explain now against captured evidence", inputSchema: { type: "object", properties: { onRequest: { type: "boolean" } } } },
  { name: "panther_feed_observation", description: "An external tool pushes one structured observation", inputSchema: { type: "object", properties: { providerId: { type: "string" }, label: { type: "string" }, locator: { type: "string" }, summary: { type: "string" }, payload: { type: "object" } }, required: ["providerId", "label"] } },
  { name: "panther_feedback", description: "Record user feedback (AlreadyKnow | WrongTask | UsefulMoreLikeThis | ExplainMechanism | UsefulButLater)", inputSchema: { type: "object", properties: { kind: { type: "string" }, insightId: { type: "string" }, topic: { type: "string" } }, required: ["kind"] } },
];

const handlers: Record<string, (params?: Record<string, unknown>) => Promise<unknown>> = {
  async panther_get_goal() {
    return panther.store.getGoal(nowIso());
  },
  async panther_status() {
    const live = panther.store.getLive();
    return { goal: panther.store.getGoal(nowIso()), live: live ?? null, sources: panther.sources(), counts: panther.store.countInsights() };
  },
  async panther_explain(params) {
    const onRequest = (params?.onRequest as boolean | undefined) !== false;
    const result = await panther.explain({ onRequest, now: nowIso() });
    return { ...result, live: result.live ?? null };
  },
  async panther_feed_observation(params) {
    if (!params || typeof params.providerId !== "string" || typeof params.label !== "string") {
      throw new Error("params require providerId, label; optional locator/summary/payload");
    }
    const obs: Observation = {
      id: `obs-${Date.now()}`,
      providerId: String(params.providerId),
      capturedAt: nowIso(),
      label: String(params.label),
      locator: String(params.locator ?? ""),
      summary: String(params.summary ?? String(params.label)),
      payload: (params.payload as Record<string, unknown>) ?? {},
      signature: String(params.signature ?? `${params.providerId}:${params.label}`),
    };
    panther.store.insertObservation(obs);
    return { ok: true, observation: obs };
  },
  async panther_feedback(params) {
    if (!params || typeof params.kind !== "string") throw new Error("params require kind");
    panther.store.insertFeedback(params.kind as any, params.insightId as string | null, params.topic as string | null, nowIso());
    return { ok: true, kind: params.kind };
  },
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx: number;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    void handleLine(line);
  }
});

async function handleLine(line: string) {
  let request: Request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify(errorResponse(null, -32700, "parse error")) + "\n");
    return;
  }
  if (request.method.startsWith("notifications/")) {
    return; // notifications never get responses
  }
  if (request.method === "notifications/initialized") {
    return;
  }
  let result: unknown;
  try {
    if (request.method === "initialize") {
      result = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "panther-companion", version: "1.0.0" },
      };
    } else if (request.method === "ping") {
      result = {};
    } else if (request.method === "tools/list") {
      result = { tools: TOOLS };
    } else if (request.method === "tools/call") {
      const name = typeof request.params?.name === "string" ? request.params.name : "";
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
      const handler = handlers[name];
      if (!handler) {
        process.stdout.write(JSON.stringify(errorResponse(request.id, -32602, `unknown tool: ${name}`)) + "\n");
        return;
      }
      try {
        const value = await handler(args);
        result = { content: [{ type: "text", text: JSON.stringify(value) }], isError: false };
      } catch (err) {
        result = { content: [{ type: "text", text: String(err) }], isError: true };
      }
    } else {
      throw new Error(`method not found: ${request.method}`);
    }
  } catch (err) {
    process.stdout.write(JSON.stringify(errorResponse(request.id, -32603, String(err))) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify(respond(request.id, result)) + "\n");
}

process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
