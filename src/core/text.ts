export function normalizeSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{8,}/gi, "#")
    .replace(/\b[0-9a-f]{12,}\b/gi, "#")
    .replace(/\/[\w./-]+/g, "/#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const part of text.toLowerCase().split(/[^a-z0-9_.:+-]+/)) {
    if (part.length > 2) out.add(part);
  }
  return out;
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

export function excerpt(text: string, max = 180): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function readString(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === "string" ? value : null;
}
