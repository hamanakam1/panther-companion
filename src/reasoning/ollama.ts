import type { ReasonerInput, ReasonerOutput } from "../domain.js";

// Node 26 ships a global fetch; declare it here so ollama works whether or
// not @types/node bundles node:fetch types.
declare const fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
import { Reasoner, buildReasoningPrompt, currentEvidence, intentExplanation, loadPromptTemplate, reasonLocally } from "../core/reasoner.js";
import { isRoutineSuccess } from "../core/routine.js";
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
    // Match local reasoning's current-result view without removing stored history.
    input = { ...input, observations: currentEvidence(input.observations) };
    const prompt = this.promptTemplate(input);
    try {
      const text = await this.generate(prompt);
      const parsed = this.parseJson(text);
      const knownIds = new Set(input.observations.map(observation => observation.id));
      if (parsed && parsed.usedObservationIds.every(id => knownIds.has(id))
        && (!knownIds.size || parsed.usedObservationIds.length > 0)) {
        // A model cannot turn a failed/partial command into a quiet success.
        parsed.routineSuccess = parsed.routineSuccess && isRoutineSuccess(input.observations);
        return this.groundImportedEvidence(input, parsed);
      }
    } catch {
      // ollama unreachable or bad response -> fall through
    }
    if (this.fallbackToLocal) {
      const local = reasonLocally(input);
      return { ...local, whyItMattersHere: `Local fallback: the model response was unavailable or invalid. ${local.whyItMattersHere}` };
    }
    throw new Error("ollama reasoning failed and local fallback is disabled");
  }

  private groundImportedEvidence(input: ReasonerInput, model: ReasonerOutput): ReasonerOutput {
    const imports = input.observations.filter(observation => observation.providerId === "panther-ic");
    if (!imports.length) return model;

    // This is factual grounding of a successful model response, not fallback.
    // Keep strongest-current-evidence precedence (e.g. a new terminal failure).
    const canonical = reasonLocally(input);
    const imported = imports.map(observation => ({ observation, facts: intentExplanation(input, observation) }));
    const knownIds = new Set(input.observations.map(observation => observation.id));
    const storedQuestionContext = canonical.topic === "decision-brief" || canonical.topic === "interrupted-task";
    const suppliedIds = new Set([...knownIds, ...input.openQuestions.flatMap(question => question.observationIds)]);
    const usedIds = new Set([
      ...model.usedObservationIds,
      ...imports.map(observation => observation.id),
      // Stored questions carry real historical references the store can resolve.
      // They are not valid model citations or newly observed historical facts.
      ...canonical.usedObservationIds.filter(id => suppliedIds.has(id)),
    ]);
    const observed = input.observations.filter(observation => usedIds.has(observation.id)).flatMap(observation => {
      const facts = observation.providerId === "panther-ic"
        ? intentExplanation(input, observation)
        : reasonLocally({ ...input, observations: [observation], brief: false, returnToTask: false });
      return facts.observed.map(line => `[${observation.id}] ${line}`);
    });
    return {
      ...model,
      whatItMeans: canonical.whatItMeans,
      whyItMattersHere: `${canonical.whyItMattersHere} Imported capture outcomes remain unverified; model interpretations below are hypotheses.`,
      nextCheck: canonical.topic === "captured-intent" ? `Model-proposed check (not performed): ${model.nextCheck}` : canonical.nextCheck,
      usedObservationIds: [...usedIds],
      observed: [...(storedQuestionContext ? canonical.observed : []), ...observed],
      inferred: [
        ...imported.flatMap(({ observation, facts }) => facts.inferred.map(line => `[${observation.id}] ${line}`)),
        ...[model.whatItMeans, model.whyItMattersHere, ...model.inferred].map(line => `Unverified model interpretation: ${line}`),
        ...(canonical.topic !== "captured-intent" ? [`Alternative model-proposed check (not performed): ${model.nextCheck}`] : []),
      ],
      unknown: [
        ...canonical.unknown,
        ...imported.flatMap(({ observation, facts }) => facts.unknown.map(line => `[${observation.id}] ${line}`)),
        "Whether the imported acceptance conditions are met. A proposal or failed request is not a verified outcome.",
        "Whether the model interpretation is correct or its proposed check has been performed.",
        ...(storedQuestionContext && canonical.usedObservationIds.some(id => !knownIds.has(id))
          ? ["Stored questions reference historical evidence absent from this input. Only the stored question text was used; its historical claims were not newly verified."] : []),
        ...model.unknown.map(line => `Model-raised uncertainty: ${line}`),
      ],
      confidence: Math.min(model.confidence, canonical.confidence, 0.6),
      topic: canonical.topic,
      decisionNeeded: canonical.decisionNeeded,
      routineSuccess: false,
    };
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
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return this.coerce(parsed);
    } catch {
      return null;
    }
  }

  private coerce(record: Record<string, unknown>): ReasonerOutput | null {
    const text = (value: unknown, limit = 4000): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= limit;
    if (!["whatItMeans", "whyItMattersHere", "nextCheck"].every(key => text(record[key])) || !text(record.topic, 120)) return null;
    if (typeof record.decisionNeeded !== "boolean" || typeof record.routineSuccess !== "boolean" || typeof record.confidence !== "number" || !Number.isFinite(record.confidence)) return null;
    if (record.confidence < 0 || record.confidence > 1) return null;
    for (const key of ["usedObservationIds", "observed", "inferred", "unknown"]) {
      const values = record[key];
      if (!Array.isArray(values) || values.length > 64 || !values.every(value => text(value))) return null;
    }
    const usedObservationIds = record.usedObservationIds as string[];
    if (new Set(usedObservationIds).size !== usedObservationIds.length) return null;
    return {
      whatItMeans: record.whatItMeans as string,
      whyItMattersHere: record.whyItMattersHere as string,
      nextCheck: record.nextCheck as string,
      usedObservationIds,
      observed: record.observed as string[],
      inferred: record.inferred as string[],
      unknown: record.unknown as string[],
      confidence: record.confidence,
      topic: record.topic as string,
      decisionNeeded: record.decisionNeeded,
      routineSuccess: record.routineSuccess,
    };
  }
}
