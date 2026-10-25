#!/usr/bin/env node
import { OllamaReasoner } from "../dist/src/reasoning/ollama.js";
import { LocalReasoner } from "../dist/src/core/reasoner.js";

const ollama = new OllamaReasoner("http://127.0.0.1:11434/api/generate", "qwen3.8:latest", { fallbackToLocal: true });
const local = new LocalReasoner();

const reasonerInput = {
  goal: {
    id: "test-goal",
    hypothesis: "migrate --prod must pass before deploy",
    confidence: 0.5,
    needsCorrection: false,
    correctedByUser: false,
    updatedAt: new Date().toISOString(),
  },
  brief: null,
  returnToTask: false,
  depthByTopic: {},
  observations: [
    {
      id: "obs-1",
      providerId: "terminal",
      label: "migrate --prod",
      locator: "/app",
      summary: "migrate --prod exited 1.",
      payload: { command: "migrate --prod", cwd: "/app", gitBranch: "main", exitCode: 1, stderr: "database is locked", stdout: "", truncated: false, timestamp: new Date().toISOString() },
      signatureKey: "migrate --prod|/app|1|ts",
      createdAt: new Date().toISOString(),
    },
  ],
  openQuestions: [],
  recentSummaries: [],
};

const started = Date.now();
const ollamaOut = await ollama.reason(reasonerInput);
const ollamaMs = Date.now() - started;
console.log("OLLAMA ms:", ollamaMs);
console.log("OLLAMA result:");
console.log(JSON.stringify(ollamaOut, null, 2));

const localOut = local.reason(reasonerInput);
console.log("LOCAL result (for comparison):");
console.log(JSON.stringify(localOut, null, 2));
