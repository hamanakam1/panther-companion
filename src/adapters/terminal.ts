import { JsonlCursor } from "./jsonl.js";
import { createInterface } from "node:readline";
import { existsSync, watch } from "node:fs";
import type { Observation, IngestOptions } from "../domain.js";
import { Adapter, observationSummary } from "./adapter.js";
import { terminalLogPath } from "../paths.js";

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
 * The path comes from PANTHER_TERMINAL_LOG, falling back to
 * `~/.panther-companion/terminal.jsonl` — the same file
 * scripts/capture-command.sh appends to. Pass an explicit null to disable the
 * source entirely. Events can also be pushed via inject(), or piped via the
 * explicit captureStdin() call.
 */
export class TerminalAdapter extends Adapter {
  readonly id = "terminal";
  /** "" means deliberately disabled; otherwise the explicit path, or null for the shared default. */
  private readonly explicitPath: string | null;
  private readonly cursor = new JsonlCursor();

  constructor(logPath?: string | null) {
    super();
    // `null` disables the source; an omitted argument falls back to the shared
    // default file once it exists, so passing an explicit path is never needed
    // just to pick up the producer's output.
    this.explicitPath = logPath === null ? "" : logPath ?? (process.env.PANTHER_TERMINAL_LOG?.trim() || null);
  }

  /**
   * The file this adapter will read right now. The shared default only counts
   * as configured once it exists, so a host that has never captured anything
   * reports "not configured" instead of silently following an empty room.
   */
  private logFilePath(): string | null {
    if (this.explicitPath === "") return null;
    if (this.explicitPath) return this.explicitPath;
    const fallback = terminalLogPath();
    return existsSync(fallback) ? fallback : null;
  }

  supports(): boolean {
    return this.logFilePath() !== null;
  }

  async capture(options?: IngestOptions): Promise<Observation[]> {
    const now = options?.now ?? new Date().toISOString();
    const path = this.logFilePath();
    if (!path) return [];
    const events = this.cursor.read(path);
    return events.map((event) => this.eventToObservation(event, now));
  }

  /** Push a terminal event programmatically (live capture integration). */
  inject(event: Record<string, unknown>, now?: string): Observation {
    return this.eventToObservation(event, now ?? new Date().toISOString());
  }

  /** Capture from stdin explicitly (caller pipes JSONL events into stdin). */
  async captureStdin(): Promise<Observation[]> {
    const now = new Date().toISOString();
    const events = await this.readStdinEvents();
    return events.map((event) => this.eventToObservation(event, now));
  }

  /** Start watching the log file for changes. Caller must call stopWatcher(). */
  watchLogFile(onChange: () => void): () => void {
    const path = this.logFilePath();
    if (!path) return () => {};
    const watcher = watch(path, () => onChange());
    return () => watcher.close();
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
