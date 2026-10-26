import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { SourceReadError, SourceReadiness } from "./adapter.js";

const MAX_READ = 1024 * 1024;
const MAX_LINE = 65536;
type ReadSnapshot = Omit<SourceReadiness, "id" | "configured">;

/** Bounded incremental JSONL reader; incomplete lines wait for their newline. */
export class JsonlCursor {
  private offset = 0;
  private identity = "";
  private remainder = Buffer.alloc(0);
  private discardingLine = false;
  private invalidSinceRecovery = false;
  private snapshot: ReadSnapshot = { state: "not-checked", lastAttemptAt: null, lastSuccessAt: null, lastEvidenceAt: null, recordsRead: 0, recordsSkipped: 0, partialLine: false, hasMore: false, error: null };

  /** A copy of the last actual read result. No filesystem work happens here. */
  status(): ReadSnapshot { return { ...this.snapshot }; }

  read(path: string, now = new Date().toISOString()): Record<string, unknown>[] {
    let fd: number | undefined;
    this.snapshot = { ...this.snapshot, lastAttemptAt: now, recordsRead: 0 };
    try {
      // Nonblocking open lets us reject FIFOs/devices without waiting for a writer.
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile()) { this.unavailable("not-file"); return []; }
      const identity = `${stat.dev}:${stat.ino}`;
      const reset = identity !== this.identity || stat.size < this.offset;
      if (reset) {
        this.offset = 0; this.remainder = Buffer.alloc(0); this.discardingLine = false; this.invalidSinceRecovery = false; this.identity = identity;
      }
      const buffer = Buffer.alloc(Math.min(MAX_READ, Math.max(0, stat.size - this.offset)));
      const size = readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += size;
      let incoming = buffer.subarray(0, size);
      if (this.discardingLine) {
        const newline = incoming.indexOf(10);
        if (newline < 0) incoming = Buffer.alloc(0);
        else { incoming = incoming.subarray(newline + 1); this.discardingLine = false; }
      }
      const bytes = Buffer.concat([this.remainder, incoming]);
      const records: Record<string, unknown>[] = [];
      let start = 0, skipped = 0;
      for (let newline = bytes.indexOf(10); newline >= 0; newline = bytes.indexOf(10, start)) {
        const line = bytes.subarray(start, newline); start = newline + 1;
        if (line.length > MAX_LINE) { skipped++; continue; }
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(line).trim();
          if (!text) continue;
          const value: unknown = JSON.parse(text);
          if (value && typeof value === "object" && !Array.isArray(value)) records.push(value as Record<string, unknown>);
          else skipped++;
        } catch { skipped++; }
      }
      this.remainder = Buffer.from(bytes.subarray(start));
      if (this.remainder.length > MAX_LINE) { this.remainder = Buffer.alloc(0); this.discardingLine = true; skipped++; }
      const partialLine = this.remainder.length > 0 || this.discardingLine;
      // Keep a malformed-data warning at EOF until valid data or a replaced /
      // truncated file establishes recovery. Another empty poll is not a repair.
      if (skipped) this.invalidSinceRecovery = true;
      else if (records.length) this.invalidSinceRecovery = false;
      const invalid = this.invalidSinceRecovery;
      this.snapshot = {
        state: invalid ? "invalid" : records.length ? "ready" : partialLine ? "partial" : "waiting",
        lastAttemptAt: now, lastSuccessAt: now,
        lastEvidenceAt: records.length ? now : this.snapshot.lastEvidenceAt,
        recordsRead: records.length,
        recordsSkipped: skipped || (invalid ? this.snapshot.recordsSkipped : 0),
        partialLine, hasMore: this.offset < stat.size, error: null,
      };
      return records;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.unavailable(code === "ENOENT" ? "missing" : code === "EACCES" || code === "EPERM" ? "permission" : "unreadable");
      return [];
    } finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* No source contents or paths in diagnostic output. */ } } }
  }

  private unavailable(error: SourceReadError): void {
    this.snapshot = { ...this.snapshot, state: "unavailable", recordsRead: 0, error };
  }
}
