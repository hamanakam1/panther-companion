import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Panther } from "../src/ingest.js";
import { Store } from "../src/state/store.js";
import { CompanionController } from "../src/controller.js";
import { LocalReasoner } from "../src/core/reasoner.js";
import { parseIntentBundle } from "../src/bundle.js";

/**
 * A bundle produced by the real producer, not by this test.
 *
 * `fixtures/intent-bundle-real-1.2.json` was exported by panther-intent-capture
 * backend 1.7.0 (`GET /api/extension/export/<id>`) from a real 18.5s, 1-event
 * browser capture, with drafts generated in observed mode. The only edits are
 * the page identity: recording and proposal ids, the page title and the source
 * URL are replaced with neutral values so the operator's browsing is not
 * published here. Counts, provenance, evidence refs, questions, the empty
 * `stated_goal` and the authority block are exactly as exported.
 */
// Built tests run from dist/test, so reach the fixture where it is committed (as ollama.test.ts does).
const real = JSON.parse(readFileSync(new URL("../../test/fixtures/intent-bundle-real-1.2.json", import.meta.url), "utf8"));
const NOW = "2026-10-26T12:00:00.000Z";
const clone = (): any => JSON.parse(JSON.stringify(real));

function make() {
  const p = new Panther({ store: Store.memory(), adapters: [], reasoner: new LocalReasoner(), threshold: .25, followMinutes: 25, insightTtlMinutes: 45 });
  return { p, c: new CompanionController(p, () => NOW) };
}

describe("a real Intent Capture export", () => {
  it("previews with the producer's provenance intact", () => {
    const preview = parseIntentBundle(real, NOW);
    assert.equal(preview.recordingId, "capture-real-shape-01");
    assert.equal(preview.count, real.tickets.length);
    assert.equal(preview.goal, "", "this capture supplied no goal, so none can be adopted from it");
    assert.equal(preview.sourceUrl, "https://example.test/checkout");
    const observation = preview.observations[0];
    const payload = observation.payload as Record<string, unknown> & { observedSteps: string[] };
    assert.equal(observation.providerId, "panther-ic", "imported evidence is labelled as producer evidence");
    assert.equal(payload.requiresReview, true);
    assert.equal(payload.executionAuthorized, false);
    assert.equal(payload.recordingId, "capture-real-shape-01");
    assert.equal(payload.proposalId, "draft-real-shape-01");
    assert.match(String(payload.observedEvidence), /no AI inference was performed/);
    assert.deepEqual(payload.hypothesis, "", "an observed-only draft proposes no hypothesis");
  });

  it("imports, explains itself, and never becomes authorized work", async () => {
    const { p, c } = make();
    try {
      await c.action("goal", { hypothesis: "Decide whether the captured session needs a follow-up check" });
      const imported: any = await c.action("import", { bundle: real, useGoal: false });
      assert.equal(imported.imported, 1);
      const goal = p.store.getGoal(NOW);
      assert.equal(goal.hypothesis, "Decide whether the captured session needs a follow-up check", "the operator's goal survives an import");
      const stored = p.store.latestObservations();
      assert.equal(stored.length, 1);

      const explained: any = await c.action("explain", {});
      const card = explained.live.explanation;
      assert.equal(card.topic, "captured-intent", "the card is about the captured proposal");
      assert.equal(card.usedObservationIds?.[0] ?? card.evidence?.[0]?.observationId, stored[0].id, "the card cites exactly the imported evidence");
      assert.equal(card.evidence[0].providerId, "panther-ic");
      assert.ok(card.observed.every((line: string) => line.includes("not independently verified")), "producer claims are shown as claims");
      assert.deepEqual(card.inferred, [], "an observed-only draft infers nothing");
      assert.match(card.nextCheck, /not yet performed|Compare the captured steps|define one verifiable/i);
      const text = JSON.stringify(explained).toLowerCase();
      assert.ok(!/execution_authorized":true|authorized to (run|execute|deliver)/.test(text), "nothing in the card authorizes work");
    } finally { p.store.close(); }
  });

  it("keeps one identity per proposal when the same bundle is imported twice", async () => {
    const { p, c } = make();
    try {
      await c.action("import", { bundle: real, useGoal: false });
      await c.action("import", { bundle: real, useGoal: false });
      assert.equal(p.store.latestObservations().length, 1, "re-importing the same proposal does not duplicate it");
      const edited = clone();
      edited.tickets[0].hypothesis = "The control may be stuck";
      const preview = parseIntentBundle(edited, NOW);
      assert.notEqual(preview.observations[0].id, parseIntentBundle(real, NOW).observations[0].id, "an edited proposal is a new revision, not silent replacement");
    } finally { p.store.close(); }
  });

  it("rejects escalation and malformed variants of the real export", () => {
    const cases: Array<[string, (b: any) => void, RegExp]> = [
      ["authority.execution_authorized = true", b => { b.authority.execution_authorized = true; }, /authority/i],
      ["authority.requires_review = false", b => { b.authority.requires_review = false; }, /authority/i],
      ["authority.export_only = false", b => { b.authority.export_only = false; }, /authority/i],
      ["proposal claims execution authority", b => { b.tickets[0].execution_authorized = true; }, /authority/i],
      ["proposal skips review", b => { b.tickets[0].requires_review = false; }, /authority/i],
      ["proposal marked approved", b => { b.tickets[0].status = "approved"; }, /draft/i],
      ["older schema version", b => { b.schema_version = "1.1"; }, /1\.2/],
      ["another producer", b => { b.producer = "someone-else"; }, /1\.2/],
      ["tickets is not a list", b => { b.tickets = {}; }, /25 proposals/],
      ["javascript: recording source", b => { b.recording.source_url = "javascript:alert(1)"; }, /HTTP or HTTPS/],
      ["credentials in the recording source", b => { b.recording.source_url = "https://user:pw@example.test/x"; }, /credentials/i],
      ["duplicate proposal ids", b => { b.tickets.push(clone().tickets[0]); }, /unique/i],
      ["a local path as the recording id", b => { b.recording.id = "../../private"; }, /identifier/i],
      ["more proposals than the limit", b => { b.tickets = Array.from({ length: 26 }, (_, index) => ({ ...clone().tickets[0], id: `draft-${index}` })); }, /25 proposals/],
    ];
    for (const [label, mutate, expected] of cases) {
      const bundle = clone();
      mutate(bundle);
      assert.throws(() => parseIntentBundle(bundle, NOW), expected, label);
    }
  });

  it("accepts a real export that produced no proposals", async () => {
    const empty = clone();
    empty.tickets = [];
    assert.equal(parseIntentBundle(empty, NOW).count, 0);
    const { p, c } = make();
    try {
      const result: any = await c.action("import", { bundle: empty, useGoal: false });
      assert.equal(result.imported, 0);
      assert.equal(p.store.latestObservations().length, 0, "an empty export fabricates no evidence");
    } finally { p.store.close(); }
  });

  it("refuses to import when the operator has paused the companion", async () => {
    const { p, c } = make();
    try {
      await c.action("pause", { paused: true });
      await assert.rejects(() => c.action("import", { bundle: real, useGoal: false }), /Resume before importing evidence/);
      assert.equal(p.store.latestObservations().length, 0);
    } finally { p.store.close(); }
  });
});
