import { randomUUID } from "node:crypto";
import { UNSET_GOAL_TEXT, type Goal } from "../domain.js";

export function unsetGoal(now: string): Goal {
  return {
    id: randomUUID(),
    hypothesis: UNSET_GOAL_TEXT,
    confidence: 0.15,
    correctedByUser: false,
    needsCorrection: false,
    updatedAt: now,
  };
}

export function isUnsetGoal(goal: Goal): boolean {
  return goal.hypothesis.trim() === "" || goal.hypothesis.trim() === UNSET_GOAL_TEXT;
}

export function correctGoal(goal: Goal, hypothesis: string, now: string): Goal {
  const text = hypothesis.trim();
  if (!text || text === UNSET_GOAL_TEXT) return unsetGoal(now);
  return {
    id: goal.id,
    hypothesis: text,
    confidence: 0.9,
    correctedByUser: true,
    needsCorrection: false,
    updatedAt: now,
  };
}

export function applyWrongTask(goal: Goal, now: string): Goal {
  return {
    ...goal,
    confidence: Math.min(goal.confidence, 0.25),
    needsCorrection: true,
    updatedAt: now,
  };
}
