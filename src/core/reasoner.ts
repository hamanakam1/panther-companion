import { readFileSync } from "node:fs";
import type { Depth, Observation, ReasonerInput, ReasonerOutput } from "../domain.js";
import { isUnsetGoal } from "./goal.js";
import { isRoutineSuccess } from "./routine.js";
import { asRecord, excerpt, readString } from "./text.js";
import { sharesSignature } from "./insights.js";

export interface Reasoner {
  readonly id: string;
  reason(input: ReasonerInput): Promise<ReasonerOutput>;
}

export function buildReasoningPrompt(template: string, input: ReasonerInput): string {
  const payload = {
    goal: {
      hypothesis: input.goal.hypothesis,
      confidence: input.goal.confidence,
      needsCorrection: input.goal.needsCorrection,
    },
    brief: input.brief,
    returnToTask: input.returnToTask,
    observations: input.observations.map((obs) => ({
      id: obs.id,
      providerId: obs.providerId,
      label: obs.label,
      locator: obs.locator,
      summary: obs.summary,
      payload: obs.payload,
    })),
    openQuestions: input.openQuestions.map((question) => ({
      id: question.id,
      text: question.text,
      observationIds: question.observationIds,
    })),
    recentSummaries: input.recentSummaries,
  };
  return `${template.trim()}\n\nInput JSON:\n${JSON.stringify(payload, null, 2)}\n`;
}

export function loadPromptTemplate(path: string): string {
  return readFileSync(path, "utf8");
}

export class LocalReasoner implements Reasoner {
  readonly id = "local";

  async reason(input: ReasonerInput): Promise<ReasonerOutput> {
    return reasonLocally(input);
  }
}

export function reasonLocally(input: ReasonerInput): ReasonerOutput {
  if (input.brief && input.openQuestions.length) return brief(input);
  const intent = input.observations.find(obs => obs.providerId === "panther-ic");
  if (intent) return intentExplanation(input, intent);
  if (input.returnToTask && input.openQuestions.length > 0) return returning(input);
  const mismatch = findMismatch(input.observations);
  if (mismatch) return mismatchExplanation(input, mismatch);
  const agents = input.observations.filter((obs) => obs.providerId === "agent");
  if (agents.length >= 2 && sharesSignature(agents)) return multiAgent(input, agents);
  const failure = input.observations.find(isFailure);
  if (failure?.providerId === "agent") return agentFailure(input, failure);
  if (failure) return failureExplanation(input, failure);
  if (isRoutineSuccess(input.observations)) return routine(input);
  if (input.observations.length === 0) return emptyCapture(input);
  return thin(input);
}

function intentExplanation(input: ReasonerInput, intent: Observation): ReasonerOutput {
  const payload = asRecord(intent.payload) ?? {};
  const strings = (key: string) => Array.isArray(payload[key]) ? (payload[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];
  const evidence = readString(payload, "observedEvidence") ?? "";
  const hypothesis = readString(payload, "hypothesis");
  const checks = strings("suggestedChecks");
  const acceptance = strings("acceptanceCriteria");
  return {
    whatItMeans: `A captured workflow has a proposal to review: ${excerpt(intent.label, 220)}`,
    whyItMattersHere: `${goalSentence(input)} The imported proposal is context for your decision; it has not been verified or scheduled.`,
    nextCheck: checks[0] ? `Proposed check (not yet performed): ${checks[0]}` : acceptance[0] ? `Verify this proposed acceptance condition: ${acceptance[0]}` : "Compare the captured steps with the behavior you expected, then define one verifiable acceptance condition.",
    usedObservationIds: [intent.id],
    observed: [...(evidence ? [`Producer's evidence summary (not independently verified): ${evidence}`] : []), ...strings("observedSteps").map(step => `Producer-reported step (not independently verified): ${step}`)],
    inferred: hypothesis ? [`Unverified proposal: ${hypothesis}`] : [],
    unknown: ["Whether the proposed issue reproduces now.", "Whether the suggested change will satisfy the goal.", ...strings("questions")],
    confidence: 0.6, topic: "captured-intent", decisionNeeded: true, routineSuccess: false,
  };
}

type Claim = { observationId: string; locator: string; key: string; value: string };

function findMismatch(observations: Observation[]): { left: Claim; right: Claim } | null {
  const claims: Claim[] = [];
  for (const obs of observations) {
    const payload = asRecord(obs.payload);
    for (const field of ["docClaim", "projectFact"]) {
      const record = asRecord(payload?.[field]);
      const key = readString(record, "key");
      const value = readString(record, "value");
      if (key && value) claims.push({ observationId: obs.id, locator: obs.locator, key, value });
    }
  }
  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      const left = claims[i];
      const right = claims[j];
      if (!left || !right) continue;
      if (left.key === right.key && left.value !== right.value && left.observationId !== right.observationId) {
        return { left, right };
      }
    }
  }
  return null;
}

function isFailure(obs: Observation): boolean {
  const payload = asRecord(obs.payload);
  if (!payload) return false;
  if (typeof payload.exitCode === "number" && payload.exitCode !== 0) return true;
  if (obs.providerId === "agent") {
    const level = readString(payload, "level");
    return level === "error" || level === "fatal";
  }
  return false;
}

function goalSentence(input: ReasonerInput): string {
  if (input.goal.needsCorrection) {
    return `The current goal hypothesis ("${input.goal.hypothesis}") was marked as the wrong task and needs an edit.`;
  }
  if (isUnsetGoal(input.goal)) {
    return "No current goal is set, so this cannot be tied to a confirmed task.";
  }
  return `The current goal hypothesis is "${input.goal.hypothesis}".`;
}

function withDepth(input: ReasonerInput, output: ReasonerOutput, mechanism: string | null): ReasonerOutput {
  const depth: Depth = input.depthByTopic[output.topic] ?? "brief";
  if (depth === "mechanism" && mechanism) {
    return {
      ...output,
      whyItMattersHere: `${output.whyItMattersHere} Mechanism, from captured text only: ${mechanism}`,
    };
  }
  if (depth === "mechanism" && !mechanism) {
    return { ...output, unknown: [...output.unknown, "The captured evidence does not state a mechanism."] };
  }
  return output;
}

function failureExplanation(input: ReasonerInput, failure: Observation): ReasonerOutput {
  const payload = asRecord(failure.payload) ?? {};
  const command = typeof payload.command === "string" ? payload.command : failure.summary;
  const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : null;
  const stderr = typeof payload.stderr === "string" ? payload.stderr.trim() : "";
  const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
  const branch = typeof payload.gitBranch === "string" ? payload.gitBranch : null;
  const truncated = payload.truncated === true;
  const observed = [
    exitCode === null ? `Command captured: ${command}` : `${command} exited ${exitCode}.`,
  ];
  if (cwd) observed.push(`Working directory: ${cwd}`);
  if (branch) observed.push(`Git branch: ${branch}`);
  if (stderr) observed.push(`stderr: ${excerpt(stderr, 400)}`);
  else observed.push("No stderr was captured.");
  if (typeof payload.stdout === "string" && payload.stdout.trim()) {
    observed.push(`stdout: ${excerpt(payload.stdout, 400)}`);
  }

  const inferred: string[] = [];
  const unknown: string[] = [];
  if (/database is locked/i.test(stderr)) {
    inferred.push("Another process may be holding the database file.");
    unknown.push("Which process holds the lock.");
  } else if (/command not found/i.test(stderr)) {
    inferred.push("The executable was not found on PATH in this capture.");
    unknown.push("Whether the executable is expected to be installed for this goal.");
  } else if (/EADDRINUSE/i.test(stderr) || /address already in use/i.test(stderr)) {
    inferred.push("The port named in the captured error may already be bound.");
    unknown.push("Which process is listening.");
  } else if (!stderr) {
    unknown.push("Why the command failed. stderr was not captured.");
  } else {
    unknown.push("The cause beyond the captured stderr text.");
  }
  if (truncated) unknown.push("Output beyond the truncation point.");
  if (input.goal.needsCorrection) unknown.push("Whether this failure matters to the real goal.");

  const topic = "command-failure";
  return withDepth(input, {
    whatItMeans: exitCode === null
      ? `A captured command failed: ${excerpt(command, 140)}.`
      : `\`${excerpt(command, 140)}\` exited ${exitCode}.`,
    whyItMattersHere: `${goalSentence(input)} This failure was captured while that hypothesis was current.`,
    nextCheck: stderr
      ? `Check the captured stderr before retrying: "${excerpt(stderr, 220)}".`
      : "Re-run the command with stderr captured, then explain again.",
    usedObservationIds: [failure.id],
    observed,
    inferred,
    unknown,
    confidence: stderr && !truncated ? 0.8 : 0.55,
    topic,
    decisionNeeded: !stderr || input.goal.needsCorrection,
    routineSuccess: false,
  }, stderr ? `"${excerpt(stderr, 220)}"` : null);
}

function mismatchExplanation(
  input: ReasonerInput,
  mismatch: { left: Claim; right: Claim },
): ReasonerOutput {
  const observed = [
    `${mismatch.left.locator} claims ${mismatch.left.key}=${mismatch.left.value}.`,
    `${mismatch.right.locator} claims ${mismatch.right.key}=${mismatch.right.value}.`,
  ];
  return withDepth(input, {
    whatItMeans: `Captured sources disagree on ${mismatch.left.key}: ${mismatch.left.value} versus ${mismatch.right.value}.`,
    whyItMattersHere: `${goalSentence(input)} Following the wrong captured value would aim this goal at the other setup.`,
    nextCheck: `Compare the two captured ${mismatch.left.key} values before changing config or following the doc.`,
    usedObservationIds: [mismatch.left.observationId, mismatch.right.observationId],
    observed,
    inferred: ["The documentation may not match this project's captured config."],
    unknown: [`Which ${mismatch.left.key} value the current goal should use.`],
    confidence: 0.76,
    topic: "doc-mismatch",
    decisionNeeded: true,
    routineSuccess: false,
  }, null);
}

function multiAgent(input: ReasonerInput, agents: Observation[]): ReasonerOutput {
  const observed = agents.map((obs) => {
    const payload = asRecord(obs.payload);
    const name = readString(payload, "agent") ?? obs.providerId;
    const message = readString(payload, "message") ?? obs.summary;
    return `${name}: ${excerpt(message, 240)}`;
  });
  const firstPayload = asRecord(agents[0]?.payload);
  const quoted = readString(firstPayload, "message") ?? agents[0]?.summary ?? "the same error";
  return withDepth(input, {
    whatItMeans: `${agents.length} agent events report the same captured failure.`,
    whyItMattersHere: `${goalSentence(input)} Related agent failures can be one blocked task rather than ${agents.length} separate tasks.`,
    nextCheck: "Check the shared captured error once, then see which agents are still reporting it.",
    usedObservationIds: agents.map((obs) => obs.id),
    observed,
    inferred: ["These events may share one cause because the captured messages match."],
    unknown: ["Which process is responsible, and which agent is authoritative."],
    confidence: 0.72,
    topic: "shared-agent-failure",
    decisionNeeded: true,
    routineSuccess: false,
  }, `"${excerpt(quoted, 220)}"`);
}

function agentFailure(input: ReasonerInput, failure: Observation): ReasonerOutput {
  const payload = asRecord(failure.payload);
  const name = readString(payload, "agent") ?? "agent";
  const message = readString(payload, "message") ?? failure.summary;
  return withDepth(input, {
    whatItMeans: `${name} reported an error.`,
    whyItMattersHere: `${goalSentence(input)} One captured agent event is not enough to call it a shared failure.`,
    nextCheck: `Read the captured message before restarting work: "${excerpt(message, 220)}".`,
    usedObservationIds: [failure.id],
    observed: [`${name}: ${excerpt(message, 400)}`],
    inferred: [],
    unknown: [
      "Whether any other agent hit the same failure. Only one event was captured.",
      "Which process is behind the message.",
    ],
    confidence: 0.6,
    topic: "agent-failure",
    decisionNeeded: false,
    routineSuccess: false,
  }, `"${excerpt(message, 220)}"`);
}

function routine(input: ReasonerInput): ReasonerOutput {
  const observed = input.observations.map((obs) => {
    const payload = asRecord(obs.payload);
    const command = readString(payload, "command") ?? obs.summary;
    return `${command} exited 0.`;
  });
  const stdout = input.observations
    .map((obs) => readString(asRecord(obs.payload), "stdout"))
    .find((text) => text && text.trim());
  if (stdout) observed.push(`stdout: ${excerpt(stdout, 240)}`);
  return {
    whatItMeans: "The captured command finished successfully.",
    whyItMattersHere: `${goalSentence(input)} Nothing in this capture shows a problem for that hypothesis.`,
    nextCheck: "No check is suggested while this captured command is succeeding.",
    usedObservationIds: input.observations.map((obs) => obs.id),
    observed,
    inferred: ["This slice of work is progressing normally."],
    unknown: ["Whether work outside this capture is fine."],
    confidence: 0.84,
    topic: "routine-success",
    decisionNeeded: false,
    routineSuccess: true,
  };
}

function returning(input: ReasonerInput): ReasonerOutput {
  const questions = input.openQuestions.filter((question) => question.status === "open");
  const ids = [...new Set(questions.flatMap((question) => question.observationIds))];
  const returnIds = input.observations.filter((obs) => asRecord(obs.payload)?.event === "return").map((obs) => obs.id);
  const observed = questions.map((question) => `Open question, stored ${question.createdAt}: ${question.text}`);
  for (const obs of input.observations) {
    if (asRecord(obs.payload)?.event === "return") observed.push(`Return signal: ${obs.summary}`);
  }
  const first = questions[0]?.text ?? "an open question";
  return {
    whatItMeans: `This task was interrupted. Still open: ${first}`,
    whyItMattersHere: `${goalSentence(input)} The stored question is the last decision this goal was waiting on.`,
    nextCheck: "Answer that question, or edit the goal if it is no longer the task.",
    usedObservationIds: [...new Set([...ids, ...returnIds])],
    observed,
    inferred: ["This looks like a return to the interrupted task."],
    unknown: ["What changed while you were away. That was not in the captured evidence."],
    confidence: input.goal.correctedByUser ? 0.7 : 0.58,
    topic: "interrupted-task",
    decisionNeeded: true,
    routineSuccess: false,
  };
}

function brief(input: ReasonerInput): ReasonerOutput {
  const questions = input.openQuestions.filter((question) => question.status === "open").slice(0, 3);
  const ids = [...new Set(questions.flatMap((question) => question.observationIds))];
  const lines = questions.map((question) => question.text);
  return {
    whatItMeans: lines.length === 1
      ? `Decision waiting: ${lines[0]}`
      : `Decisions waiting: ${lines.join(" ")}`,
    whyItMattersHere: `${goalSentence(input)} This brief was held until a pause so it would not cut into the work.`,
    nextCheck: lines.length === 1 ? `Decide this before continuing: ${lines[0]}` : "Decide the stored questions before continuing.",
    usedObservationIds: ids,
    observed: lines.map((line) => `Stored question: ${line}`),
    inferred: [],
    unknown: ["Which option you want. The capture does not contain the decision."],
    confidence: 0.66,
    topic: "decision-brief",
    decisionNeeded: true,
    routineSuccess: false,
  };
}

function emptyCapture(input: ReasonerInput): ReasonerOutput {
  return {
    whatItMeans: "No terminal event or focused browser text was captured.",
    whyItMattersHere: goalSentence(input),
    nextCheck: "Focus a browser or record a terminal command, then explain again.",
    usedObservationIds: [],
    observed: [],
    inferred: [],
    unknown: ["What is on the work surface right now."],
    confidence: 0.2,
    topic: "empty-capture",
    decisionNeeded: false,
    routineSuccess: false,
  };
}

function thin(input: ReasonerInput): ReasonerOutput {
  const observed = input.observations.map((obs) => `${obs.label}: ${excerpt(obs.summary, 240)}`);
  return withDepth(input, {
    whatItMeans: "The capture does not show a failure or a disagreement.",
    whyItMattersHere: `${goalSentence(input)} There is not enough captured evidence to say it changes that hypothesis.`,
    nextCheck: "If something looks wrong, capture that surface again and explain it.",
    usedObservationIds: input.observations.map((obs) => obs.id),
    observed,
    inferred: [],
    unknown: ["Whether this capture matters to the goal. The evidence does not say."],
    confidence: 0.35,
    topic: "thin-evidence",
    decisionNeeded: false,
    routineSuccess: false,
  }, null);
}

export function questionTextFor(output: ReasonerOutput): string | null {
  if (!output.decisionNeeded) return null;
  if (output.unknown.length > 0 && output.topic === "doc-mismatch") return output.nextCheck;
  if (output.topic === "shared-agent-failure") return output.nextCheck;
  return output.nextCheck;
}
