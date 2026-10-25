export const FEEDBACK_KINDS = [
  "AlreadyKnow",
  "WrongTask",
  "UsefulMoreLikeThis",
  "ExplainMechanism",
  "UsefulButLater",
] as const;

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export type SessionMode = "follow" | "prepare";

export type Depth = "brief" | "mechanism";

export type Goal = {
  id: string;
  hypothesis: string;
  confidence: number;
  correctedByUser: boolean;
  needsCorrection: boolean;
  updatedAt: string;
};

export type Observation = {
  id: string;
  providerId: string;
  capturedAt: string;
  label: string;
  locator: string;
  summary: string;
  payload: unknown;
  signature: string;
};

export type EvidenceRef = {
  observationId: string;
  providerId: string;
  label: string;
  locator: string;
};

export type Explanation = {
  id: string;
  whatItMeans: string;
  whyItMattersHere: string;
  nextCheck: string;
  evidence: EvidenceRef[];
  observed: string[];
  inferred: string[];
  unknown: string[];
  confidence: number;
  topic: string;
  createdAt: string;
};

export type InsightStatus = "transient" | "expired" | "promoted";

export type Insight = {
  id: string;
  groupKey: string;
  status: InsightStatus;
  explanationId: string | null;
  observationIds: string[];
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export type OpenQuestion = {
  id: string;
  text: string;
  observationIds: string[];
  status: "open" | "briefed";
  createdAt: string;
  updatedAt: string;
};

export type Preferences = {
  paused: boolean;
  depthByTopic: Record<string, Depth>;
  knownSignatures: string[];
  topicWeights: Record<string, number>;
};

export type Session = {
  id: string;
  mode: SessionMode;
  goalId: string;
  startedAt: string;
  endsAt: string;
  status: "active" | "paused" | "ended";
};

export type SurfaceCard = {
  insightId: string;
  producedBy: "explain" | SessionMode;
  reasoning: string;
  using: string[];
  goal: Goal;
  explanation: Explanation;
};

export type GateFactors = {
  confidence: number;
  relevance: number;
  novelty: number;
  timing: number;
  preference: number;
};

export type GateDecision = {
  score: number;
  factors: GateFactors;
  suppressInterrupt: boolean;
  updateLive: boolean;
  reason: string;
};

export type GateLog = {
  id: string;
  createdAt: string;
  mode: string;
  score: number;
  factors: GateFactors;
  suppress: boolean;
  reason: string;
  observationIds: string[];
};

export type ReasonerInput = {
  goal: Goal;
  observations: Observation[];
  openQuestions: OpenQuestion[];
  recentSummaries: string[];
  depthByTopic: Record<string, Depth>;
  now: string;
  brief: boolean;
  returnToTask: boolean;
};

export type ReasonerOutput = {
  whatItMeans: string;
  whyItMattersHere: string;
  nextCheck: string;
  usedObservationIds: string[];
  observed: string[];
  inferred: string[];
  unknown: string[];
  confidence: number;
  topic: string;
  decisionNeeded: boolean;
  routineSuccess: boolean;
};

export type IngestOptions = {
  onRequest?: boolean;
  now?: string;
  naturalPause?: boolean;
  sessionMode?: "follow" | "prepare" | "none";
  returnToTask?: boolean;
  briefing?: boolean;
  collectingDecision?: boolean;
};

export type IngestResult = {
  raised: boolean;
  live: SurfaceCard | null;
  decision: GateDecision;
  insight: Insight | null;
  storedObservationIds: string[];
};

export const UNSET_GOAL_TEXT = "Goal not set";
