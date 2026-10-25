import type { Observation } from "../domain.js";

export function groupKeyFor(observations: Observation[]): string {
  if (observations.length === 0) return "none";
  const unique = [...new Set(observations.map((obs) => obs.signature))].sort();
  if (unique.length === 1) return unique[0] ?? "none";
  return unique.join("+");
}

export function sharesSignature(observations: Observation[]): boolean {
  if (observations.length < 2) return false;
  const first = observations[0]?.signature;
  return observations.every((obs) => obs.signature === first);
}
