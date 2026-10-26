import { randomUUID } from "node:crypto";
import { Panther } from "./ingest.js";
import { FEEDBACK_KINDS, type FeedbackKind, type Observation } from "./domain.js";
import { InputError, parseIntentBundle, record, text } from "./bundle.js";
import { VERSION } from "./version.js";
import { captureScriptPath } from "./paths.js";

const now = () => new Date().toISOString();
export class CompanionController {
  private busy = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastError: string | null = null;
  constructor(readonly panther: Panther, private readonly clock = now) {
    // A process restart must not silently resume observation.
    const session = panther.store.getSession();
    if (session?.status === "active") panther.store.saveSession({ ...session, status: "paused" });
  }
  start(): void {
    if (!this.timer) { this.timer = setInterval(() => { void this.tick(); }, 4000); this.timer.unref(); }
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.panther.invalidate(); }
  status() {
    const p = this.panther;
    p.store.expireDue(this.clock());
    const session = p.store.getSession();
    if (session?.status === "active" && session.endsAt <= this.clock()) { p.invalidate(); p.store.saveSession({ ...session, status: "ended" }); }
    return { goal: p.store.getGoal(this.clock()), live: p.store.getLive(), session: p.store.getSession(), paused: p.store.getPreferences().paused, sources: p.sources(), observable: p.observableSources(), counts: p.store.countInsights(), observations: p.store.latestObservations(8).map(({ payload: _payload, signature: _signature, ...rest }) => rest), questions: p.store.listOpenQuestions(), lastDecision: p.store.listGateLogs(1)[0] ?? null, busy: this.busy, error: this.lastError, version: VERSION, captureScript: captureScriptPath() };
  }
  async tick(): Promise<void> {
    const status = this.status();
    if (this.busy || status.paused || status.session?.status !== "active" || status.session.mode !== "follow") return;
    try { await this.run(() => this.panther.ingest({ now: this.clock(), sessionMode: "follow" })); }
    catch { this.lastError = "Could not read the configured evidence source. Try Explain again."; }
  }
  async action(action: string, value: unknown = {}): Promise<unknown> {
    const data = record(value);
    const p = this.panther;
    switch (action) {
      case "status": return this.status();
      case "goal": {
        const hypothesis = data.hypothesis === null ? null : text(data.hypothesis, "Goal", 2000);
        p.setGoal(hypothesis || null, this.clock()); return this.status();
      }
      case "pause": {
        if (typeof data.paused !== "boolean") throw new InputError("Paused must be a boolean.");
        const paused = data.paused;
        p.store.transaction(() => {
          p.invalidate();
          p.store.savePreferences({ ...p.store.getPreferences(), paused });
          const session = p.store.getSession();
          if (session) p.store.saveSession({ ...session, status: "paused" });
        });
        return this.status();
      }
      case "explain": return this.run(async () => { await p.explain({ now: this.clock() }); return this.status(); });
      case "follow": return this.run(async () => {
        if (p.store.getPreferences().paused) throw new InputError("Resume Companion before starting Follow.");
        if (!p.store.getGoal(this.clock()).correctedByUser) throw new InputError("Set a goal before starting Follow.");
        if (!p.observableSources().length) throw new InputError("No capture source is configured, so Follow has nothing to read. Attach evidence manually, or run a command through scripts/capture-command.sh and try again.");
        await p.follow({ now: this.clock() }); return this.status();
      });
      case "prepare": return this.run(async () => { await p.prepare({ now: this.clock(), naturalPause: true }); return this.status(); });
      case "stop": {
        p.invalidate(); const session = p.store.getSession(); if (session) p.store.saveSession({ ...session, status: "ended" }); return this.status();
      }
      case "feedback": {
        if (!(FEEDBACK_KINDS as readonly unknown[]).includes(data.kind)) throw new InputError("Choose a supported feedback action.");
        const live = p.store.getLive();
        if (!live) throw new InputError("There is no explanation to give feedback on.");
        p.recordFeedback(data.kind as FeedbackKind, live.insightId, live.explanation.topic, this.clock());
        return this.status();
      }
      case "observation": return this.run(async () => {
        if (p.store.getPreferences().paused) throw new InputError("Resume before adding evidence.");
        const summary = text(data.text, "Evidence", 12000, true);
        const kind = data.kind ?? "note";
        if (kind !== "note" && kind !== "terminal") throw new InputError("Choose note or terminal evidence.");
        let payload: Record<string, unknown> = { text: summary };
        if (kind === "terminal") {
          const command = text(data.command, "Command", 1000, true);
          if (!Number.isInteger(data.exitCode) || Math.abs(data.exitCode as number) > 255) throw new InputError("Exit code must be an integer between -255 and 255.");
          payload = { command, exitCode: data.exitCode, stderr: data.exitCode === 0 ? "" : summary, stdout: data.exitCode === 0 ? summary : "", truncated: false };
        }
        const observation: Observation = { id: randomUUID(), providerId: kind === "terminal" ? "terminal" : "manual", capturedAt: this.clock(), label: kind === "terminal" ? payload.command as string : "Selected evidence", locator: "Manually attached", summary, payload, signature: `${kind}:${summary.slice(0, 500)}:${data.command ?? ""}` };
        await p.ingestObservations([observation], { onRequest: true, now: this.clock() }); return this.status();
      });
      case "import-preview": return parseIntentBundle(data.bundle, this.clock());
      case "import": return this.run(async () => {
        if (p.store.getPreferences().paused) throw new InputError("Resume before importing evidence.");
        if (typeof data.useGoal !== "boolean") throw new InputError("Use captured goal must be a boolean.");
        const bundle = parseIntentBundle(data.bundle, this.clock());
        if (data.useGoal && bundle.goal) p.setGoal(bundle.goal, this.clock());
        if (bundle.observations.length) await p.ingestObservations(bundle.observations, { onRequest: true, now: this.clock() });
        return { ...this.status(), imported: bundle.count };
      });
      case "dismiss": p.invalidate(); p.store.setLive(null); return this.status();
      case "export": return p.exportAll();
      case "delete": {
        if (data.confirm !== "DELETE") throw new InputError("Type DELETE to confirm deleting local Companion history.");
        p.deleteAll(this.clock()); return this.status();
      }
      default: throw new InputError("Unknown Companion action.");
    }
  }
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new InputError("Companion is already working. Wait for the current request or pause it.");
    this.busy = true; this.lastError = null;
    try {
      const result = await fn();
      if (result && typeof result === "object" && "busy" in result) result.busy = false;
      return result;
    } finally { this.busy = false; }
  }
}
