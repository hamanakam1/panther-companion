#!/usr/bin/env node
import { createCompanionServer } from "./http.js";
import { CompanionController } from "./controller.js";
import { Store } from "./state/store.js";
import { Panther } from "./ingest.js";
import { LocalReasoner } from "./core/reasoner.js";
import { OllamaReasoner } from "./reasoning/ollama.js";
import { TerminalAdapter } from "./adapters/terminal.js";
import { BrowserAdapter } from "./adapters/browser.js";
import { DesktopCaptureAdapter } from "./adapters/desktop.js";
import { AgentEventAdapter } from "./adapters/agent.js";
import { loadConfig } from "./config.js";
import { pantherHome } from "./paths.js";
import { claimWriter, describeHolder } from "./state/writer.js";
import type { IngestResult } from "./domain.js";

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
      const controller = new CompanionController(p);
      console.log(JSON.stringify(await controller.action("follow"), null, 2));
      controller.start();
      const keepAlive = setInterval(() => {
        if (controller.status().session?.status !== "active") close();
      }, 1000);
      let closed = false;
      const close = () => { if (closed) return; closed = true; clearInterval(keepAlive); controller.stop(); p.store.close(); };
      process.once("SIGTERM", close); process.once("SIGINT", close);
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
      // Exactly one process may write. A second server is refused in words
      // rather than left to discover the collision as a lock timeout.
      const claim = claimWriter(dbPath, "Panther Companion server");
      if (!claim.owned) {
        console.error(`Panther Companion: the store ${dbPath} is already in use by ${claim.holder ? describeHolder(claim.holder) : "another process"}.`);
        console.error("Only one surface writes at a time. Use the surface that already owns it, or quit it and start this one again.");
        process.exitCode = 1;
        break;
      }
      const p = panther(dbPath);
      const port = Number(process.env.PANTHER_PORT || 8765);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PANTHER_PORT must be a valid port.");
      const controller = new CompanionController(p);
      const server = createCompanionServer(controller);
      controller.start();
      server.listen(port, "127.0.0.1", () => {
        console.log(`Panther Companion: http://127.0.0.1:${port}`);
      });
      server.on("error", error => { console.error(error.message); claim.release(); controller.stop(); process.exitCode = 1; });
      const close = () => { claim.release(); controller.stop(); server.close(() => { p.store.close(); }); };
      process.once("SIGTERM", close); process.once("SIGINT", close);
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
