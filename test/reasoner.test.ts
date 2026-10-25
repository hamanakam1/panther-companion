import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { reasonLocally } from "../src/core/reasoner.js";
import type { ReasonerInput, Observation } from "../src/domain.js";

let seq = 0;
const obs = (providerId: string, payload: Record<string, unknown>, signature: string): Observation => ({
  id: `obs-${++seq}`,
  providerId,
  capturedAt: "2026-10-22T12:00:00Z",
  label: "x",
  locator: "/app",
  summary: "x",
  payload,
  signature,
});

const input = (observations: Observation[], overrides: Partial<ReasonerInput> = {}): ReasonerInput => ({
  goal: { id: "g", hypothesis: "ship migrate", confidence: 0.8, correctedByUser: false, needsCorrection: false, updatedAt: "now" },
  observations,
  openQuestions: [],
  recentSummaries: [],
  depthByTopic: {},
  now: "now",
  brief: false,
  returnToTask: false,
  ...overrides,
});

describe("reasoner local", () => {
  it("command failure -> topic command-failure, nextCheck, observed stderr", () => {
    const out = reasonLocally(input([obs("terminal", { command: "migrate", exitCode: 1, stderr: "database is locked", stdout: "", cwd: "/app", gitBranch: "main", truncated: false }, "term-fail:migrate")]));
    assert.equal(out.topic, "command-failure");
    assert.ok(out.nextCheck.length > 0);
    assert.ok(out.observed.some((t) => t.includes("database is locked")));
    assert.ok(out.confidence > 0);
    assert.equal(out.routineSuccess, false);
  });
  it("routine success -> routine-success topic, zero surface intent", () => {
    const out = reasonLocally(input([obs("terminal", { command: "git status", exitCode: 0, stderr: "", stdout: "On branch main", cwd: "/app", gitBranch: "main", truncated: false }, "term-ok:git-status")]));
    assert.equal(out.topic, "routine-success");
    assert.equal(out.routineSuccess, true);
    assert.ok(out.nextCheck.includes("No check is suggested"));
  });
  it("doc mismatch -> doc-mismatch topic, decisionNeeded", () => {
    const out = reasonLocally(input([
      obs("browser", { docClaim: { key: "port", value: "3000" } }, "browser-doc:a"),
      obs("browser", { docClaim: { key: "port", value: "8080" } }, "browser-doc:b"),
    ]));
    assert.equal(out.topic, "doc-mismatch");
    assert.equal(out.decisionNeeded, true);
    assert.equal(out.usedObservationIds.length, 2);
  });
  it("multiple agents same failure -> shared-agent-failure", () => {
    const out = reasonLocally(input([
      obs("agent", { agent: "review-agent", level: "error", message: "database is locked" }, "agent-fail:db-locked"),
      obs("agent", { agent: "build-agent", level: "error", message: "database is locked" }, "agent-fail:db-locked"),
    ]));
    assert.equal(out.topic, "shared-agent-failure");
    assert.equal(out.usedObservationIds.length, 2);
  });
  it("empty capture -> empty-capture topic", () => {
    const out = reasonLocally(input([]));
    assert.equal(out.topic, "empty-capture");
    assert.equal(out.confidence, 0.2);
  });
  it("brief mode -> decision-brief topic", () => {
    const out = reasonLocally(input([], { brief: true, openQuestions: [{ id: "q", text: "Which strategy?", observationIds: [], status: "open", createdAt: "t", updatedAt: "t" }] }));
    assert.equal(out.topic, "decision-brief");
    assert.equal(out.decisionNeeded, true);
  });
});
