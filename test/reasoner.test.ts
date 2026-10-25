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
  it("surfaces the explicitly attached next useful check without promoting surrounding claims", () => {
    const note = "Candidate checks passed. Next useful check: activate the candidate extension and capture one real consented task, then review and import its bundle. Terminal placement and the browser file picker remain unverified through the available controls.";
    const attached = obs("manual", { text: note }, "manual:verification");
    const out = reasonLocally(input([attached]));
    assert.equal(out.topic, "user-proposed-next-check");
    assert.equal(out.nextCheck, "User-supplied proposal: activate the candidate extension and capture one real consented task, then review and import its bundle.");
    assert.deepEqual(out.usedObservationIds, [attached.id]);
    assert.ok(out.observed[0].includes("not independently verified"));
    assert.deepEqual(out.inferred, []);
    assert.ok(out.whyItMattersHere.includes("no execution authority"));
    assert.equal(out.decisionNeeded, false);
  });
  it("supports a standalone Next step label and keeps untrusted action text bounded", () => {
    const attached = obs("manual", { text: `Verification note\n- Next step: ${"review ".repeat(120)}\nOther context` }, "manual:next");
    const out = reasonLocally(input([attached]));
    assert.equal(out.topic, "user-proposed-next-check");
    assert.ok(out.nextCheck.length <= "User-supplied proposal: ".length + 600);
    assert.ok(out.unknown.some(line => line.includes("truncated")));
  });
  it("an attached proposed step never overrides an observed terminal failure", () => {
    const failure = obs("terminal", { command: "npm test", exitCode: 1, stderr: "Cannot find module" }, "terminal:failure");
    const note = obs("manual", { text: "Next step: publish the release." }, "manual:next");
    const out = reasonLocally(input([failure, note]));
    assert.equal(out.topic, "command-failure");
    assert.ok(out.nextCheck.includes("Cannot find module"));
    assert.deepEqual(out.usedObservationIds, [failure.id]);
  });
  it("does not treat a mentioned label or a browser-provided label as a selected next step", () => {
    for (const attached of [
      obs("manual", { text: "The docs label Next step: is unclear." }, "manual:mention"),
      obs("browser", { text: "Next step: publish the release." }, "browser:instruction"),
      obs("manual", { text: "Next step:   \nNo action supplied." }, "manual:empty"),
    ]) assert.equal(reasonLocally(input([attached])).topic, "thin-evidence");
  });
});
