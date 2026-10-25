import { readFileSync } from "node:fs";
import type { Depth } from "./domain.js";

export type ReasoningProviderName = "local" | "ollama";

export type GateConfig = {
  threshold: number;
  followMinutes: number;
  insightTtlMinutes: number;
  reasoning: {
    provider: ReasoningProviderName;
    ollamaUrl: string;
    model: string;
    fallbackToLocal: boolean;
  };
};

export const DEFAULT_CONFIG: GateConfig = {
  threshold: 0.25,
  followMinutes: 25,
  insightTtlMinutes: 45,
  reasoning: {
    provider: "local",
    ollamaUrl: "http://127.0.0.1:11434/api/generate",
    model: "qwen3.8:latest",
    fallbackToLocal: true,
  },
};

export function loadConfig(path: string | null): GateConfig {
  if (!path) return structuredClone(DEFAULT_CONFIG);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
  return normalizeConfig(parsed);
}

export function normalizeConfig(value: unknown): GateConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  if (!value || typeof value !== "object") return base;
  const raw = value as Record<string, unknown>;
  if (typeof raw.threshold === "number" && raw.threshold > 0 && raw.threshold < 1) {
    base.threshold = raw.threshold;
  }
  if (typeof raw.followMinutes === "number" && raw.followMinutes >= 5 && raw.followMinutes <= 180) {
    base.followMinutes = raw.followMinutes;
  }
  if (typeof raw.insightTtlMinutes === "number" && raw.insightTtlMinutes >= 5 && raw.insightTtlMinutes <= 24 * 60) {
    base.insightTtlMinutes = raw.insightTtlMinutes;
  }
  if (raw.reasoning && typeof raw.reasoning === "object") {
    const reasoning = raw.reasoning as Record<string, unknown>;
    if (reasoning.provider === "local" || reasoning.provider === "ollama") {
      base.reasoning.provider = reasoning.provider;
    }
    if (typeof reasoning.ollamaUrl === "string" && reasoning.ollamaUrl.startsWith("http")) {
      base.reasoning.ollamaUrl = reasoning.ollamaUrl;
    }
    if (typeof reasoning.model === "string" && reasoning.model.trim()) {
      base.reasoning.model = reasoning.model.trim();
    }
    if (typeof reasoning.fallbackToLocal === "boolean") {
      base.reasoning.fallbackToLocal = reasoning.fallbackToLocal;
    }
  }
  return base;
}

export function defaultPreferences(): {
  paused: boolean;
  depthByTopic: Record<string, Depth>;
  knownSignatures: string[];
  topicWeights: Record<string, number>;
} {
  return { paused: false, depthByTopic: {}, knownSignatures: [], topicWeights: {} };
}
