import type { GateDecision, GateFactors, Goal, Observation, OpenQuestion, Preferences } from "../domain.js";
import { clamp01, tokens } from "./text.js";
import { isUnsetGoal } from "./goal.js";
import { isRoutineSuccess } from "./routine.js";

export type GateInput = {
  confidence: number;
  relevance: number;
  novelty: number;
  preference: number;
  threshold: number;
  onRequest: boolean;
  paused: boolean;
  goalNeedsCorrection: boolean;
  routineSuccess: boolean;
  briefing: boolean;
  sessionMode: "follow" | "prepare" | "none";
  sessionPaused: boolean;
  returnToTask: boolean;
  naturalPause: boolean;
  sameGroupQuietUpdate: boolean;
  collectingDecision: boolean;
};

/**
 * Explicit explain requests always render the schema. Proactive follow and
 * prepare stay silent unless the product of the five factors clears the
 * threshold. Routine success is a hard suppress on that proactive path.
 */
export function decideGate(input: GateInput): GateDecision {
  const factors: GateFactors = {
    confidence: clamp01(input.confidence),
    relevance: clamp01(input.relevance),
    novelty: clamp01(input.novelty),
    timing: 1,
    preference: clamp01(input.preference),
  };

  const product = () =>
    factors.confidence * factors.relevance * factors.novelty * factors.timing * factors.preference;

  if (input.paused) {
    factors.timing = 0;
    return quiet(factors, "companion is paused");
  }

  if (input.goalNeedsCorrection) {
    factors.timing = 0;
    return quiet(factors, "goal needs correction");
  }

  if (input.routineSuccess && !input.briefing) {
    factors.timing = 0;
    factors.novelty = 0;
    return quiet(factors, "routine success");
  }

  // An explicit explain request always renders the schema for non-routine
  // evidence. Routine success above is a hard suppress: nothing to say.
  if (input.onRequest) {
    return {
      score: product(),
      factors,
      suppressInterrupt: false,
      updateLive: true,
      reason: "explicit explain request",
    };
  }

  if (input.preference === 0) {
    return quiet(factors, "already known");
  }

  if (input.sessionMode === "none") {
    factors.timing = 0;
    return quiet(factors, "quiet while idle");
  }

  if (input.sessionPaused && !input.returnToTask && !input.briefing) {
    factors.timing = 0;
    return quiet(factors, "follow session is paused");
  }

  if (input.sessionMode === "prepare" && !input.briefing) {
    factors.timing = 0;
    return {
      score: 0,
      factors,
      suppressInterrupt: true,
      updateLive: false,
      reason: input.collectingDecision ? "prepare is collecting" : "prepare is waiting for a pause",
    };
  }

  if (input.sameGroupQuietUpdate) {
    factors.timing = 0.15;
    factors.novelty = Math.min(factors.novelty, 0.2);
    return {
      score: product(),
      factors,
      suppressInterrupt: true,
      updateLive: true,
      reason: "same situation already on the card",
    };
  }

  const score = product();
  if (score < input.threshold) {
    return {
      score,
      factors,
      suppressInterrupt: true,
      updateLive: false,
      reason: `below threshold (${score.toFixed(3)} < ${input.threshold})`,
    };
  }

  return {
    score,
    factors,
    suppressInterrupt: false,
    updateLive: true,
    reason: input.briefing ? "decision brief at a pause" : "gate passed",
  };
}

function quiet(factors: GateFactors, reason: string): GateDecision {
  return {
    score: 0,
    factors,
    suppressInterrupt: true,
    updateLive: false,
    reason,
  };
}

export function scoreRelevance(
  goal: Goal,
  observations: Observation[],
  questions: OpenQuestion[],
  briefing: boolean,
): number {
  if (isUnsetGoal(goal)) return briefing ? 0.4 : 0.1;
  const goalTokens = tokens(goal.hypothesis);
  if (goalTokens.size === 0) return 0.1;
  let best = 0;
  const texts = [
    ...observations.map((obs) => `${obs.summary} ${JSON.stringify(obs.payload)}`),
    ...questions.map((question) => question.text),
  ];
  for (const text of texts) {
    const shared = [...goalTokens].filter((token) => tokens(text).has(token));
    if (shared.length === 0) best = Math.max(best, 0.12);
    else if (shared.length === 1) best = Math.max(best, 0.62);
    else best = Math.max(best, Math.min(1, 0.55 + shared.length * 0.15));
  }
  if (briefing) best = Math.max(best, 0.7);
  return best;
}

export function scoreNovelty(signatures: string[], knownActive: boolean, addsNewMember: boolean): number {
  if (signatures.length === 0) return 0;
  if (!knownActive) return 1;
  if (addsNewMember) return 0.85;
  return 0.05;
}

export function scorePreference(prefs: Preferences, topic: string, signatures: string[]): number {
  if (signatures.some((signature) => prefs.knownSignatures.includes(signature))) return 0;
  const weight = prefs.topicWeights[topic] ?? 1;
  return clamp01(0.75 * weight);
}

export function routineFrom(observations: Observation[]): boolean {
  return isRoutineSuccess(observations);
}
