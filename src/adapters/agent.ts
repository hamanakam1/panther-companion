import { readFileSync } from "node:fs";
import type { Observation, IngestOptions } from "../domain.js";
import { Adapter, observationSummary } from "./adapter.js";

/**
 * AgentEventAdapter — incoming events from CLI agents or an HSF-style system.
 *
 * Reads JSONL capture lines. Each line may carry: agent, level, message,
 * timestamp, event. providerId is "agent".
 */
export class AgentEventAdapter extends Adapter {
  readonly id = "agent";
  private readonly logPath: string | null;

  constructor(logPath?: string | null) {
    super();
    this.logPath = logPath ?? process.env.PANTHER_AGENT_LOG ?? null;
  }

  supports(): boolean {
    return Boolean(this.logPath);
  }

  async capture(options?: IngestOptions): Promise<Observation[]> {
    const now = options?.now ?? new Date().toISOString();
    const events = this.logPath ? this.readFileEvents() : [];
    const observations: Observation[] = [];
    for (const event of events) {
      const agent = typeof event.agent === "string" ? event.agent : "agent";
      const level = typeof event.level === "string" ? event.level : "info";
      const message =
        typeof event.message === "string"
          ? event.message
          : typeof event.summary === "string"
          ? event.summary
          : "";
      const summary = `${level}: ${observationSummary(event, message || "agent event")}`;
      observations.push(
        this.makeObservation({
          label: `${agent} ${level}`,
          locator: agent,
          summary,
          payload: event,
          signatureKey: `${agent}|${level}|${message}|${event.timestamp ?? now}`,
        }),
      );
    }
    return observations;
  }

  private readFileEvents(): Array<Record<string, unknown>> {
    try {
      const text = readFileSync(this.logPath!, "utf8");
      return this.parseJsonl(text);
    } catch {
      return [];
    }
  }

  private parseJsonl(text: string): Array<Record<string, unknown>> {
    const events: Array<Record<string, unknown>> = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
    return events;
  }
}
