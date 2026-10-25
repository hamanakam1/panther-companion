#!/usr/bin/env node
import { createServer } from "node:http";
import { Store } from "./state/store.js";
import { Panther } from "./ingest.js";
import { LocalReasoner } from "./core/reasoner.js";
import { OllamaReasoner } from "./reasoning/ollama.js";
import { TerminalAdapter } from "./adapters/terminal.js";
import { BrowserAdapter } from "./adapters/browser.js";
import { DesktopCaptureAdapter } from "./adapters/desktop.js";
import { AgentEventAdapter } from "./adapters/agent.js";
import { loadConfig } from "./config.js";
import { cardPath, pantherHome } from "./paths.js";
import type { IngestResult } from "./domain.js";
import { readFileSync } from "node:fs";

const HOME = pantherHome();
const DEFAULT_DB = `${HOME}/state.sqlite`;

function buildAdapters(): import("./adapters/adapter.js").Adapter[] {
  return [
    new TerminalAdapter(),
    new BrowserAdapter(),
    new DesktopCaptureAdapter(),
    new AgentEventAdapter(),
  ];
}

function buildReasoner(config: ReturnType<typeof loadConfig>) {
  if (config.reasoning.provider === "ollama") {
    return new OllamaReasoner(config.reasoning.ollamaUrl, config.reasoning.model, {
      fallbackToLocal: config.reasoning.fallbackToLocal,
    });
  }
  return new LocalReasoner();
}

function panther(dbPath: string): Panther {
  const config = loadConfig(null);
  const store = Store.open(dbPath);
  const adapters = buildAdapters();
  const reasoner = buildReasoner(config);
  return new Panther({ store, adapters, reasoner, threshold: config.threshold, followMinutes: config.followMinutes, insightTtlMinutes: config.insightTtlMinutes });
}

function nowIso(): string {
  return new Date().toISOString();
}

async function run() {
  const [, , command, ...args] = process.argv;
  const dbPath = process.env.PANTHER_DB ?? DEFAULT_DB;

  switch (command) {
    case "explain": {
      const p = panther(dbPath);
      const result = await p.explain({ onRequest: true, now: nowIso() });
      console.log(JSON.stringify(summary(result), null, 2));
      break;
    }
    case "follow": {
      const p = panther(dbPath);
      const { session, result } = await p.follow({ now: nowIso() });
      console.log(JSON.stringify({ session, ...summary(result) }, null, 2));
      break;
    }
    case "prepare": {
      const p = panther(dbPath);
      const result = await p.prepare({ now: nowIso(), naturalPause: true });
      console.log(JSON.stringify(summary(result), null, 2));
      break;
    }
    case "goal": {
      const p = panther(dbPath);
      const sub = args[0];
      if (sub === "set") {
        const hypothesis = args.slice(1).join(" ") || null;
        const goal = p.setGoal(hypothesis, nowIso());
        console.log(JSON.stringify(goal, null, 2));
      } else if (sub === "show") {
        console.log(JSON.stringify(p.store.getGoal(nowIso()), null, 2));
      } else {
        console.error("usage: panther goal [set <hypothesis> | show]");
        process.exit(1);
      }
      break;
    }
    case "feedback": {
      const p = panther(dbPath);
      const kind = args[0] as "AlreadyKnow" | "WrongTask" | "UsefulMoreLikeThis" | "ExplainMechanism" | "UsefulButLater";
      const insightId = args[1] ?? null;
      const topic = args[2] ?? null;
      if (!kind) {
        console.error("usage: panther feedback <AlreadyKnow|WrongTask|UsefulMoreLikeThis|ExplainMechanism|UsefulButLater> [insightId] [topic]");
        process.exit(1);
      }
      p.recordFeedback(kind, insightId, topic, nowIso());
      console.log(JSON.stringify({ ok: true, kind, insightId, topic }, null, 2));
      break;
    }
    case "status": {
      const p = panther(dbPath);
      const live = p.store.getLive();
      const goal = p.store.getGoal(nowIso());
      const counts = p.store.countInsights();
      console.log(JSON.stringify({ goal, live: live ? { insightId: live.insightId, topic: live.explanation.topic, using: live.using } : null, counts, sources: p.sources() }, null, 2));
      break;
    }
    case "serve": {
      const p = panther(dbPath);
      const port = Number(process.env.PANTHER_PORT || 8765);
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "", `http://localhost:${port}`);
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "content-type");
        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

        const handle = async () => {
          const pathname = url.pathname;
          if (pathname === "/" || pathname === "/card") {
            const html = readFileSync(cardPath(), "utf8");
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(html);
            return;
          }
          if (pathname === "/api/status") {
            const live = p.store.getLive();
            const goal = p.store.getGoal(nowIso());
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ goal, live: live ?? null, sources: p.sources() }));
            return;
          }
          if (pathname === "/api/explain" && req.method === "POST") {
            const result = await p.explain({ onRequest: true, now: nowIso() });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ...result, live: result.live ?? null }));
            return;
          }
          if (pathname === "/api/follow" && req.method === "POST") {
            const { session, result } = await p.follow({ now: nowIso() });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ session, ...result, live: result.live ?? null }));
            return;
          }
          if (pathname === "/api/prepare" && req.method === "POST") {
            const result = await p.prepare({ now: nowIso(), naturalPause: true });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ...result, live: result.live ?? null }));
            return;
          }
          if (pathname === "/api/goal" && req.method === "POST") {
            let body = "";
            for await (const chunk of req as unknown as AsyncIterable<Buffer>) body += chunk.toString();
            const parsed = JSON.parse(body || "{}");
            const goal = p.setGoal(parsed.hypothesis ?? null, nowIso());
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(goal));
            return;
          }
          if (pathname === "/api/feedback" && req.method === "POST") {
            let body = "";
            for await (const chunk of req as unknown as AsyncIterable<Buffer>) body += chunk.toString();
            const parsed = JSON.parse(body || "{}");
            p.recordFeedback(parsed.kind, parsed.insightId ?? null, parsed.topic ?? null, nowIso());
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (pathname === "/api/export") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(p.exportAll(), null, 2));
            return;
          }
          if (pathname === "/api/delete" && req.method === "POST") {
            p.deleteAll(nowIso());
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
        };
        handle().catch((err) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        });
      });
      server.listen(port, () => {
        console.log(`panther serve http://localhost:${port}  (db: ${dbPath})`);
      });
      break;
    }
    default:
      console.error("usage: panther [explain|follow|prepare|goal|feedback|status|serve]");
      process.exit(1);
  }
}

function summary(result: IngestResult) {
  return {
    raised: result.raised,
    decision: result.decision,
    live: result.live ?? null,
    storedObservationIds: result.storedObservationIds,
  };
}

run().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
