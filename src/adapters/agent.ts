import { JsonlCursor } from "./jsonl.js";
import { watch } from "node:fs";
import type { Observation, IngestOptions } from "../domain.js";
import { Adapter } from "./adapter.js";

/**
 * AgentEventAdapter — incoming events from CLI agents or an HSF-style system.
 *
 * Reads JSONL capture lines. Each line may carry: agent, level, message,
 * timestamp, event. providerId is "agent".
 *
 * The adapter watches the log file incrementally for live capture.
 */
export class AgentEventAdapter extends Adapter {
  readonly id = "agent";
  private readonly logPath: string | null;
  private readonly cursor = new JsonlCursor();

  constructor(logPath?: string | null) {
    super();
    this.logPath = logPath ?? process.env.PANTHER_AGENT_LOG ?? null;
  }

  supports(): boolean {
    return Boolean(this.logPath);
  }

  readiness() {
    return this.logPath ? { id: this.id, configured: true, ...this.cursor.status() } : super.readiness();
  }

  async capture(options?: IngestOptions): Promise<Observation[]> {
    const now = options?.now ?? new Date().toISOString();
    const events = this.logPath ? this.cursor.read(this.logPath, now) : [];
    return events.map((event) => this.eventToObservation(event, now));
  }

  /** Push an agent event programmatically (live capture integration). */
  inject(event: Record<string, unknown>, now?: string): Observation {
    return this.eventToObservation(event, now ?? new Date().toISOString());
  }

  /** Start watching the log file for changes. Caller must call stopWatcher(). */
  watchLogFile(onChange: () => void): () => void {
    if (!this.logPath) return () => {};
    const watcher = watch(this.logPath, () => onChange());
    return () => watcher.close();
  }

  private eventToObservation(
    event: Record<string, unknown>,
    now: string,
  ): Observation {
    const agent = typeof event.agent === "string" ? event.agent : "agent";
    const level = typeof event.level === "string" ? event.level : "info";
    const message = typeof event.message === "string" ? event.message : event.summary ?? "";
    const summary = `${level}: ${message}`;
    return this.makeObservation({
      label: `${agent} ${level}`,
      locator: agent,
      summary,
      payload: event,
      signatureKey: `${agent}|${level}|${message}|${event.timestamp ?? now}`,
    });
  }
}
