#!/usr/bin/env node
/**
 * panther-eval — replay five required situations through the Panther core and
 * report whether each produced the expected explanation shape.
 *
 * Runs against an in-memory Store (no disk, no network), using the local
 * deterministic reasoner. A situation passes when its core assertions hold.
 *
 *   1. Unfamiliar command failure        -> topic command-failure, nextCheck set
 *   2. Doc mismatch                      -> topic doc-mismatch, decisionNeeded
 *   3. Multiple agents, same failure     -> topic shared-agent-failure
 *   4. Return to interrupted task        -> topic interrupted-task
 *   5. Routine successful work           -> raised === false (zero surface)
 *
 * Usage:  node dist/eval/run.js   (after `npm run build`)
 */
import { Store } from "../src/state/store.js";
import { Panther } from "../src/ingest.js";
import { LocalReasoner } from "../src/core/reasoner.js";
import type { Observation } from "../src/domain.js";

const FAILURE = {
  command: "migrate --prod",
  cwd: "/app",
  gitBranch: "main",
  exitCode: 1,
  stderr: "database is locked",
  stdout: "",
  truncated: false,
  timestamp: "2026-10-22T12:00:00Z",
};

const observations = {
  terminalFailure: (over: Partial<typeof FAILURE> = {}): Observation => ({
    id: "obs-1",
    providerId: "terminal",
    capturedAt: "2026-10-22T12:00:00Z",
    label: over.command ?? FAILURE.command,
    locator: over.cwd ?? FAILURE.cwd,
    summary: `${over.command ?? FAILURE.command} exited ${over.exitCode ?? FAILURE.exitCode}`,
    payload: { ...FAILURE, ...over },
    signature: "term-fail:migrate",
  }),
  terminalSuccess: (): Observation => ({
    id: "obs-2",
    providerId: "terminal",
    capturedAt: "2026-10-22T12:01:00Z",
    label: "git status",
    locator: "/app",
    summary: "git status exited 0",
    payload: { command: "git status", cwd: "/app", gitBranch: "main", exitCode: 0, stderr: "", stdout: "On branch main", truncated: false, timestamp: "2026-10-22T12:01:00Z" },
    signature: "term-ok:git-status",
  }),
  agentError: (name: string, message: string): Observation => ({
    id: `obs-agent-${name}`,
    providerId: "agent",
    capturedAt: "2026-10-22T12:02:00Z",
    label: `${name} error`,
    locator: name,
    summary: message,
    payload: { agent: name, level: "error", message, timestamp: "2026-10-22T12:02:00Z" },
    signature: `agent-fail:${name}`,
  }),
  browserDoc: (url: string, claim: string): Observation => ({
    id: "obs-doc",
    providerId: "browser",
    capturedAt: "2026-10-22T12:03:00Z",
    label: url,
    locator: url,
    summary: claim,
    payload: { url, title: "Docs", docClaim: { key: "port", value: "3000" }, accessibilityText: "", selection: "", focusedAt: "2026-10-22T12:03:00Z" },
    signature: `browser-doc:${url}`,
  }),
};

function makePanther() {
  const store = Store.memory();
  return new Panther({
    store,
    adapters: [],
    reasoner: new LocalReasoner(),
    threshold: 0.25,
    followMinutes: 25,
    insightTtlMinutes: 45,
  });
}

function assertOk(name: string, cond: boolean, detail = "") {
  if (!cond) {
    console.error(`FAIL ${name}: ${detail}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${name}`);
  }
}

async function run() {
  let failures = 0;

  // 1. Unfamiliar command failure
  {
    const p = makePanther();
    const obs = observations.terminalFailure();
    const result = await p.ingestObservations([obs], { onRequest: true, now: "2026-10-22T12:00:00Z" });
    const e = result.live?.explanation;
    assertOk("s1 command-failure topic", e?.topic === "command-failure", JSON.stringify(e?.topic));
    assertOk("s1 nextCheck present", typeof e?.nextCheck === "string" && e.nextCheck.length > 0, JSON.stringify(e?.nextCheck));
    assertOk("s1 observed cites stderr", (e?.observed ?? []).some((t: string) => t.includes("database is locked")), JSON.stringify(e?.observed));
    assertOk("s1 confidence > 0", (e?.confidence ?? 0) > 0, String(e?.confidence));
    assertOk("s1 evidence source terminal", (e?.evidence ?? []).some((x: { providerId: string }) => x.providerId === "terminal"));
  }

  // 2. Doc mismatch (two captured claims disagree)
  {
    const p = makePanther();
    const a = observations.browserDoc("https://example.com/docs", "port 3000");
    const b = { ...observations.browserDoc("https://example.com/config", "port 8080"), signature: "browser-doc:cfg", id: "obs-doc-2", locator: "https://example.com/config", payload: { url: "https://example.com/config", title: "Config", docClaim: { key: "port", value: "8080" }, accessibilityText: "", selection: "", focusedAt: "2026-10-22T12:03:00Z" } };
    const result = await p.ingestObservations([a, b], { onRequest: true, now: "2026-10-22T12:03:00Z" });
    const e = result.live?.explanation;
    assertOk("s2 doc-mismatch topic", e?.topic === "doc-mismatch", JSON.stringify(e?.topic));
    assertOk("s2 live card present", result.live !== null);
    assertOk("s2 both sources cited", (e?.evidence ?? []).length === 2, JSON.stringify(e?.evidence));
    assertOk("s2 unknown names the conflict", (e?.unknown ?? []).some((t: string) => t.includes("port")), JSON.stringify(e?.unknown));
  }

  // 3. Multiple agents hitting the same failure
  {
    const p = makePanther();
    const a1 = { ...observations.agentError("review-agent", "database is locked"), signature: "agent-fail:db-locked" };
    const a2 = { ...observations.agentError("build-agent", "database is locked"), id: "obs-agent-build-agent-2", signature: "agent-fail:db-locked" };
    const result = await p.ingestObservations([a1, a2], { onRequest: true, now: "2026-10-22T12:02:00Z" });
    const e = result.live?.explanation;
    assertOk("s3 shared-agent-failure topic", e?.topic === "shared-agent-failure", JSON.stringify(e?.topic));
    assertOk("s3 two agents cited", (e?.evidence ?? []).length === 2, JSON.stringify(e?.evidence));
  }

  // 4. Return to interrupted task
  {
    const p = makePanther();
    p.store.insertQuestion({ id: "q-1", text: "Which migration strategy should we use?", observationIds: ["obs-1"], status: "open", createdAt: "2026-10-22T11:00:00Z", updatedAt: "2026-10-22T11:00:00Z" });
    const result = await p.ingestObservations([], { onRequest: true, now: "2026-10-22T14:00:00Z", sessionMode: "follow", returnToTask: true });
    const e = result.live?.explanation;
    assertOk("s4 interrupted-task topic", e?.topic === "interrupted-task", JSON.stringify(e?.topic));
    assertOk("s4 live card present", result.live !== null);
    assertOk("s4 references the open question", (e?.observed ?? []).some((t: string) => t.includes("Which migration strategy")), JSON.stringify(e?.observed));
  }

  // 5. Routine successful work -> zero surface
  {
    const p = makePanther();
    const obs = observations.terminalSuccess();
    const result = await p.ingestObservations([obs], { onRequest: true, now: "2026-10-22T12:01:00Z" });
    assertOk("s5 suppressed (raised false)", result.raised === false, JSON.stringify(result.raised));
    assertOk("s5 no live card", result.live === null);
    assertOk("s5 decision below threshold / routine", result.decision.suppressInterrupt === true || result.decision.reason.includes("routine"), result.decision.reason);
  }

  if (process.exitCode) console.log(`\n${failures} situation(s) failed`);
  else console.log("\nAll 5 situations passed.");
}

run().catch((err) => {
  console.error("eval harness error:", err);
  process.exitCode = 1;
});
