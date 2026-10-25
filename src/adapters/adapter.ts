import { randomUUID } from "node:crypto";
import type { Observation } from "../domain.js";
import { normalizeSignature } from "../core/text.js";

export interface IngestOptions {
  /** The user explicitly asked ("Explain this"). Always renders the schema. */
  onRequest?: boolean;
  /** Override the capture clock for tests. */
  now?: string;
  /** A natural pause in the work (good time for a prepare brief). */
  naturalPause?: boolean;
}

/**
 * An observation provider is pluggable. The reasoning core never hard-codes a
 * capture tool — it only consumes `Observation` records from adapters it does
 * not own.
 */
export abstract class Adapter {
  abstract readonly id: string;
  abstract capture(options?: IngestOptions): Promise<Observation[]>;
  supports(): boolean {
    return true;
  }

  protected makeObservation({
    label,
    locator,
    summary,
    payload,
    signatureKey,
  }: {
    label: string;
    locator: string;
    summary: string;
    payload: unknown;
    signatureKey: string;
  }): Observation {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      providerId: this.id,
      capturedAt: now,
      label,
      locator,
      summary,
      payload,
      signature: normalizeSignature(`${this.id}:${signatureKey}`),
    };
  }

  /** Log-friendly summary of what this adapter can capture right now. */
  status(): string {
    return `${this.id}: ${this.supports() ? "configured" : "not configured"}`;
  }
}

export function observationSummary(payload: unknown, fallback: string): string {
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
  if (record) {
    for (const key of ["message", "summary", "command", "title", "text"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return fallback;
}
