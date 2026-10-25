import { readFileSync } from "node:fs";
import type { Observation, IngestOptions } from "../domain.js";
import { Adapter } from "./adapter.js";

/**
 * BrowserAdapter — focused tab, selection, accessibility text, URL, title
 * (inspired by Raycast Screen Awareness / Page Assist sidebar patterns).
 *
 * Reads JSONL capture lines from a log file. Each line may carry: url, title,
 * selection, accessibilityText, focusedAt, windowId.
 *
 * Set PANTHER_BROWSER_LOG to a JSONL path. Real macOS/Windows/Linux integration
 * would replace this file reader with the OS accessibility API; the observation
 * shape stays the same.
 */
export class BrowserAdapter extends Adapter {
  readonly id = "browser";
  private readonly logPath: string | null;

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
    const observations: Observation[] = [];
    for (const event of events) {
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
      observations.push(
        this.makeObservation({
          label: title,
          locator: url,
          summary,
          payload: event,
          signatureKey: `${url}|${title}|${event.focusedAt ?? now}`,
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
