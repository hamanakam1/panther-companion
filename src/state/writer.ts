import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface WriterHolder {
  token: string;
  pid: number;
  surface: string;
  startedAt: string;
  heartbeatAt: string;
  protocol?: "sqlite-lock-v1";
}

export interface WriterClaim {
  readonly owned: boolean;
  readonly holder: WriterHolder | null;
  /** Refuse a released claim or a claim for a different store. */
  assertOwned(dbPath: string): void;
  /** Call only after closing the writable store and finishing accepted actions. */
  release(): void;
  /** Diagnostic only. Heartbeat age never grants or removes write authority. */
  heartbeat(): void;
}

const BEAT_MS = 10_000;

function canonicalPath(dbPath: string): string {
  const absolute = resolve(dbPath);
  return existsSync(absolute) ? realpathSync(absolute) : join(realpathSync(dirname(absolute)), basename(absolute));
}

export function writerLeasePath(dbPath: string): string { return `${dbPath}.writer`; }

function readHolder(path: string): WriterHolder | null {
  try {
    const candidate = JSON.parse(readFileSync(path, "utf8")) as Partial<WriterHolder>;
    if (!candidate || !Number.isInteger(candidate.pid) || (candidate.pid ?? 0) <= 0 || typeof candidate.token !== "string") return null;
    return {
      token: candidate.token, pid: candidate.pid!,
      surface: typeof candidate.surface === "string" ? candidate.surface : "unknown",
      startedAt: typeof candidate.startedAt === "string" ? candidate.startedAt : "",
      heartbeatAt: typeof candidate.heartbeatAt === "string" ? candidate.heartbeatAt : "",
      ...(candidate.protocol === "sqlite-lock-v1" ? { protocol: candidate.protocol } : {}),
    };
  } catch { return null; }
}

/** Only process death is evidence of abandonment; a stalled live host remains the owner. */
export function isHolderGone(holder: WriterHolder): boolean {
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return true;
  if (holder.pid === process.pid) return false;
  try { process.kill(holder.pid, 0); return false; }
  catch (error) { return (error as { code?: string }).code !== "EPERM"; }
}

export function describeHolder(holder: WriterHolder): string {
  return `${holder.surface} (PID ${holder.pid}, since ${holder.startedAt || "an unknown time"})`;
}

function writeMetadata(path: string, holder: WriterHolder): void {
  const scratch = `${path}.${holder.token}.tmp`;
  try {
    writeFileSync(scratch, `${JSON.stringify(holder)}\n`, { mode: 0o600 });
    renameSync(scratch, path);
  } finally { rmSync(scratch, { force: true }); }
}

function refused(holder: WriterHolder | null, reason?: string): WriterClaim {
  return {
    owned: false, holder,
    assertOwned() { throw new Error(reason ?? `Another Companion surface owns this store${holder ? `: ${describeHolder(holder)}` : ""}. Use that surface, or quit it before trying again.`); },
    release() {}, heartbeat() {},
  };
}

/**
 * A separate SQLite file holds a BEGIN IMMEDIATE transaction for the entire
 * writer lifetime. The operating system releases its lock when the process
 * dies. No TTL, PID guess, metadata unlink or heartbeat can steal a live lock.
 * The .writer JSON file names the owner for diagnostics; it is not authority.
 * Never delete the arbitration database while a host may be running.
 */
export function claimWriter(dbPath: string, surface: string, now = () => Date.now()): WriterClaim {
  mkdirSync(dirname(resolve(dbPath)), { recursive: true, mode: 0o700 });
  const canonical = canonicalPath(dbPath);
  const metadataPath = writerLeasePath(canonical);
  const lockPath = `${canonical}.writer-lock.sqlite`;
  const lock = new DatabaseSync(lockPath);
  try {
    chmodSync(lockPath, 0o600);
    lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
  } catch (error) {
    lock.close();
    const code = (error as { errcode?: number }).errcode;
    if (code === 5 || code === 6) return refused(readHolder(metadataPath));
    throw error;
  }

  // A still-running pre-arbitration release has only the old JSON claim. Do
  // not overlap it during an upgrade, even if its heartbeat is old.
  const previous = readHolder(metadataPath);
  if (!previous && existsSync(metadataPath)) {
    lock.exec("ROLLBACK;"); lock.close();
    return refused(null, "The existing Companion writer record cannot be verified. Quit older Companion hosts and review the .writer record before starting a new writer.");
  }
  if (previous && previous.protocol !== "sqlite-lock-v1" && !isHolderGone(previous)) {
    lock.exec("ROLLBACK;"); lock.close();
    return refused(previous);
  }

  const token = randomUUID();
  const startedAt = new Date(now()).toISOString();
  const mine = (): WriterHolder => ({ token, pid: process.pid, surface, startedAt, heartbeatAt: new Date(now()).toISOString(), protocol: "sqlite-lock-v1" });
  try { writeMetadata(metadataPath, mine()); }
  catch (error) { lock.exec("ROLLBACK;"); lock.close(); throw error; }
  let released = false;
  const heartbeat = () => {
    if (released) return;
    // Diagnostics failure cannot revoke the SQLite lock or crash a live host.
    try { writeMetadata(metadataPath, mine()); } catch { /* keep authority until close */ }
  };
  const timer = setInterval(heartbeat, BEAT_MS);
  timer.unref();
  return {
    get owned() { return !released; }, holder: null,
    assertOwned(path) {
      if (released || canonicalPath(path) !== canonical) throw new Error("This Companion writer claim is closed or belongs to another store.");
    },
    heartbeat,
    release() {
      if (released) return;
      released = true; clearInterval(timer);
      // Remove only our diagnostic record while the authoritative lock is
      // still held. A successor cannot claim between this check and removal.
      try { if (readHolder(metadataPath)?.token === token) rmSync(metadataPath, { force: true }); }
      finally { try { lock.exec("ROLLBACK;"); } finally { lock.close(); } }
    },
  };
}

/** Best-effort diagnostic identity only; claimWriter is the authority check. */
export function currentWriter(dbPath: string): WriterHolder | null {
  try { const holder = readHolder(writerLeasePath(canonicalPath(dbPath))); return holder && !isHolderGone(holder) ? holder : null; }
  catch { return null; }
}
