import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { decideGate, scoreRelevance, scoreNovelty, scorePreference } from "../src/core/gating.js";
import { unsetGoal, isUnsetGoal, correctGoal, applyWrongTask } from "../src/core/goal.js";
import { groupKeyFor, sharesSignature } from "../src/core/insights.js";
import { isRoutineSuccess } from "../src/core/routine.js";
import { normalizeSignature, tokens, clamp01, excerpt, asRecord, readString } from "../src/core/text.js";
import type { Goal, Observation } from "../src/domain.js";

const goal = (hypothesis = "ship the migrate command", needsCorrection = false): Goal => ({
  id: "g-1",
  hypothesis,
  confidence: 0.8,
  correctedByUser: false,
  needsCorrection,
  updatedAt: "2026-10-22T12:00:00Z",
});

const obs = (providerId = "terminal", signature = "sig", payload = {}): Observation => ({
  id: "o-1",
  providerId,
  capturedAt: "2026-10-22T12:00:00Z",
  label: "x",
  locator: "/app",
  summary: "x",
  payload,
  signature,
});

describe("gating", () => {
  it("explicit explain never suppresses", () => {
    const d = decideGate({ confidence: 0.1, relevance: 0.1, novelty: 0.1, preference: 0.1, threshold: 0.9, onRequest: true, paused: false, goalNeedsCorrection: false, routineSuccess: false, briefing: false, sessionMode: "none", sessionPaused: false, returnToTask: false, naturalPause: false, sameGroupQuietUpdate: false, collectingDecision: false });
    assert.equal(d.suppressInterrupt, false);
    assert.equal(d.updateLive, true);
  });
  it("paused suppresses", () => {
    const d = decideGate({ confidence: 1, relevance: 1, novelty: 1, preference: 1, threshold: 0.1, onRequest: false, paused: true, goalNeedsCorrection: false, routineSuccess: false, briefing: false, sessionMode: "follow", sessionPaused: false, returnToTask: false, naturalPause: false, sameGroupQuietUpdate: false, collectingDecision: false });
    assert.equal(d.suppressInterrupt, true);
    assert.equal(d.reason, "companion is paused");
  });
  it("routine success suppresses proactive (non-brief)", () => {
    const d = decideGate({ confidence: 0.9, relevance: 0.9, novelty: 0.9, preference: 1, threshold: 0.1, onRequest: false, paused: false, goalNeedsCorrection: false, routineSuccess: true, briefing: false, sessionMode: "follow", sessionPaused: false, returnToTask: false, naturalPause: false, sameGroupQuietUpdate: false, collectingDecision: false });
    assert.equal(d.suppressInterrupt, true);
    assert.equal(d.reason, "routine success");
  });
  it("goal needs correction suppresses", () => {
    const d = decideGate({ confidence: 1, relevance: 1, novelty: 1, preference: 1, threshold: 0.1, onRequest: false, paused: false, goalNeedsCorrection: true, routineSuccess: false, briefing: false, sessionMode: "follow", sessionPaused: false, returnToTask: false, naturalPause: false, sameGroupQuietUpdate: false, collectingDecision: false });
    assert.equal(d.suppressInterrupt, true);
    assert.equal(d.reason, "goal needs correction");
  });
  it("below threshold suppresses", () => {
    const d = decideGate({ confidence: 0.2, relevance: 0.2, novelty: 0.2, preference: 0.2, threshold: 0.5, onRequest: false, paused: false, goalNeedsCorrection: false, routineSuccess: false, briefing: false, sessionMode: "follow", sessionPaused: false, returnToTask: false, naturalPause: false, sameGroupQuietUpdate: false, collectingDecision: false });
    assert.equal(d.suppressInterrupt, true);
    assert.equal(d.updateLive, false);
    assert.ok(d.reason.includes("below threshold"));
  });
});

describe("goal", () => {
  it("unset goal is detected", () => {
    assert.ok(isUnsetGoal(unsetGoal("now")));
    assert.ok(!isUnsetGoal(goal()));
  });
  it("correctGoal raises confidence and clears correction flag", () => {
    const g = correctGoal(goal("wrong", true), "ship migrate", "now");
    assert.equal(g.hypothesis, "ship migrate");
    assert.equal(g.confidence, 0.9);
    assert.equal(g.correctedByUser, true);
    assert.equal(g.needsCorrection, false);
  });
  it("applyWrongTask lowers confidence and flags correction", () => {
    const g = applyWrongTask(goal(), "now");
    assert.ok(g.confidence <= 0.25);
    assert.equal(g.needsCorrection, true);
  });
});

describe("insights", () => {
  it("group key from signatures", () => {
    assert.equal(groupKeyFor([obs("a", "sig1"), obs("b", "sig1")]), "sig1");
    assert.equal(groupKeyFor([obs("a", "b"), obs("c", "a")]), "a+b");
    assert.equal(groupKeyFor([]), "none");
  });
  it("sharesSignature", () => {
    assert.ok(sharesSignature([obs("a", "s"), obs("b", "s")]));
    assert.ok(!sharesSignature([obs("a", "s"), obs("b", "t")]));
    assert.ok(!sharesSignature([obs("a", "s")]));
  });
});

describe("routine", () => {
  it("routine success requires terminal, exit 0, no stderr", () => {
    assert.ok(isRoutineSuccess([obs("terminal", "s", { command: "ls", exitCode: 0, stderr: "", stdout: "a\n", truncated: false })]));
    assert.ok(!isRoutineSuccess([obs("terminal", "s", { command: "ls", exitCode: 1, stderr: "", stdout: "", truncated: false })]));
    assert.ok(!isRoutineSuccess([obs("terminal", "s", { command: "ls", exitCode: 0, stderr: "boom", stdout: "", truncated: false })]));
    assert.ok(!isRoutineSuccess([obs("browser", "s", {})]));
    assert.ok(!isRoutineSuccess([]));
  });
});

describe("text", () => {
  it("normalizeSignature redacts paths and hashes", () => {
    const s = normalizeSignature("/Users/mike/app/db.sqlite command abcd1234ef5678");
    assert.ok(!s.includes("/Users"));
    assert.ok(!s.includes("abcd1234ef5678"));
  });
  it("tokens splits and filters short parts", () => {
    assert.ok(tokens("git status").has("git"));
    assert.ok(tokens("git status").has("status"));
    assert.ok(!tokens("ab").has("ab"));
  });
  it("clamp01", () => {
    assert.equal(clamp01(-1), 0);
    assert.equal(clamp01(2), 1);
    assert.equal(clamp01(0.5), 0.5);
    assert.equal(clamp01(NaN), 0);
  });
  it("excerpt truncates", () => {
    assert.equal(excerpt("hello", 10), "hello");
    assert.equal(excerpt("this is a long sentence", 10), "this is a…");
  });
  it("asRecord / readString", () => {
    assert.deepEqual(asRecord({ a: 1 }), { a: 1 });
    assert.equal(asRecord(null), null);
    assert.equal(asRecord([1, 2]), null);
    assert.equal(readString({ a: "b" }, "a"), "b");
    assert.equal(readString({ a: 1 }, "a"), null);
    assert.equal(readString(null, "a"), null);
  });
});

describe("scoreRelevance", () => {
  it("returns low for unset goal", () => {
    assert.equal(scoreRelevance(unsetGoal("now"), [], [], false), 0.1);
  });
  it("scores shared tokens", () => {
    const g = goal("migrate the database");
    const o = obs("terminal", "s", { command: "migrate --prod", exitCode: 1 });
    const r = scoreRelevance(g, [o], [], false);
    assert.ok(r > 0.5);
  });
});

describe("scoreNovelty", () => {
  it("empty signatures => 0", () => {
    assert.equal(scoreNovelty([], true, false), 0);
  });
  it("known active and no new member => near zero", () => {
    assert.equal(scoreNovelty(["s"], true, false), 0.05);
  });
});

describe("scorePreference", () => {
  it("known signature => 0", () => {
    assert.equal(scorePreference({ paused: false, depthByTopic: {}, knownSignatures: ["s"], topicWeights: {} }, "t", ["s"]), 0);
  });
});
