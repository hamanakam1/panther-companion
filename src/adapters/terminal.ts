import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Observation, IngestOptions } from "../domain.js";
import { Adapter, observationSummary } from "./adapter.js";

/**
 * TerminalAdapter — structured terminal events inspired by Warp.
 *
 * Reads JSONL capture lines (one terminal event per line) from a log file or
 * stdin. Each line may carry: command, cwd, gitBranch, exitCode, input, output,
 * stderr, stdout, truncated, timestamp, naturalPause, event.
 *
 * Set PANTHER_TERMINAL_LOG to a JSONL path, or pipe events into stdin.
 */
export class TerminalAdapter extends Adapter {
  readonly id = "terminal";
  private readonly logPath: string | null;

  constructor(logPath?: string | null) {
    super();
    this.logPath = logPath ?? process.env.PANTHER_TERMINAL_LOG ?? null;
  }

  supports(): boolean {
    return Boolean(this.logPath);
  }

  async capture(options?: IngestOptions): Promise<Observation[]> {
    const now = options?.now ?? new Date().toISOString();
    const events = this.logPath ? this.readFileEvents() : await this.readStdinEvents();
    const observations: Observation[] = [];
    for (const event of events) {
      const command =
        typeof event.command === "string" ? event.command : observationSummary(event, "terminal event");
      const cwd = typeof event.cwd === "string" ? event.cwd : "";
      const exitCode = typeof event.exitCode === "number" ? event.exitCode : null;
      const summary = [
        command,
        cwd ? `in ${cwd}` : "",
        exitCode !== null ? `exit ${exitCode}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      observations.push(
        this.makeObservation({
          label: command,
          locator: cwd || command,
          summary,
          payload: event,
          signatureKey: `${command}|${cwd}|${exitCode ?? "-"}|${event.timestamp ?? now}`,
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

  private async readStdinEvents(): Promise<Array<Record<string, unknown>>> {
    const events: Array<Record<string, unknown>> = [];
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // ignore non-JSON lines
      }
    }
    return events;
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
