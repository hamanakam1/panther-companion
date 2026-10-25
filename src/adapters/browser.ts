import { JsonlCursor } from "./jsonl.js";
import { watch } from "node:fs";
import type { Observation, IngestOptions } from "../domain.js";
import { Adapter } from "./adapter.js";

/**
 * BrowserAdapter — focused tab, URL, title, selection, accessibility text
 * (inspired by Raycast Screen Awareness / Page Assist sidebar patterns).
 *
 * Reads JSONL capture lines from a log file. Each line may carry: url, title,
 * selection, accessibilityText, focusedAt, windowId.
 *
 * Set PANTHER_BROWSER_LOG to a JSONL path. Real macOS/Windows/Linux integration
 * would replace this file reader with the OS accessibility API; the observation
 * shape stays the same. In Electron, desktopCapturer can be used to enumerate
 * browser windows and feed them through inject().
 *
 * The adapter watches the log file incrementally for live capture.
 */
export class BrowserAdapter extends Adapter {
  readonly id = "browser";
  private readonly logPath: string | null;
  private readonly cursor = new JsonlCursor();

  constructor(logPath?: string | null) {
    super();
    this.logPath = logPath ?? process.env.PANTHER_BROWSER_LOG ?? null;
  }

  supports(): boolean {
    return Boolean(this.logPath);
  }

  async capture(options?: IngestOptions): Promise<Observation[]> {
    const now = options?.now ?? new Date().toISOString();
    const events = this.logPath ? this.readFileEvents() : [];
    return events.map((event) => this.eventToObservation(event, now));
  }

  /** Push a browser event programmatically (live capture integration). */
  inject(event: Record<string, unknown>, now?: string): Observation {
    return this.eventToObservation(event, now ?? new Date().toISOString());
  }

  /** Start watching the log file for changes. Caller must call stopWatcher(). */
  watchLogFile(onChange: () => void): () => void {
    if (!this.logPath) return () => {};
    const watcher = watch(this.logPath, () => onChange());
    return () => watcher.close();
  }

  private readFileEvents(): Array<Record<string, unknown>> {
    return this.cursor.read(this.logPath!);
  }

  private eventToObservation(
    event: Record<string, unknown>,
    now: string,
  ): Observation {
    const url = typeof event.url === "string" ? event.url : "";
    const title =
      typeof event.title === "string" && event.title.trim()
        ? event.title
        : url || "browser tab";
    const selection = typeof event.selection === "string" ? event.selection : "";
    const a11y = typeof event.accessibilityText === "string" ? event.accessibilityText : "";
    const summary = [
      title,
      selection ? `selection: ${selection}` : "",
      a11y ? `accessibility: ${a11y}` : "",
    ]
      .filter(Boolean)
      .join(" — ");
    return this.makeObservation({
      label: title,
      locator: url,
      summary,
      payload: event,
      signatureKey: `${url}|${title}|${event.focusedAt ?? now}`,
    });
  }
}
