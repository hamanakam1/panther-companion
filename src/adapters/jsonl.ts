import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Bounded incremental JSONL reader; partial lines wait for their newline. */
export class JsonlCursor {
  private offset = 0;
  private identity = "";
  private remainder = "";
  read(path: string): Record<string, unknown>[] {
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const stat = fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}`;
      if (identity !== this.identity || stat.size < this.offset) {
        this.offset = 0; this.remainder = ""; this.identity = identity;
      }
      const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(0, stat.size - this.offset)));
      const size = readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += size;
      const lines = (this.remainder + buffer.subarray(0, size).toString("utf8")).split(/\r?\n/);
      this.remainder = lines.pop() ?? "";
      if (this.remainder.length > 65536) this.remainder = "";
      return lines.flatMap(line => {
        if (line.length > 65536) return [];
        try { const value: unknown = JSON.parse(line); return value && typeof value === "object" && !Array.isArray(value) ? [value as Record<string, unknown>] : []; }
        catch { return []; }
      });
    } catch { return []; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
}
