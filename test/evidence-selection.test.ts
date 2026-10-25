import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CompanionController } from "../src/controller.js";
import { Panther } from "../src/ingest.js";
import { LocalReasoner, reasonLocally } from "../src/core/reasoner.js";
import { Store } from "../src/state/store.js";
import type { Observation, ReasonerInput } from "../src/domain.js";

const time = (second: number) => new Date(Date.UTC(2026, 9, 25, 8, 0, second)).toISOString();
function observation(id: string, second: number, payload: Record<string, unknown>, providerId = "terminal"): Observation {
  return { id, providerId, capturedAt: time(second), label: id, locator: "selected", summary: id, payload, signature: id };
}
function input(observations: Observation[], overrides: Partial<ReasonerInput> = {}): ReasonerInput {
  return { goal: { id: "goal", hypothesis: "Get tests passing", confidence: .9, correctedByUser: true, needsCorrection: false, updatedAt: time(0) }, observations, openQuestions: [], recentSummaries: [], depthByTopic: {}, now: time(30), brief: false, returnToTask: false, ...overrides };
}
function host() {
  let second = 0;
  const p = new Panther({ store: Store.memory(), adapters: [], reasoner: new LocalReasoner(), threshold: .25, followMinutes: 25, insightTtlMinutes: 45 });
  return { p, c: new CompanionController(p, () => time(second++)) };
}
const failed = (id = "failed", second = 1, context = {}) => observation(id, second, { command: "npm test", exitCode: 1, stderr: "Cannot find module", ...context });
const passed = (id = "passed", second = 2, context = {}) => observation(id, second, { command: "npm test", exitCode: 0, stdout: "67 passed", ...context });
const proposal = () => observation("capture-proposal", 0, { suggestedChecks: ["Check the captured navigation label."] }, "panther-ic");

describe("current evidence selection", () => {
  it("Explain after a successful rerun stays quiet and preserves both historical results", async () => {
    const { p, c } = host();
    try {
      await c.action("goal", { hypothesis: "Get npm tests passing" });
      await c.action("observation", { kind: "terminal", command: "npm test", exitCode: 1, text: "Cannot find module" });
      assert.equal(c.status().live?.explanation.topic, "command-failure");
      await c.action("observation", { kind: "terminal", command: "npm test", exitCode: 0, text: "67 passed" });
      assert.equal(c.status().live, null);
      await c.action("explain");
      assert.equal(c.status().live, null);
      assert.equal(c.status().lastDecision?.reason, "routine success");
      const history = p.exportAll().observations as { payload: string }[];
      assert.equal(history.length, 2);
      assert.deepEqual(history.map(row => JSON.parse(row.payload).exitCode).sort(), [0, 1]);
    } finally { p.store.close(); }
  });

  it("Explain keeps a new failure visible after importing an earlier IC proposal", async () => {
    const { p, c } = host();
    try {
      await c.action("goal", { hypothesis: "Verify the captured workflow" });
      await c.action("import", { useGoal: false, bundle: {
        schema: "https://github.com/hamanakam1/panther-intent-capture#intent-bundle", schema_version: "1.2", producer: "panther-intent-capture",
        authority: { export_only: true, requires_review: true, execution_authorized: false },
        recording: { id: "capture", title: "Navigation", stated_goal: "Check navigation", source_url: "https://example.test/" },
        tickets: [{ id: "proposal", title: "Review navigation", evidence: "Clicked a link", hypothesis: "", steps_to_reproduce: [], suggested_verification_steps: ["Check the label"], acceptance_criteria: [], questions: [], status: "draft", requires_review: true, execution_authorized: false }],
      } });
      await c.action("observation", { kind: "terminal", command: "npm test", exitCode: 1, text: "EADDRINUSE" });
      await c.action("explain");
      assert.equal(c.status().live?.explanation.topic, "command-failure");
      assert.match(c.status().live!.explanation.nextCheck, /EADDRINUSE/);
      assert.equal((p.exportAll().observations as Observation[]).length, 2);
    } finally { p.store.close(); }
  });

  it("uses event time instead of array order or a later ingestion time", () => {
    const newer = passed("newer", 3, { timestamp: time(2) });
    const replayed = failed("replayed", 4, { timestamp: time(1) });
    const result = reasonLocally(input([newer, replayed]));
    assert.equal(result.topic, "routine-success");
    assert.deepEqual(result.usedObservationIds, [newer.id]);
  });

  it("uses stable input order for equal timestamps and does not mutate supplied history", () => {
    const history = [failed("first", 1), passed("second", 1)];
    assert.equal(reasonLocally(input(history)).topic, "routine-success");
    assert.equal(reasonLocally(input([...history].reverse())).topic, "command-failure");
    assert.deepEqual(history.map(row => row.id), ["first", "second"]);
  });

  it("preserves failures for distinct commands, directories, branches, locations, and unknown context", () => {
    for (const success of [
      passed("other-command", 2, { command: "npm run build", cwd: "/app", gitBranch: "main" }),
      passed("other-directory", 2, { cwd: "/other", gitBranch: "main" }),
      passed("other-branch", 2, { cwd: "/app", gitBranch: "other" }),
      { ...passed("other-location", 2, { cwd: "/app", gitBranch: "main" }), locator: "another terminal" },
      passed("unknown-directory", 2, { gitBranch: "main" }),
      passed("unknown-branch", 2, { cwd: "/app" }),
      passed("manual-unknown", 2),
    ]) {
      const failure = failed("known-failure", 1, { cwd: "/app", gitBranch: "main" });
      const result = reasonLocally(input([failure, success]));
      assert.equal(result.topic, "command-failure", success.id);
      assert.deepEqual(result.usedObservationIds, [failure.id]);
    }
  });

  it("does not let an unfinished result or invalid timestamp supersede a known failure", () => {
    for (const uncertain of [
      observation("unfinished", 2, { command: "npm test", stdout: "running" }),
      observation("bad-exit", 2, { command: "npm test", exitCode: "0" }),
      passed("bad-event-time", 2, { timestamp: "unknown" }),
      { ...passed("bad-capture-time", 2), capturedAt: "unknown" },
    ]) assert.equal(reasonLocally(input([failed(), uncertain])).topic, "command-failure", uncertain.id);
  });

  it("chooses the newest unresolved failure rather than the first array member or a proposal", () => {
    const old = failed("old", 1);
    const newest = failed("newest", 3, { command: "npm run build", stderr: "Build failed" });
    const result = reasonLocally(input([newest, proposal(), old]));
    assert.equal(result.topic, "command-failure");
    assert.deepEqual(result.usedObservationIds, [newest.id]);
  });

  it("keeps source disagreements ahead of unverified imported proposals", () => {
    const left = observation("doc", 1, { docClaim: { key: "port", value: "3000" } }, "browser");
    const right = observation("config", 2, { projectFact: { key: "port", value: "8080" } }, "browser");
    const result = reasonLocally(input([proposal(), left, right, failed()]));
    assert.equal(result.topic, "doc-mismatch");
    assert.deepEqual(result.usedObservationIds, [left.id, right.id]);
  });

  it("preserves explicit Prepare's stored questions while current failures take precedence on return", () => {
    const openQuestions = [{ id: "question", text: "Which approach?", observationIds: ["earlier-evidence"], status: "open" as const, createdAt: time(0), updatedAt: time(0) }];
    assert.equal(reasonLocally(input([proposal(), failed()], { brief: true, openQuestions })).topic, "decision-brief");
    assert.equal(reasonLocally(input([failed()], { returnToTask: true, openQuestions })).topic, "command-failure");
    assert.equal(reasonLocally(input([], { returnToTask: true, openQuestions })).topic, "interrupted-task");
    assert.equal(openQuestions[0].status, "open");
  });
});
