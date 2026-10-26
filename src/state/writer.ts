import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * One process owns the local store; everyone else reads it.
 *
 * WHY THIS EXISTS. The panel and `serve` (and the MCP server) each opened
 * `~/.panther-companion/state.sqlite` read/write. WAL plus a 5s busy_timeout
 * was the only thing standing between two controllers and one file, and two
 * controllers can also open two follow sessions and two cards against the same
 * goal. A lock timeout is the wrong failure: it arrives after the user has
 * already acted.
 *
 * The lease is an ordinary file next to the database holding the owner's pid,
 * a token and a heartbeat. It is not a substitute for SQLite's own locking —
 * it is a declaration made before the first write, so a second writer can be
 * told to stop in words instead of discovering the problem as an error.
 */

export interface WriterHolder {
  /** Identity of the claim, so a stale owner can never delete its successor's lease. */
  token: string;
  pid: number;
  surface: string;
  startedAt: string;
  heartbeatAt: string;
}

export interface WriterClaim {
  /** True when this process may write to the store. */
  owned: boolean;
  /** Who holds it when `owned` is false. */
  holder: WriterHolder | null;
  /** Give the lease up (no-op when we do not own it). */
  release(): void;
  /** Rewrite the heartbeat now; called on an interval while owning. */
  heartbeat(): void;
}

/** A claim that stops beating for this long is considered abandoned. */
export const WRITER_STALE_MS = 30_000;
const BEAT_MS = 10_000;

export function writerLeasePath(dbPath: string): string {
  return `${dbPath}.writer`;
}

function readHolder(path: string): WriterHolder | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.pid !== "number" || typeof candidate.token !== "string") return null;
    return {
      token: candidate.token,
      pid: candidate.pid,
      surface: typeof candidate.surface === "string" ? candidate.surface : "unknown",
      startedAt: typeof candidate.startedAt === "string" ? candidate.startedAt : "",
      heartbeatAt: typeof candidate.heartbeatAt === "string" ? candidate.heartbeatAt : "",
    };
  } catch {
    return null;
  }
}

/** Whether the recorded owner is gone: dead pid, or a heartbeat older than the stale window. */
export function isHolderGone(holder: WriterHolder, now = Date.now()): boolean {
  if (!isProcessAlive(holder.pid)) return true;
  const beat = Date.parse(holder.heartbeatAt);
  return !Number.isFinite(beat) || now - beat > WRITER_STALE_MS;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as { code?: string }).code === "EPERM";
  }
}

/** Describe a holder for a message the user can act on. */
export function describeHolder(holder: WriterHolder): string {
  return `${holder.surface} (PID ${holder.pid}, since ${holder.startedAt || "an unknown time"})`;
}

function write(path: string, holder: WriterHolder): void {
  // Rename is atomic, so a concurrent reader never sees half a lease.
  const scratch = `${path}.${holder.token}.tmp`;
  writeFileSync(scratch, `${JSON.stringify(holder)}\n`, { mode: 0o600 });
  renameSync(scratch, path);
}

/**
 * Try to become the writer. Returns a claim either way: when `owned` is false
 * the caller must treat the store as read-only and can use `holder` to explain
 * exactly which process is in the way.
 */
export function claimWriter(dbPath: string, surface: string, now = () => Date.now()): WriterClaim {
  const path = writerLeasePath(dbPath);
  const token = randomUUID();
  const startedAt = new Date(now()).toISOString();
  const mine = (): WriterHolder => ({ token, pid: process.pid, surface, startedAt, heartbeatAt: new Date(now()).toISOString() });

  const take = (): boolean => {
    try {
      writeFileSync(path, `${JSON.stringify(mine())}\n`, { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      return false;
    }
  };

  const existing = readHolder(path);
  const reclaimable = existing === null || isHolderGone(existing, now());

  if (!(take() || (reclaimable && (rmSync(path, { force: true }), take())))) {
    const holder = readHolder(path);
    return { owned: false, holder, release() {}, heartbeat() {} };
  }

  let released = false;
  let beating: NodeJS.Timeout | null = null;
  const heartbeat = () => {
    if (released) return;
    const current = readHolder(path);
    // Never resurrect a lease that was taken over while we were slow.
    if (current && current.token !== token) { released = true; if (beating) clearInterval(beating); return; }
    write(path, mine());
  };
  beating = setInterval(heartbeat, BEAT_MS);
  beating.unref();
  const release = () => {
    if (released) return;
    released = true;
    if (beating) clearInterval(beating);
    const current = readHolder(path);
    if (current?.token === token) rmSync(path, { force: true });
  };
  return { owned: true, holder: null, release, heartbeat };
}

/**
 * Read the current owner without claiming. Used by read-only surfaces to name
 * the process they are waiting on.
 */
export function currentWriter(dbPath: string): WriterHolder | null {
  const holder = readHolder(writerLeasePath(dbPath));
  return holder && !isHolderGone(holder) ? holder : null;
}
