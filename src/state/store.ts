import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { defaultPreferences } from "../config.js";
import type {
  Explanation,
  FeedbackKind,
  GateFactors,
  GateLog,
  Goal,
  Insight,
  InsightStatus,
  Observation,
  OpenQuestion,
  Preferences,
  Session,
  SurfaceCard,
} from "../domain.js";
import { unsetGoal } from "../core/goal.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  label TEXT NOT NULL,
  locator TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  signature TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS explanations (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS insights (
  id TEXT PRIMARY KEY,
  group_key TEXT NOT NULL,
  status TEXT NOT NULL,
  explanation_id TEXT,
  observation_ids TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS insight_signatures (
  insight_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  PRIMARY KEY (insight_id, signature)
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  observation_ids TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  insight_id TEXT,
  topic TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gate_log (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  mode TEXT NOT NULL,
  score REAL NOT NULL,
  factors TEXT NOT NULL,
  suppress INTEGER NOT NULL,
  reason TEXT NOT NULL,
  observation_ids TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS durable_memory (
  id TEXT PRIMARY KEY,
  insight_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_sig ON observations(signature);
CREATE INDEX IF NOT EXISTS idx_insights_group ON insights(group_key, status);
CREATE INDEX IF NOT EXISTS idx_sig ON insight_signatures(signature);
CREATE TABLE IF NOT EXISTS observation_goals (observation_id TEXT NOT NULL, goal_id TEXT NOT NULL, PRIMARY KEY (observation_id, goal_id));
CREATE TABLE IF NOT EXISTS explanation_goals (explanation_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS insight_goals (insight_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL);
`;

export class Store {
  private transactionActive = false;
  constructor(private readonly db: DatabaseSync, readonly readOnly = false) {
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    // A read-only connection cannot set the journal mode or create tables, and
    // must not try: it attaches to a store another process is already writing.
    if (!readOnly) {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec(SCHEMA);
    }
  }

  /**
   * `readOnly` attaches without any write, for a surface that lost the writer
   * lease. Writes then fail at SQLite, which is the point: the owner is the
   * only writer.
   */
  static open(path: string, options: { readOnly?: boolean } = {}): Store {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const readOnly = options.readOnly === true;
    if (!readOnly) return new Store(new DatabaseSync(path));
    try {
      return new Store(new DatabaseSync(path, { readOnly: true }), true);
    } catch {
      // Nothing to attach to yet: say so in terms the user can act on, rather
      // than surfacing SQLite's "unable to open database file".
      throw new Error(`Nothing to read at ${path}. Start the surface that owns the store first.`);
    }
  }

  static memory(): Store {
    return new Store(new DatabaseSync(":memory:"));
  }

  close(): void {
    this.db.close();
  }

  getGoal(now: string): Goal {
    const stored = this.meta<Goal>("goal");
    if (stored) return stored;
    const goal = unsetGoal(now);
    // Reading must not become a write on an attached read-only surface.
    if (this.readOnly) return goal;
    this.saveGoal(goal);
    return goal;
  }

  saveGoal(goal: Goal): void {
    this.transaction(() => { this.invalidate(); this.setMeta("goal", goal); });
  }

  stateRevision(): string { return this.meta<string>("state_revision") ?? "initial"; }
  invalidate(): void { this.setMeta("state_revision", randomUUID()); }

  goalState(now: string): { goal: Goal; revision: string } {
    this.getGoal(now);
    const row = this.db.prepare("SELECT (SELECT value FROM meta WHERE key = 'goal') AS goal, (SELECT value FROM meta WHERE key = 'state_revision') AS revision").get()!;
    return { goal: JSON.parse(String(row.goal)) as Goal, revision: row.revision ? JSON.parse(String(row.revision)) as string : "initial" };
  }

  withStateRevision<T>(revision: string, action: () => T): T | null {
    return this.transaction(() => this.stateRevision() === revision ? action() : null);
  }

  transaction<T>(action: () => T): T {
    if (this.transactionActive) return action();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionActive = true;
    try {
      const result = action(); this.db.exec("COMMIT"); return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    finally { this.transactionActive = false; }
  }

  getPreferences(): Preferences {
    return this.meta<Preferences>("preferences") ?? defaultPreferences();
  }

  savePreferences(prefs: Preferences): void {
    this.transaction(() => {
      this.invalidate();
      const known = prefs.knownSignatures.slice(-200);
      this.setMeta("preferences", { ...prefs, knownSignatures: known });
    });
  }

  getSession(): Session | null {
    return this.meta<Session>("session");
  }

  saveSession(session: Session | null): void {
    this.transaction(() => {
      this.invalidate();
      if (!session) this.db.prepare("DELETE FROM meta WHERE key = ?").run("session");
      else this.setMeta("session", session);
    });
  }

  getLive(): SurfaceCard | null {
    return this.meta<SurfaceCard>("live_card");
  }

  setLive(card: SurfaceCard | null): void {
    if (!card) this.db.prepare("DELETE FROM meta WHERE key = ?").run("live_card");
    else this.setMeta("live_card", card);
  }

  setPendingRaise(value: boolean): void {
    this.setMeta("pending_raise", value);
  }

  consumePendingRaise(): boolean {
    const pending = this.meta<boolean>("pending_raise") === true;
    if (pending) this.setMeta("pending_raise", false);
    return pending;
  }

  insertObservation(obs: Observation, goalId?: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO observations
      (id, provider_id, captured_at, label, locator, summary, payload, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      obs.id,
      obs.providerId,
      obs.capturedAt,
      obs.label,
      obs.locator,
      obs.summary,
      JSON.stringify(obs.payload),
      obs.signature,
    );
    this.db.prepare("INSERT OR IGNORE INTO observation_goals (observation_id, goal_id) VALUES (?, ?)").run(obs.id, goalId ?? this.getGoal(obs.capturedAt).id);
  }

  getObservations(ids: string[]): Observation[] {
    if (ids.length === 0) return [];
    const marks = ids.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT * FROM observations WHERE id IN (${marks})`).all(...ids);
    const byId = new Map(rows.map((row) => {
      const obs = rowToObservation(row);
      return [obs.id, obs] as const;
    }));
    return ids.flatMap((id) => {
      const obs = byId.get(id);
      return obs ? [obs] : [];
    });
  }

  latestObservations(limit = 25): Observation[] {
    const goal = this.meta<Goal>("goal");
    return this.db.prepare("SELECT observations.* FROM observations JOIN observation_goals ON observation_goals.observation_id = observations.id WHERE observation_goals.goal_id = ? ORDER BY captured_at DESC, observations.rowid DESC LIMIT ?").all(goal?.id ?? "", limit).map(rowToObservation).reverse();
  }

  recentSummaries(limit: number): string[] {
    const rows = this.db.prepare(
      "SELECT body FROM explanations JOIN explanation_goals ON explanation_goals.explanation_id = explanations.id WHERE explanation_goals.goal_id = ? ORDER BY created_at DESC LIMIT ?",
    ).all(this.meta<Goal>("goal")?.id ?? "", limit);
    return rows.flatMap((row) => {
      const record = asObject(row);
      if (!record || typeof record.body !== "string") return [];
      const body = JSON.parse(record.body) as Explanation;
      return [body.whatItMeans];
    });
  }

  saveExplanation(explanation: Explanation): void {
    this.db.prepare("INSERT OR REPLACE INTO explanations (id, body, created_at) VALUES (?, ?, ?)").run(
      explanation.id,
      JSON.stringify(explanation),
      explanation.createdAt,
    );
    this.db.prepare("INSERT OR REPLACE INTO explanation_goals (explanation_id, goal_id) VALUES (?, ?)").run(explanation.id, this.getGoal(explanation.createdAt).id);
  }

  getExplanation(id: string): Explanation | null {
    const row = asObject(this.db.prepare("SELECT body FROM explanations WHERE id = ?").get(id));
    if (!row || typeof row.body !== "string") return null;
    return JSON.parse(row.body) as Explanation;
  }

  insertInsight(insight: Insight, signatures: string[]): void {
    this.db.prepare(`
      INSERT INTO insights
      (id, group_key, status, explanation_id, observation_ids, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      insight.id,
      insight.groupKey,
      insight.status,
      insight.explanationId,
      JSON.stringify(insight.observationIds),
      insight.expiresAt,
      insight.createdAt,
      insight.updatedAt,
    );
    this.replaceSignatures(insight.id, signatures);
    this.db.prepare("INSERT OR REPLACE INTO insight_goals (insight_id, goal_id) VALUES (?, ?)").run(insight.id, this.getGoal(insight.createdAt).id);
  }

  updateInsight(insight: Insight, signatures: string[]): void {
    this.db.prepare(`
      UPDATE insights
      SET group_key = ?, status = ?, explanation_id = ?, observation_ids = ?, expires_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      insight.groupKey,
      insight.status,
      insight.explanationId,
      JSON.stringify(insight.observationIds),
      insight.expiresAt,
      insight.updatedAt,
      insight.id,
    );
    this.replaceSignatures(insight.id, signatures);
  }

  getInsight(id: string): Insight | null {
    return rowToInsight(asObject(this.db.prepare("SELECT * FROM insights WHERE id = ?").get(id)));
  }

  findActiveBySignature(signatures: string[], now: string): Insight | null {
    if (signatures.length === 0) return null;
    const marks = signatures.map(() => "?").join(", ");
    const row = this.db.prepare(`
      SELECT insights.* FROM insights
      JOIN insight_signatures ON insight_signatures.insight_id = insights.id
      JOIN insight_goals ON insight_goals.insight_id = insights.id
      WHERE insight_signatures.signature IN (${marks})
        AND insight_goals.goal_id = ?
        AND insights.status = 'transient'
        AND insights.expires_at > ?
      ORDER BY insights.updated_at DESC
      LIMIT 1
    `).get(...signatures, this.meta<Goal>("goal")?.id ?? "", now);
    return rowToInsight(asObject(row));
  }

  signaturesFor(insightId: string): string[] {
    const rows = this.db.prepare("SELECT signature FROM insight_signatures WHERE insight_id = ?").all(insightId);
    return rows.flatMap((row) => {
      const record = asObject(row);
      return record && typeof record.signature === "string" ? [record.signature] : [];
    });
  }

  expireInsight(id: string, now: string): void {
    this.db.prepare("UPDATE insights SET status = 'expired', updated_at = ? WHERE id = ?").run(now, id);
  }

  expireDue(now: string): void {
    this.db.prepare(
      "UPDATE insights SET status = 'expired', updated_at = ? WHERE status = 'transient' AND expires_at <= ?",
    ).run(now, now);
    const live = this.getLive();
    if (live && this.getInsight(live.insightId)?.status === "expired") this.setLive(null);
  }

  expireFailuresForCommand(commandSignature: string, now: string): string[] {
    const failSignature = commandSignature.replace(/^term-ok:/, "term-fail:");
    const rows = this.db.prepare(`
      SELECT insights.id FROM insights
      JOIN insight_signatures ON insight_signatures.insight_id = insights.id
      WHERE insights.status = 'transient' AND insight_signatures.signature LIKE ?
    `).all(`${failSignature}%`);
    const ids: string[] = [];
    for (const row of rows) {
      const record = asObject(row);
      if (!record || typeof record.id !== "string") continue;
      this.expireInsight(record.id, now);
      ids.push(record.id);
    }
    return ids;
  }

  listInsights(status?: InsightStatus): Insight[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM insights WHERE status = ? ORDER BY updated_at DESC").all(status)
      : this.db.prepare("SELECT * FROM insights ORDER BY updated_at DESC").all();
    return rows.flatMap((row) => {
      const insight = rowToInsight(asObject(row));
      return insight ? [insight] : [];
    });
  }

  countInsights(): Record<InsightStatus, number> {
    const counts: Record<InsightStatus, number> = { transient: 0, expired: 0, promoted: 0 };
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM insights GROUP BY status").all();
    for (const row of rows) {
      const record = asObject(row);
      if (!record) continue;
      const status = record.status;
      const n = record.n;
      if ((status === "transient" || status === "expired" || status === "promoted") && typeof n === "number") {
        counts[status] = n;
      }
    }
    return counts;
  }

  insertQuestion(question: OpenQuestion): void {
    const existing = this.listOpenQuestions().find((item) => item.text === question.text);
    if (existing) return;
    this.db.prepare(`
      INSERT INTO questions (id, text, observation_ids, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      question.id,
      question.text,
      JSON.stringify(question.observationIds),
      question.status,
      question.createdAt,
      question.updatedAt,
    );
  }

  listOpenQuestions(): OpenQuestion[] {
    const rows = this.db.prepare("SELECT * FROM questions WHERE status = 'open' ORDER BY created_at ASC").all();
    return rows.flatMap((row) => {
      const question = rowToQuestion(asObject(row));
      return question ? [question] : [];
    });
  }

  briefQuestions(now: string): void {
    this.db.prepare("UPDATE questions SET status = 'briefed', updated_at = ? WHERE status = 'open'").run(now);
  }

  insertFeedback(kind: FeedbackKind, insightId: string | null, topic: string | null, now: string): void {
    this.db.prepare(
      "INSERT INTO feedback (id, kind, insight_id, topic, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(randomUUID(), kind, insightId, topic, now);
  }

  insertGateLog(entry: GateLog): void {
    this.db.prepare(`
      INSERT INTO gate_log (id, created_at, mode, score, factors, suppress, reason, observation_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.createdAt,
      entry.mode,
      entry.score,
      JSON.stringify(entry.factors),
      entry.suppress ? 1 : 0,
      entry.reason,
      JSON.stringify(entry.observationIds),
    );
  }

  listGateLogs(limit: number): GateLog[] {
    const rows = this.db.prepare("SELECT * FROM gate_log ORDER BY created_at DESC LIMIT ?").all(limit);
    return rows.flatMap((row) => {
      const record = asObject(row);
      if (!record) return [];
      const factors = JSON.parse(String(record.factors)) as GateFactors;
      return [{
        id: String(record.id),
        createdAt: String(record.created_at),
        mode: String(record.mode),
        score: Number(record.score),
        factors,
        suppress: Number(record.suppress) === 1,
        reason: String(record.reason),
        observationIds: JSON.parse(String(record.observation_ids)) as string[],
      }];
    });
  }

  promote(insight: Insight, explanation: Explanation, now: string): void {
    this.db.prepare(
      "INSERT INTO durable_memory (id, insight_id, body, created_at) VALUES (?, ?, ?, ?)",
    ).run(randomUUID(), insight.id, JSON.stringify({ insight, explanation }), now);
    this.db.prepare("UPDATE insights SET status = 'promoted', updated_at = ? WHERE id = ?").run(now, insight.id);
  }

  listDurable(): { id: string; insightId: string; createdAt: string }[] {
    const rows = this.db.prepare("SELECT id, insight_id, created_at FROM durable_memory ORDER BY created_at DESC").all();
    return rows.flatMap((row) => {
      const record = asObject(row);
      if (!record) return [];
      return [{ id: String(record.id), insightId: String(record.insight_id), createdAt: String(record.created_at) }];
    });
  }

  exportAll(): Record<string, unknown> {
    return {
      goal: this.meta("goal"),
      preferences: this.getPreferences(),
      session: this.getSession(),
      live: this.getLive(),
      observations: this.db.prepare("SELECT * FROM observations").all(),
      observationGoals: this.db.prepare("SELECT * FROM observation_goals").all(),
      insightGoals: this.db.prepare("SELECT * FROM insight_goals").all(),
      explanations: this.db.prepare("SELECT * FROM explanations").all(),
      insights: this.listInsights(),
      questions: this.db.prepare("SELECT * FROM questions").all(),
      feedback: this.db.prepare("SELECT * FROM feedback").all(),
      gateLog: this.listGateLogs(500),
      durableMemory: this.listDurable(),
    };
  }

  deleteAll(now: string): void {
    this.transaction(() => {
      for (const table of [
        "durable_memory",
        "gate_log",
        "feedback",
        "questions",
        "insight_signatures",
        "insights",
        "explanations",
        "observations",
        "observation_goals",
        "explanation_goals",
        "insight_goals",
        "meta",
      ]) {
        this.db.exec(`DELETE FROM ${table}`);
      }
      this.saveGoal(unsetGoal(now));
      this.savePreferences(defaultPreferences());
    });
  }

  private replaceSignatures(insightId: string, signatures: string[]): void {
    this.db.prepare("DELETE FROM insight_signatures WHERE insight_id = ?").run(insightId);
    const insert = this.db.prepare("INSERT OR IGNORE INTO insight_signatures (insight_id, signature) VALUES (?, ?)");
    for (const signature of [...new Set(signatures)]) insert.run(insightId, signature);
  }

  private meta<T>(key: string): T | null {
    const row = asObject(this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key));
    if (!row || typeof row.value !== "string") return null;
    return JSON.parse(row.value) as T;
  }

  private setMeta(key: string, value: unknown): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function rowToObservation(value: unknown): Observation {
  const row = asObject(value);
  if (!row) throw new Error("Missing observation row");
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    capturedAt: String(row.captured_at),
    label: String(row.label),
    locator: String(row.locator),
    summary: String(row.summary),
    payload: JSON.parse(String(row.payload)),
    signature: String(row.signature),
  };
}

function rowToInsight(row: Record<string, unknown> | null): Insight | null {
  if (!row) return null;
  const status = row.status;
  if (status !== "transient" && status !== "expired" && status !== "promoted") return null;
  return {
    id: String(row.id),
    groupKey: String(row.group_key),
    status,
    explanationId: row.explanation_id == null ? null : String(row.explanation_id),
    observationIds: JSON.parse(String(row.observation_ids)) as string[],
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToQuestion(row: Record<string, unknown> | null): OpenQuestion | null {
  if (!row) return null;
  const status = row.status === "briefed" ? "briefed" : "open";
  return {
    id: String(row.id),
    text: String(row.text),
    observationIds: JSON.parse(String(row.observation_ids)) as string[],
    status,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
