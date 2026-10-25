import { createHash } from "node:crypto";
import type { Observation } from "./domain.js";

export class InputError extends Error {}
export function record(value: unknown, label = "Input"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw new InputError(`${label} must be ${required ? "non-empty " : ""}text, up to ${max} characters.`);
  return value.trim();
}
function identifier(value: unknown, label: string): string {
  const id = text(value, label, 128, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new InputError(`${label} is not a valid identifier.`);
  return id;
}
function lines(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new InputError(`${label} must be a list of at most 20 lines.`);
  return value.map(item => text(item, label, 1200, true));
}
function source(value: unknown): string {
  const raw = text(value, "Source URL", 1200);
  if (!raw) return "";
  let url: URL;
  try { url = new URL(raw); } catch { throw new InputError("Source URL must be HTTP or HTTPS."); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new InputError("Source URL must be HTTP or HTTPS without credentials.");
  return raw;
}
export type BundlePreview = { recordingId: string; title: string; goal: string; sourceUrl: string; count: number; observations: Observation[] };

/** Validate the supported projection, then discard all other producer fields. */
export function parseIntentBundle(value: unknown, now: string): BundlePreview {
  const bundle = record(value, "Bundle");
  if (bundle.schema !== "https://github.com/hamanakam1/panther-intent-capture#intent-bundle" || bundle.schema_version !== "1.2" || bundle.producer !== "panther-intent-capture") throw new InputError("Choose a Panther Intent Capture 1.2 JSON export.");
  const authority = record(bundle.authority, "Authority");
  if (authority.export_only !== true || authority.requires_review !== true || authority.execution_authorized !== false) throw new InputError("Bundle must be review-only with no execution authority.");
  const recording = record(bundle.recording, "Recording");
  const recordingId = identifier(recording.id, "Recording ID");
  const title = text(recording.title, "Recording title", 300);
  const goal = text(recording.stated_goal, "Captured goal", 2000);
  const sourceUrl = source(recording.source_url);
  if (!Array.isArray(bundle.tickets) || bundle.tickets.length > 25) throw new InputError("Import supports up to 25 proposals per bundle.");
  const ids = new Set<string>();
  const observations = bundle.tickets.map((item) => {
    const ticket = record(item, "Proposal");
    const id = identifier(ticket.id, "Proposal ID");
    if (ids.has(id)) throw new InputError("Proposal IDs must be unique in a bundle.");
    ids.add(id);
    if (ticket.status !== "draft" || ticket.requires_review !== true || ticket.execution_authorized !== false) throw new InputError("Every proposal must remain a draft requiring review with no execution authority.");
    const label = text(ticket.title, "Proposal title", 1000, true);
    const evidence = text(ticket.evidence, "Observed evidence", 6000);
    const hypothesis = text(ticket.hypothesis, "Unverified hypothesis", 2000);
    const steps = lines(ticket.steps_to_reproduce, "Observed steps");
    const checks = lines(ticket.suggested_verification_steps, "Suggested checks");
    const acceptance = lines(ticket.acceptance_criteria, "Acceptance criteria");
    const questions = lines(ticket.questions, "Questions");
    const payload = { recordingId, proposalId: id, title: label, statedGoal: goal, observedEvidence: evidence, observedSteps: steps, hypothesis, suggestedChecks: checks, acceptanceCriteria: acceptance, questions, requiresReview: true, executionAuthorized: false };
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
    return { id: `ic-${recordingId}-${id}-${digest}`, providerId: "panther-ic", capturedAt: now, label, locator: sourceUrl || `capture:${recordingId}`, summary: evidence || `Review proposal: ${label}`, payload, signature: `panther-ic:${recordingId}:${id}:${digest}` };
  });
  return { recordingId, title, goal, sourceUrl, count: observations.length, observations };
}
