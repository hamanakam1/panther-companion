import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Store } from "../src/state/store.js";
import type { Observation, InsightStatus, Goal } from "../src/domain.js";

const obs = (over: Partial<Observation> = {}): Observation => ({
  id: `obs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  providerId: "terminal",
  capturedAt: "2026-10-22T12:00:00Z",
  label: "x",
  locator: "/app",
  summary: "x",
  payload: {},
  signature: "sig",
  ...over,
});

describe("store", () => {
  it("insert + get observations", () => {
    const store = Store.memory();
    const o = obs({ signature: "sig-a" });
    store.insertObservation(o);
    const got = store.getObservations([o.id]);
    assert.equal(got.length, 1);
    assert.equal(got[0].signature, "sig-a");
    assert.equal(store.getObservations([]).length, 0);
  });
  it("insight lifecycle: insert, find active by signature, expire", () => {
    const store = Store.memory();
    const now = "2026-10-22T12:00:00Z";
    const o = obs({ signature: "sig-a" });
    store.insertObservation(o);
    const insight = {
      id: "i-1",
      groupKey: "sig-a",
      status: "transient" as InsightStatus,
      explanationId: "e-1",
      observationIds: [o.id],
      expiresAt: "2026-10-22T13:00:00Z",
      createdAt: now,
      updatedAt: now,
    };
    store.insertInsight(insight, ["sig-a"]);
    const found = store.findActiveBySignature(["sig-a"], now);
    assert.ok(found);
    assert.equal(found.id, "i-1");
    store.expireInsight("i-1", now);
    assert.equal(store.getInsight("i-1")?.status, "expired");
  });
  it("expireDue expires transient insights past their TTL", () => {
    const store = Store.memory();
    const o = obs({ signature: "sig-a" });
    store.insertObservation(o);
    store.insertInsight({ id: "i-1", groupKey: "g", status: "transient", explanationId: "e", observationIds: [o.id], expiresAt: "2026-10-22T11:00:00Z", createdAt: "t", updatedAt: "t" }, ["sig-a"]);
    store.expireDue("2026-10-22T12:00:00Z");
    assert.equal(store.getInsight("i-1")?.status, "expired");
  });
  it("questions: insert open, list open, brief", () => {
    const store = Store.memory();
    store.insertQuestion({ id: "q-1", text: "Which strategy?", observationIds: [], status: "open", createdAt: "t", updatedAt: "t" });
    store.insertQuestion({ id: "q-2", text: "Other?", observationIds: [], status: "open", createdAt: "t", updatedAt: "t" });
    assert.equal(store.listOpenQuestions().length, 2);
    store.briefQuestions("now");
    assert.equal(store.listOpenQuestions().length, 0);
  });
  it("goal + preferences round trip", () => {
    const store = Store.memory();
    const now = "now";
    const g: Goal = { id: "g", hypothesis: "ship migrate", confidence: 0.9, correctedByUser: true, needsCorrection: false, updatedAt: now };
    store.saveGoal(g);
    assert.deepEqual(store.getGoal(now), g);
    const prefs = store.getPreferences();
    assert.equal(prefs.paused, false);
  });
  it("exportAll includes all tables", () => {
    const store = Store.memory();
    const exp = store.exportAll();
    assert.ok("goal" in exp && "preferences" in exp && "insights" in exp && "observations" in exp);
  });
  it("deleteAll clears state", () => {
    const store = Store.memory();
    store.insertObservation(obs());
    store.deleteAll("now");
    assert.equal(store.getObservations([]).length, 0);
    assert.equal(store.getGoal("now").hypothesis, "Goal not set");
  });
});
