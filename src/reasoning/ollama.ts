import type { ReasonerInput, ReasonerOutput } from "../domain.js";

// Node 26 ships a global fetch; declare it here so ollama works whether or
// not @types/node bundles node:fetch types.
declare const fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
import { Reasoner, buildReasoningPrompt, loadPromptTemplate, reasonLocally } from "../core/reasoner.js";
import { isLoopbackUrl } from "../config.js";
import { promptPath } from "../paths.js";

export class OllamaReasoner implements Reasoner {
  readonly id = "ollama";
  private readonly url: string;
  private readonly model: string;
  private readonly fallbackToLocal: boolean;
  private template: string | null = null;

  constructor(url: string, model: string, options: { fallbackToLocal: boolean }) {
    if (!isLoopbackUrl(url)) throw new Error("Ollama must use a local loopback URL.");
    this.url = url;
    this.model = model;
    this.fallbackToLocal = options.fallbackToLocal;
  }

  async reason(input: ReasonerInput): Promise<ReasonerOutput> {
    const prompt = this.promptTemplate(input);
    try {
      const text = await this.generate(prompt);
      const parsed = this.parseJson(text);
      if (parsed) return parsed;
    } catch {
      // ollama unreachable or bad response -> fall through
    }
    if (this.fallbackToLocal) return reasonLocally(input);
    throw new Error("ollama reasoning failed and local fallback is disabled");
  }

  private promptTemplate(input: ReasonerInput): string {
    if (!this.template) {
      try {
        this.template = loadPromptTemplate(promptPath());
      } catch {
        this.template = "";
      }
    }
    return buildReasoningPrompt(this.template, input);
  }

  private async generate(prompt: string): Promise<string> {
    const body = JSON.stringify({
      model: this.model,
      prompt,
      format: "json",
      stream: false,
      think: false,
      options: { temperature: 0.2, num_predict: 700 },
    });
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(60_000),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = await res.json();
    if (data.done !== true || typeof data.response !== "string") throw new Error("Incomplete local model response");
    return data.response;
  }

  private parseJson(text: string): ReasonerOutput | null {
    try {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start === -1 || end === -1 || end < start) return null;
      const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      return this.coerce(parsed);
    } catch {
      return null;
    }
  }

  private coerce(record: Record<string, unknown>): ReasonerOutput | null {
    if (!["whatItMeans", "whyItMattersHere", "nextCheck", "topic"].every(key => typeof record[key] === "string" && (record[key] as string).trim())) return null;
    if (typeof record.decisionNeeded !== "boolean" || typeof record.routineSuccess !== "boolean" || typeof record.confidence !== "number" || !Number.isFinite(record.confidence)) return null;
    const confidence = Number(record.confidence);
    return {
      whatItMeans: typeof record.whatItMeans === "string" ? String(record.whatItMeans) : "",
      whyItMattersHere: typeof record.whyItMattersHere === "string" ? String(record.whyItMattersHere) : "",
      nextCheck: typeof record.nextCheck === "string" ? String(record.nextCheck) : "",
      usedObservationIds: Array.isArray(record.usedObservationIds) ? record.usedObservationIds.filter((x) => typeof x === "string") : [],
      observed: Array.isArray(record.observed) ? record.observed.filter((x) => typeof x === "string") : [],
      inferred: Array.isArray(record.inferred) ? record.inferred.filter((x) => typeof x === "string") : [],
      unknown: Array.isArray(record.unknown) ? record.unknown.filter((x) => typeof x === "string") : [],
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
      topic: typeof record.topic === "string" ? String(record.topic) : "general",
      decisionNeeded: record.decisionNeeded,
      routineSuccess: record.routineSuccess,
    };
  }
}
