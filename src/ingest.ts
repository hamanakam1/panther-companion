import type {
  Explanation,
  GateDecision,
  Goal,
  IngestOptions,
  IngestResult,
  Insight,
  Observation,
  Preferences,
  Session,
  SurfaceCard,
} from "./domain.js";
import { Store } from "./state/store.js";
import { decideGate, scoreNovelty, scorePreference, scoreRelevance, routineFrom } from "./core/gating.js";
import { unsetGoal } from "./core/goal.js";
import { groupKeyFor } from "./core/insights.js";
import { addMinutes } from "./core/text.js";
import { Reasoner } from "./core/reasoner.js";
import { Adapter } from "./adapters/adapter.js";
import { randomUUID } from "node:crypto";
import { questionTextFor } from "./core/reasoner.js";

const DEFAULT_LIMIT = 25;

export function nowIso(): string {
  return new Date().toISOString();
}

export type PantherDeps = {
  store: Store;
  adapters: Adapter[];
  reasoner: Reasoner;
  threshold: number;
  followMinutes: number;
  insightTtlMinutes: number;
};

/**
 * Panther core: capture observations from pluggable adapters, gate them
 * against the current goal, and (only when the gate passes) render the fixed
 * schema explanation as the live surface card. Nothing is shown unless it is
 * likely to save attention.
 */
export class Panther {
  readonly store: Store;
  readonly adapters: Adapter[];
  private readonly reasoner: Reasoner;
  private readonly threshold: number;
  private readonly followMinutes: number;
  private readonly insightTtlMinutes: number;

  constructor(deps: PantherDeps) {
    this.store = deps.store;
    this.adapters = deps.adapters;
    this.reasoner = deps.reasoner;
    this.threshold = deps.threshold;
    this.followMinutes = deps.followMinutes;
    this.insightTtlMinutes = deps.insightTtlMinutes;
  }

  /** All capture sources the host knows about, for the surface "Using: ..." line. */
  sources(): string[] {
    return this.adapters.map((adapter) => adapter.status());
  }

  sourceReadiness() {
    return this.adapters.map((adapter) => adapter.readiness());
  }

  /** Cached configured candidates, not a claim that their next read will succeed. */
  observableSources(): string[] {
    return this.adapters.filter((adapter) => adapter.supports()).map((adapter) => adapter.id);
  }

  /** Called only for an explicit read action, never status or Pause/Resume. */
  refreshSourceAvailability(): void {
    for (const adapter of this.adapters) adapter.refreshAvailability();
  }

  /** One-shot "Explain this": capture now, run the gate, render the schema. */
  async explain(options: IngestOptions = {}): Promise<IngestResult> {
    return this.ingest({ ...options, onRequest: true });
  }

  /** Bounded "Follow this task" session. Returns the session + last card. */
  async follow(options: IngestOptions = {}): Promise<{ session: Session; result: IngestResult }> {
    const now = options.now ?? nowIso();
    const session: Session = {
      id: `session-${randomUUID()}`,
      mode: "follow",
      goalId: this.store.getGoal(now).id,
      startedAt: now,
      endsAt: addMinutes(now, this.followMinutes),
      status: "active",
    };
    this.store.saveSession(session);
    const result = await this.ingest({ ...options, now, sessionMode: "follow" });
    return { session, result };
  }

  /** "Prepare the next decision": quiet collection, brief at a natural pause. */
  async prepare(options: IngestOptions = {}): Promise<IngestResult> {
    const now = options.now ?? nowIso();
    const session: Session = {
      id: `session-${randomUUID()}`,
      mode: "prepare",
      goalId: this.store.getGoal(now).id,
      startedAt: now,
      endsAt: addMinutes(now, this.followMinutes),
      status: "active",
    };
    this.store.saveSession(session);
    try { return await this.ingest({ ...options, now, onRequest: true, sessionMode: "prepare", briefing: true, collectingDecision: true }); }
    finally { this.store.transaction(() => { if (this.store.getSession()?.id === session.id) this.store.saveSession({ ...session, status: "ended" }); }); }
  }

  /** Set or clear the current goal hypothesis. */
  setGoal(hypothesis: string | null, now: string = nowIso()): Goal {
    return this.store.transaction(() => {
      this.invalidate();
      this.store.setLive(null);
      this.store.saveSession(null);
      this.store.briefQuestions(now);
      const current = this.store.getGoal(now);
      const goal = hypothesis
        ? { ...current, id: randomUUID(), hypothesis: hypothesis.trim(), confidence: 0.9, correctedByUser: true, needsCorrection: false, updatedAt: now }
        : unsetGoal(now);
      this.store.saveGoal(goal);
      return goal;
    });
  }

  /** Record feedback from the surface taxonomy. */
  recordFeedback(kind: "AlreadyKnow" | "WrongTask" | "UsefulMoreLikeThis" | "ExplainMechanism" | "UsefulButLater", insightId: string | null, topic: string | null, now: string = nowIso()): void {
    this.store.transaction(() => {
      const goal = this.store.getGoal(now);
      if (kind === "WrongTask") {
        this.invalidate();
        this.store.setLive(null);
        this.store.saveGoal({ ...goal, ...{ confidence: Math.min(goal.confidence, 0.25), needsCorrection: true, updatedAt: now } } as Goal);
      }
      const prefs = this.store.getPreferences();
      if (kind === "AlreadyKnow" && insightId) prefs.knownSignatures.push(...this.store.signaturesFor(insightId));
      if (kind === "ExplainMechanism" && topic) prefs.depthByTopic[topic] = "mechanism";
      if (kind === "UsefulMoreLikeThis" && topic) prefs.topicWeights[topic] = Math.min(1.3, (prefs.topicWeights[topic] ?? 1) + 0.1);
      if (kind === "UsefulButLater" && topic) prefs.topicWeights[topic] = 0.5;
      this.store.savePreferences(prefs);
      this.store.insertFeedback(kind, insightId, topic, now);
    });
  }

  /** Public: capture from pluggable adapters, then run the core gate → explain path. */
  async ingest(options: IngestOptions): Promise<IngestResult> {
    if (this.store.getPreferences().paused) return this.quiet("companion is paused");
    const now = options.now ?? nowIso();
    const generation = this.store.stateRevision();
    let allObservations: Observation[] = [];
    for (const adapter of this.adapters) {
      try {
        const captured = await adapter.capture({ now, onRequest: options.onRequest, naturalPause: options.naturalPause });
        allObservations = allObservations.concat(captured);
      } catch {
        // One adapter failing must not silence the others.
      }
    }
    if (generation !== this.store.stateRevision()) return this.quiet("request cancelled by a state change");
    if (allObservations.length === 0 && options.onRequest) allObservations = this.store.latestObservations(DEFAULT_LIMIT);
    if (allObservations.length === 0 && !options.onRequest) return this.quiet("waiting for new evidence");
    return this.ingestCore(this.dedupe(allObservations), options);
  }

  /** Public: ingest a given set of observations directly (used by eval and MCP feed). */
  async ingestObservations(observations: Observation[], options: IngestOptions): Promise<IngestResult> {
    return this.ingestCore(this.dedupe(observations), options);
  }

  /** Core capture → gate → explain path shared by all modes. */
  private async ingestCore(observations: Observation[], options: IngestOptions): Promise<IngestResult> {
    if (this.store.getPreferences().paused) return this.quiet("companion is paused");
    const now = options.now ?? nowIso();
    const { goal, revision: generation } = this.store.goalState(now);
    const prefs = this.store.getPreferences();
    const questions = this.store.listOpenQuestions();
    const summaries = this.store.recentSummaries(5);
    const paused = prefs.paused;

    const retained = this.store.withStateRevision(generation, () => {
      for (const obs of observations) this.store.insertObservation(obs, goal.id);
      return true;
    });
    if (!retained) return this.quiet("request cancelled by a state change");
    const storedObservationIds = observations.map(obs => obs.id);
    // Retain every bounded source event. Reason over the most recent slice.
    observations = observations.slice(-DEFAULT_LIMIT);

    // Reason over the captured evidence (local first, ollama optional).
    const output = await this.reasoner.reason({
      goal,
      observations,
      openQuestions: questions,
      recentSummaries: summaries,
      depthByTopic: prefs.depthByTopic,
      now,
      brief: options.sessionMode === "prepare",
      returnToTask: options.sessionMode === "follow",
    });
    if (generation !== this.store.stateRevision()) return this.quiet("request cancelled by a state change");
    return this.store.withStateRevision<IngestResult>(generation, () => {
      const allowedEvidence = new Set([...observations.map(obs => obs.id), ...questions.flatMap(question => question.observationIds)]);
      output.usedObservationIds = output.usedObservationIds.filter(id => allowedEvidence.has(id));

      const signatures = observations.map((obs) => obs.signature);
      const knownActive = this.knownSignaturesActive(prefs, signatures);
      const addsNewMember = this.addsNewMember(observations);

      const relevance = scoreRelevance(goal, observations, questions, options.sessionMode === "prepare");
      const novelty = scoreNovelty(signatures, knownActive, addsNewMember);
      const preference = scorePreference(prefs, output.topic, signatures);
      const routineSuccess = output.routineSuccess || routineFrom(observations);

      const session = this.store.getSession();
      const decision: GateDecision = decideGate({
        confidence: output.confidence,
        relevance,
        novelty,
        preference,
        threshold: this.threshold,
        onRequest: !!options.onRequest,
        paused,
        goalNeedsCorrection: goal.needsCorrection,
        routineSuccess,
        briefing: options.sessionMode === "prepare",
        sessionMode: session?.mode ?? "none",
        sessionPaused: session?.status === "paused",
        returnToTask: options.returnToTask ?? false,
        naturalPause: !!options.naturalPause,
        sameGroupQuietUpdate: this.sameGroupQuietUpdate(signatures, now),
        collectingDecision: !!options.collectingDecision,
      });

      this.store.insertGateLog({
        id: `gate-${randomUUID()}`,
        createdAt: now,
        mode: options.sessionMode ?? "explain",
        score: decision.score,
        factors: decision.factors,
        suppress: decision.suppressInterrupt,
        reason: decision.reason,
        observationIds: observations.map((o) => o.id),
      });

      // Hard suppress: nothing to show, insight expires.
      if (decision.suppressInterrupt && !decision.updateLive) {
        this.store.expireDue(now);
        if (routineSuccess) this.store.setLive(null);
        return { raised: false, live: null, decision, insight: null, storedObservationIds };
      }

      // Build (or refresh) the insight + explanation.
      const groupKey = groupKeyFor(observations);
      const existing = this.store.findActiveBySignature(signatures, now);
      const explanationId = existing?.explanationId;
      const explanation: Explanation = {
        id: explanationId ?? `exp-${randomUUID()}`,
        whatItMeans: output.whatItMeans,
        whyItMattersHere: output.whyItMattersHere,
        nextCheck: output.nextCheck,
        evidence: this.store.getObservations(output.usedObservationIds).map((obs) => ({ observationId: obs.id, providerId: obs.providerId, label: obs.label, locator: obs.locator })),
        observed: output.observed,
        inferred: output.inferred,
        unknown: output.unknown,
        confidence: output.confidence,
        topic: output.topic,
        createdAt: now,
      };
      this.store.saveExplanation(explanation);

      const insight: Insight = {
        id: existing?.id ?? `insight-${randomUUID()}`,
        groupKey,
        status: "transient",
        explanationId: explanation.id,
        observationIds: observations.map((o) => o.id),
        expiresAt: addMinutes(now, this.insightTtlMinutes),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (existing) this.store.updateInsight(insight, signatures);
      else this.store.insertInsight(insight, signatures);
      const question = questionTextFor(output);
      if (question && output.topic !== "decision-brief") this.store.insertQuestion({ id: randomUUID(), text: question, observationIds: output.usedObservationIds, status: "open", createdAt: now, updatedAt: now });

      const live: SurfaceCard | null = decision.updateLive
        ? {
            insightId: insight.id,
            producedBy: options.sessionMode === "prepare" ? "prepare" : options.onRequest
              ? "explain"
              : options.sessionMode === "follow"
                ? options.sessionMode
                : "explain",
            reasoning: decision.reason,
            using: this.sources(),
            goal,
            explanation,
          }
        : null;

      this.store.expireDue(now);
      if (live) this.store.setLive(live);
      return { raised: Boolean(live), live, decision, insight, storedObservationIds };
    }) ?? this.quiet("request cancelled by a state change");
  }

  /** Snapshot everything for export / delete / inspect. */
  exportAll() {
    return this.store.exportAll();
  }

  /** Delete all local state (user-controlled). */
  deleteAll(now: string = nowIso()): void {
    this.invalidate();
    this.store.deleteAll(now);
  }

  /** Fence delayed reasoning when the operator pauses, changes goal, or deletes. */
  invalidate(): void { this.store.invalidate(); }

  private quiet(reason: string): IngestResult {
    return { raised: false, live: null, insight: null, storedObservationIds: [], decision: { score: 0, factors: { confidence: 0, relevance: 0, novelty: 0, timing: 0, preference: 0 }, suppressInterrupt: true, updateLive: false, reason } };
  }

  // ---------- private ----------

  private dedupe(observations: Observation[]): Observation[] {
    // Dedupe by id (same captured event twice), not by signature: two distinct
    // agents reporting the same failure are distinct observations and both
    // matter for the multi-agent reasoning path.
    const seen = new Set<string>();
    const out: Observation[] = [];
    for (const obs of observations) {
      if (seen.has(obs.id)) continue;
      seen.add(obs.id);
      out.push(obs);
    }
    return out;
  }

  private knownSignaturesActive(prefs: Preferences, signatures: string[]): boolean {
    return signatures.some((s) => prefs.knownSignatures.includes(s));
  }

  private addsNewMember(observations: Observation[]): boolean {
    // One or more observations means there is something new to consider.
    return observations.length > 0;
  }

  private sameGroupQuietUpdate(signatures: string[], now: string): boolean {
    const existing = this.store.findActiveBySignature(signatures, now);
    return existing != null;
  }
}
