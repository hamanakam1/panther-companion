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

  /** One-shot "Explain this": capture now, run the gate, render the schema. */
  async explain(options: IngestOptions = {}): Promise<IngestResult> {
    return this.ingest({ ...options, onRequest: true });
  }

  /** Bounded "Follow this task" session. Returns the session + last card. */
  async follow(options: IngestOptions = {}): Promise<{ session: Session; result: IngestResult }> {
    const now = options.now ?? nowIso();
    const session: Session = {
      id: `session-${Date.now()}`,
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
      id: `session-${Date.now()}`,
      mode: "prepare",
      goalId: this.store.getGoal(now).id,
      startedAt: now,
      endsAt: addMinutes(now, this.followMinutes),
      status: "active",
    };
    this.store.saveSession(session);
    return this.ingest({ ...options, now, sessionMode: "prepare", briefing: true, collectingDecision: true });
  }

  /** Set or clear the current goal hypothesis. */
  setGoal(hypothesis: string | null, now: string = nowIso()): Goal {
    const current = this.store.getGoal(now);
    const goal = hypothesis
      ? { ...current, hypothesis, confidence: 0.5, correctedByUser: true, needsCorrection: false, updatedAt: now }
      : unsetGoal(now);
    this.store.saveGoal(goal);
    return goal;
  }

  /** Record feedback from the surface taxonomy. */
  recordFeedback(kind: "AlreadyKnow" | "WrongTask" | "UsefulMoreLikeThis" | "ExplainMechanism" | "UsefulButLater", insightId: string | null, topic: string | null, now: string = nowIso()): void {
    const goal = this.store.getGoal(now);
    if (kind === "WrongTask") {
      this.store.saveGoal({ ...goal, ...{ confidence: Math.min(goal.confidence, 0.25), needsCorrection: true, updatedAt: now } } as Goal);
    }
    this.store.insertFeedback(kind, insightId, topic, now);
  }

  /** Public: capture from pluggable adapters, then run the core gate → explain path. */
  async ingest(options: IngestOptions): Promise<IngestResult> {
    const now = options.now ?? nowIso();
    let allObservations: Observation[] = [];
    for (const adapter of this.adapters) {
      try {
        const captured = await adapter.capture({ now, onRequest: options.onRequest, naturalPause: options.naturalPause });
        allObservations = allObservations.concat(captured);
      } catch {
        // One adapter failing must not silence the others.
      }
    }
    return this.ingestCore(this.dedupe(allObservations), options);
  }

  /** Public: ingest a given set of observations directly (used by eval and MCP feed). */
  async ingestObservations(observations: Observation[], options: IngestOptions): Promise<IngestResult> {
    return this.ingestCore(this.dedupe(observations), options);
  }

  /** Core capture → gate → explain path shared by all modes. */
  private async ingestCore(observations: Observation[], options: IngestOptions): Promise<IngestResult> {
    const now = options.now ?? nowIso();
    const goal = this.store.getGoal(now);
    const prefs = this.store.getPreferences();
    const questions = this.store.listOpenQuestions();
    const summaries = this.store.recentSummaries(5);
    const paused = prefs.paused;

    for (const obs of observations) this.store.insertObservation(obs);

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
      id: `gate-${Date.now()}`,
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
      return { raised: false, live: null, decision, insight: null, storedObservationIds: observations.map((o) => o.id) };
    }

    // Build (or refresh) the insight + explanation.
    const groupKey = groupKeyFor(observations);
    const existing = this.store.findActiveBySignature(signatures, now);
    const explanationId = existing?.explanationId;
    const explanation: Explanation = {
      id: explanationId ?? `exp-${Date.now()}`,
      whatItMeans: output.whatItMeans,
      whyItMattersHere: output.whyItMattersHere,
      nextCheck: output.nextCheck,
      evidence: observations.map((obs) => ({ observationId: obs.id, providerId: obs.providerId, label: obs.label, locator: obs.locator })),
      observed: output.observed,
      inferred: output.inferred,
      unknown: output.unknown,
      confidence: output.confidence,
      topic: output.topic,
      createdAt: now,
    };
    this.store.saveExplanation(explanation);

    const insight: Insight = {
      id: existing?.id ?? `insight-${Date.now()}`,
      groupKey,
      status: "transient",
      explanationId: explanation.id,
      observationIds: observations.map((o) => o.id),
      expiresAt: addMinutes(now, this.insightTtlMinutes),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.store.insertInsight(insight, signatures);

    const live: SurfaceCard | null = decision.updateLive
      ? {
          insightId: insight.id,
          producedBy: options.onRequest
            ? "explain"
            : options.sessionMode === "follow" || options.sessionMode === "prepare"
              ? options.sessionMode
              : "explain",
          reasoning: decision.reason,
          using: this.sources(),
          goal,
          explanation,
        }
      : null;

    this.store.expireDue(now);
    return { raised: Boolean(live), live, decision, insight, storedObservationIds: observations.map((o) => o.id) };
  }

  /** Snapshot everything for export / delete / inspect. */
  exportAll() {
    return this.store.exportAll();
  }

  /** Delete all local state (user-controlled). */
  deleteAll(now: string = nowIso()): void {
    this.store.deleteAll(now);
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
    return out.slice(0, DEFAULT_LIMIT);
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
