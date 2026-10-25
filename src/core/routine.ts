import type { Observation } from "../domain.js";
import { asRecord } from "./text.js";

export function isRoutineSuccess(observations: Observation[]): boolean {
  if (observations.length === 0) return false;
  return observations.every((obs) => {
    if (obs.providerId !== "terminal") return false;
    const payload = asRecord(obs.payload);
    if (!payload) return false;
    if (payload.exitCode !== 0) return false;
    if (payload.truncated === true) return false;
    if (typeof payload.stderr === "string" && payload.stderr.trim()) return false;
    const stdout = typeof payload.stdout === "string" ? payload.stdout.toLowerCase() : "";
    if (/\b(error|fail|exception|fatal)\b/.test(stdout)) return false;
    return true;
  });
}

export function isNaturalPause(obs: Observation): boolean {
  const payload = asRecord(obs.payload);
  if (!payload) return false;
  return payload.naturalPause === true || payload.event === "pause";
}

export function isReturnEvent(obs: Observation): boolean {
  const payload = asRecord(obs.payload);
  if (!payload) return false;
  return payload.event === "return";
}

export function terminalCommand(obs: Observation): string | null {
  if (obs.providerId !== "terminal") return null;
  const payload = asRecord(obs.payload);
  const command = payload?.command;
  return typeof command === "string" ? command : null;
}
