import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OllamaReasoner } from "../src/reasoning/ollama.js";
import type { Observation, ReasonerInput, ReasonerOutput } from "../src/domain.js";

const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/ollama-ic-contradiction.json", import.meta.url), "utf8")) as {
  input: ReasonerInput; modelResponse: ReasonerOutput;
};
const terminal = (id: string, exitCode: number, second = 1): Observation => ({
  id, providerId: "terminal", capturedAt: `2026-10-25T08:00:0${second}Z`, label: "npm test", locator: "/synthetic/app",
  summary: `npm test exited ${exitCode}`, signature: id,
  payload: { command: "npm test", cwd: "/synthetic/app", gitBranch: "test", exitCode, stderr: exitCode ? "Cannot find module" : "", stdout: exitCode ? "" : "67 passed" },
});
const input = (observations: Observation[]): ReasonerInput => ({ ...structuredClone(fixture.input), observations });
const response = (ids: string[]): ReasonerOutput => ({
  whatItMeans: "The captured command could not resolve a module.", whyItMattersHere: "The import needs checking before the tests can pass.",
  nextCheck: "Check whether the named import resolves in this checkout.", usedObservationIds: ids,
  observed: ["npm test exited 1."], inferred: ["The import path may be wrong."], unknown: ["Whether the file exists."],
  confidence: .8, topic: "module-resolution", decisionNeeded: false, routineSuccess: false,
});

function mockModel(t: TestContext, output: unknown, envelope: Record<string, unknown> = {}) {
  const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, init, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ model: "synthetic-model", done: true, response: JSON.stringify(output), ...envelope }));
  });
  return requests;
}
const reasoner = (fallbackToLocal = false) => new OllamaReasoner("http://127.0.0.1:11434/api/generate", "synthetic-model", { fallbackToLocal });

describe("Ollama evidence boundary", () => {
  it("grounds the actual contradictory IC response while retaining useful model interpretation and proposed check", async t => {
    const original = structuredClone(fixture.input);
    const requests = mockModel(t, fixture.modelResponse);
    const result = await reasoner().reason(original);
    const observation = original.observations[0];
    assert.match(result.whatItMeans, /proposal to review/);
    assert.doesNotMatch(result.whatItMeans + result.whyItMattersHere, /current state is a failure to persist|HTTP 500 errors/);
    assert.ok(result.observed.includes(`[${observation.id}] Producer's evidence summary (not independently verified): ${(observation.payload as Record<string, unknown>).observedEvidence}`));
    assert.equal(result.observed.length, 3); // One evidence summary, two producer-reported steps.
    assert.ok(result.observed.every(line => line.startsWith(`[${observation.id}] Producer`)));
    assert.ok(result.observed.every(line => !line.includes("The hypothesis is:") && !line.includes("HTTP 500 errors")));
    assert.ok(result.unknown.some(line => line.includes("What value was persisted after the failed request?")));
    assert.ok(result.unknown.some(line => line.includes("acceptance conditions are met")));
    assert.ok(result.inferred.includes(`Unverified model interpretation: ${fixture.modelResponse.whyItMattersHere}`));
    assert.equal(result.nextCheck, `Model-proposed check (not performed): ${fixture.modelResponse.nextCheck}`);
    assert.deepEqual(result.usedObservationIds, [observation.id]);
    assert.equal(result.routineSuccess, false);
    assert.equal(result.confidence, .6);
    assert.equal(requests.length, 1); // Grounding is not a failed model call or a second provider.
    assert.doesNotMatch(result.whyItMattersHere, /Local fallback/);
    assert.deepEqual(original, fixture.input);
  });

  it("never promotes desired behavior or generated observed claims to imported facts", async t => {
    const source = structuredClone(fixture.input);
    source.observations[0].label = "Save preserves the option after reload";
    mockModel(t, { ...fixture.modelResponse, observed: ["Save persisted Express and reload verified it."], unknown: [], inferred: [], routineSuccess: true });
    const result = await reasoner().reason(source);
    assert.match(result.whatItMeans, /^A captured workflow has a proposal to review:/);
    assert.ok(result.observed.every(line => !line.includes("reload verified it")));
    assert.ok(result.unknown.some(line => line.includes("proposed issue reproduces")));
    assert.ok(result.unknown.some(line => line.includes("What value was persisted")));
    assert.equal(result.routineSuccess, false);
    assert.equal(result.decisionNeeded, true);
  });

  it("keeps each imported source attributed even if the model cites only one", async t => {
    const source = structuredClone(fixture.input);
    const second = structuredClone(source.observations[0]);
    second.id = "second-capture";
    second.payload = { ...(second.payload as Record<string, unknown>), observedEvidence: "A second producer reports a different selection." };
    source.observations.push(second);
    mockModel(t, fixture.modelResponse);
    const result = await reasoner().reason(source);
    assert.deepEqual(result.usedObservationIds, source.observations.map(observation => observation.id));
    assert.ok(result.observed.some(line => line.startsWith("[second-capture] Producer's evidence summary") && line.includes("different selection")));
    assert.ok(result.unknown.some(line => line.startsWith("[second-capture]")));
  });

  it("preserves a current terminal failure ahead of imported proposals in mixed input", async t => {
    const source = structuredClone(fixture.input);
    source.observations.push(terminal("current-failure", 1));
    mockModel(t, fixture.modelResponse);
    const result = await reasoner().reason(source);
    assert.match(result.whatItMeans, /npm test.*exited 1/);
    assert.ok(result.observed.some(line => line === "[current-failure] npm test exited 1."));
    assert.ok(result.observed.some(line => line.includes("Producer's evidence summary")));
    assert.ok(result.usedObservationIds.includes("current-failure"));
    assert.match(result.nextCheck, /Cannot find module/);
    assert.equal(result.topic, "command-failure");
    assert.equal(result.decisionNeeded, false);
    assert.ok(result.inferred.includes(`Alternative model-proposed check (not performed): ${fixture.modelResponse.nextCheck}`));
  });

  it("keeps Prepare's stored questions and actual provenance without inventing historical facts", async t => {
    const source = structuredClone(fixture.input);
    source.brief = true;
    source.openQuestions.push({ id: "question", text: "Which storage approach should be reviewed?", observationIds: ["historical-evidence"], status: "open", createdAt: "then", updatedAt: "now" });
    mockModel(t, fixture.modelResponse);
    const result = await reasoner().reason(source);
    assert.equal(result.topic, "decision-brief");
    assert.match(result.whatItMeans, /Which storage approach should be reviewed/);
    assert.equal(result.nextCheck, "Decide this before continuing: Which storage approach should be reviewed?");
    assert.equal(result.decisionNeeded, true);
    assert.ok(result.usedObservationIds.includes("historical-evidence"));
    assert.ok(result.observed.includes("Stored question: Which storage approach should be reviewed?"));
    assert.ok(result.unknown.some(line => line.includes("historical evidence absent from this input")));
    assert.ok(result.observed.every(line => !line.includes("current state is a failure to persist")));
  });

  it("links Prepare questions to current source evidence when it is supplied", async t => {
    const source = structuredClone(fixture.input);
    source.brief = true;
    source.openQuestions.push({ id: "question", text: "Which next check is useful?", observationIds: [source.observations[0].id], status: "open", createdAt: "then", updatedAt: "now" });
    mockModel(t, fixture.modelResponse);
    const result = await reasoner().reason(source);
    assert.deepEqual(result.usedObservationIds, [source.observations[0].id]);
    assert.ok(result.observed.includes("Stored question: Which next check is useful?"));
    assert.ok(result.observed.some(line => line.includes("Producer's evidence summary")));
    assert.ok(result.unknown.every(line => !line.includes("historical evidence absent")));
    assert.equal(result.topic, "decision-brief");
  });

  it("keeps terminal-only model reasoning and its configured request bounds", async t => {
    const model = response(["failed"]);
    const requests = mockModel(t, model);
    assert.deepEqual(await reasoner().reason(input([terminal("failed", 1)])), model);
    assert.equal(requests[0].body.model, "synthetic-model");
    assert.deepEqual(requests[0].body.options, { temperature: .2, num_predict: 700 });
    assert.equal(requests[0].body.stream, false);
    assert.equal(requests[0].init.redirect, "error");
    assert.ok(requests[0].init.signal instanceof AbortSignal);
  });

  it("uses current results in the model prompt and leaves stored input history intact", async t => {
    const history = [terminal("old-failure", 1), terminal("latest-pass", 0, 2)];
    const requests = mockModel(t, { ...response(["latest-pass"]), routineSuccess: true });
    const result = await reasoner().reason(input(history));
    const prompt = String(requests[0].body.prompt);
    const payload = JSON.parse(prompt.split("\n\nInput JSON:\n")[1]);
    assert.deepEqual(payload.observations.map((row: Observation) => row.id), ["latest-pass"]);
    assert.equal(result.routineSuccess, true);
    assert.deepEqual(history.map(row => row.id), ["old-failure", "latest-pass"]);
  });

  it("rejects stale IDs even when a stored question still references them", async t => {
    const source = input([terminal("old-failure", 1), terminal("latest-pass", 0, 2)]);
    source.openQuestions.push({ id: "question", text: "Did the command recover?", observationIds: ["old-failure"], status: "open", createdAt: "then", updatedAt: "now" });
    mockModel(t, response(["old-failure"]));
    await assert.rejects(reasoner().reason(source), /fallback is disabled/);
  });

  it("rejects mixed-type or missing arrays, foreign/duplicate IDs, invalid confidence and authority-like booleans", async t => {
    const mutations: Record<string, unknown>[] = [
      { observed: ["fact", 42] }, { unknown: null }, { inferred: undefined }, { usedObservationIds: ["failed", false] },
      { usedObservationIds: ["foreign"] }, { usedObservationIds: ["failed", "failed"] }, { usedObservationIds: [] },
      { confidence: "0.9" }, { confidence: 1.1 }, { decisionNeeded: "false" }, { routineSuccess: 1 },
      { observed: [""] }, { nextCheck: "x".repeat(4001) }, { inferred: Array(65).fill("claim") },
    ];
    for (const mutation of mutations) {
      t.mock.restoreAll();
      mockModel(t, { ...response(["failed"]), ...mutation });
      await assert.rejects(reasoner().reason(input([terminal("failed", 1)])), /fallback is disabled/, JSON.stringify(mutation));
    }
  });

  it("discloses local fallback in normal visible context and never claims a model success", async t => {
    const requests = mockModel(t, response(["foreign"]));
    const result = await reasoner(true).reason(input([terminal("failed", 1)]));
    assert.match(result.whyItMattersHere, /^Local fallback: the model response was unavailable or invalid\./);
    assert.deepEqual(result.usedObservationIds, ["failed"]);
    assert.match(result.whatItMeans, /exited 1/);
    assert.equal(requests.length, 1);
  });

  it("requires a terminal completed response and does not substitute fallback when disabled", async t => {
    mockModel(t, response(["failed"]), { done: false });
    await assert.rejects(reasoner().reason(input([terminal("failed", 1)])), /fallback is disabled/);
  });

  it("cannot silence a captured failure through model routineSuccess", async t => {
    const requests = mockModel(t, { ...response(["failed"]), routineSuccess: true });
    for (const source of [terminal("failed", 1), { ...terminal("failed", 0), providerId: "agent", payload: { level: "error", message: "Failed" } }]) {
      assert.equal((await reasoner().reason(input([source]))).routineSuccess, false);
    }
    assert.equal(requests.length, 2);
  });
});
