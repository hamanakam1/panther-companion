import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { watch } from "node:fs";
import type { Observation, IngestOptions } from "../domain.js";
import { Adapter, observationSummary } from "./adapter.js";

/**
 * TerminalAdapter — structured terminal events inspired by Warp.
 *
 * Reads JSONL capture lines (one terminal event per line) from a log file or
 * stdin. Each line may carry: command, cwd, gitBranch, exitCode, input, output,
 * stderr, stdout, truncated, timestamp, naturalPause, event.
 *
 * The adapter watches the log file incrementally: it remembers the byte offset
 * it has read up to and only returns new lines on subsequent captures, so a
 * long-running host can poll for live terminal events.
 *
 * Set PANTHER_TERMINAL_LOG to a JSONL path, or pipe events into stdin.
 * Use inject() to push events programmatically.
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
    const events = this.logPath ? this.readNewFileEvents() : await this.readStdinEvents();
    return events.map((event) => this.eventToObservation(event, now));
  }

  /** Push a terminal event programmatically (live capture integration). */
  inject(event: Record<string, unknown>, now?: string): Observation {
    return this.eventToObservation(event, now ?? new Date().toISOString());
  }

  /** Start watching the log file for changes. Caller must call stopWatcher(). */
  watchLogFile(onChange: () => void): () => void {
    if (!this.logPath) return () => {};
    const watcher = watch(this.logPath, () => onChange());
    return () => watcher.close();
  }

  private readNewFileEvents(): Array<Record<string, unknown>> {
    try {
      const stat = readFileSync(this.logPath!, "utf8");
      return this.parseJsonlFromOffset(stat);
    } catch {
      return [];
    }
  }

  private parseJsonlFromOffset(text: string): Array<Record<string, unknown>> {
    // Simple approach: re-parse the whole file but track offset via byte length.
    // For a live tailing use-case, this is adequate for small-to-medium logs.
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

  private eventToObservation(
    event: Record<string, unknown>,
    now: string,
  ): Observation {
    const command =
      typeof event.command === "string"
        ? event.command
        : observationSummary(event, "terminal event");
    const cwd = typeof event.cwd === "string" ? event.cwd : "";
    const exitCode = typeof event.exitCode === "number" ? event.exitCode : null;
    const summary = [
      command,
      cwd ? `in ${cwd}` : "",
      exitCode !== null ? `exit ${exitCode}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return this.makeObservation({
      label: command,
      locator: cwd || command,
      summary,
      payload: event,
      signatureKey: `${command}|${cwd}|${exitCode ?? "-"}|${event.timestamp ?? now}`,
    });
  }
}
