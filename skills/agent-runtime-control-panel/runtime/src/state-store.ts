import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { State, ChannelEvent } from './arcp.js';
import { contentAddress, normalizeChannelEvent } from './content.js';

/** The application-facing persistence seam. Implementations own their storage format. */
export interface StateStore {
  readonly file: string;
  init(): Promise<void>;
  snapshot(): State;
  mutate<T>(fn: (state: State) => T): Promise<T>;
  prune?(maxRows?: number): Promise<void>;
}

export interface DatabaseStatus {
  path: string;
  schemaVersion: number;
  journalMode: string;
  foreignKeys: number;
  busyTimeout: number;
  observations: number;
  tables: Record<string, number>;
  mode: string;
}

export interface DatabaseCheck extends DatabaseStatus {
  quickCheck: string;
  integrityCheck: string;
}

export interface DatabaseExport {
  exportedAt: string;
  kind?: string;
  since?: string;
  events: Array<Record<string, unknown>>;
  knowledge: Array<Record<string, unknown>>;
  results: Array<Record<string, unknown>>;
}

export interface ImportReport {
  imported: boolean;
  noop: boolean;
  sources: Array<{ file: string; records: number; contentHash: string; importedRecords: number; importedHash: string; match: boolean }>;
  state: { records: number; contentHash: string; importedRecords: number; importedHash: string; match: boolean };
}

type SqliteRow = Record<string, unknown>;
const OBSERVATION_LIMIT = 100;
const emptyState = (): State => ({ actors: [], bindings: [], credentials: {}, workspaces: [], members: [], memberCredentials: {}, tasks: [], knowledge: [], results: [], goals: [], sessions: [], deliveries: [], channelEvents: [], confirmations: [] });
const json = (value: unknown): string => JSON.stringify(value);
const parse = <T>(value: unknown, fallback: T): T => { try { return value === null || value === undefined ? fallback : JSON.parse(String(value)) as T; } catch { return fallback; } };
const hash = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/**
 * Return the exact state shape that is allowed to cross the persistence seam.
 * Keep this as the one redaction/normalization transform used by persistence,
 * import expectations, and read-back verification.
 */
function postRedactionState(value: Partial<State>): State {
  const state = { ...emptyState(), ...value } as State;
  // Credentials are deliberately process-local. They are accepted by the JSON
  // compatibility store, but never copied into SQLite.
  state.credentials = {};
  state.memberCredentials = {};
  state.sessions = state.sessions.map((session) => {
    const { workspace: _workspace, ...durable } = session;
    return durable;
  });
  state.deliveries = state.deliveries.map((delivery) => ({ ...delivery, body: '' }));
  state.channelEvents = state.channelEvents.map((event) => normalizeChannelEvent(event as unknown as Record<string, unknown>));
  return state;
}

const MIGRATIONS: Array<[number, string]> = [
  [1, `
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS content (id TEXT PRIMARY KEY, content_hash TEXT NOT NULL UNIQUE, summary TEXT NOT NULL, evidence_refs TEXT NOT NULL, sensitivity TEXT NOT NULL, retention TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS event_journal (event_id TEXT PRIMARY KEY, workspace_id TEXT, goal_id TEXT, task_id TEXT, result_id TEXT, source_member_id TEXT, source_actor_id TEXT, target_member_id TEXT, target_actor_id TEXT, target_role TEXT, target_subscription TEXT, kind TEXT NOT NULL, urgency TEXT NOT NULL, decision_required INTEGER NOT NULL, content_id TEXT REFERENCES content(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS event_transitions (event_id TEXT NOT NULL REFERENCES event_journal(event_id) ON DELETE CASCADE, state TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(event_id, state, at));
    CREATE TABLE IF NOT EXISTS channel_events (event_id TEXT PRIMARY KEY REFERENCES event_journal(event_id), envelope TEXT NOT NULL, content_id TEXT REFERENCES content(id), delivery_state TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT, processed_at TEXT, acknowledged_at TEXT, undeliverable_reason TEXT, related_event_id TEXT);
    CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS actors (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS actor_bindings (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtimes (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS confirmations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS knowledge (id TEXT PRIMARY KEY, workspace_id TEXT, content_id TEXT REFERENCES content(id), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS results (id TEXT PRIMARY KEY, workspace_id TEXT, content_id TEXT REFERENCES content(id), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_observations (id INTEGER PRIMARY KEY AUTOINCREMENT, runtime_id TEXT NOT NULL, observed_at TEXT NOT NULL, snapshot TEXT NOT NULL, snapshot_hash TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS runtime_observations_runtime_idx ON runtime_observations(runtime_id, id);
    CREATE TABLE IF NOT EXISTS legacy_reminders (source_file TEXT NOT NULL, record_index INTEGER NOT NULL, record_hash TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, imported_at TEXT NOT NULL, PRIMARY KEY(source_file, record_index));
    CREATE INDEX IF NOT EXISTS legacy_reminders_hash_idx ON legacy_reminders(record_hash);
    CREATE TABLE IF NOT EXISTS migration_audit (source_file TEXT NOT NULL, source_hash TEXT NOT NULL, imported_at TEXT NOT NULL, report TEXT NOT NULL, PRIMARY KEY(source_file, source_hash));
  `],
];

export function resolveDatabasePath(dirOrFile: string): string {
  return dirOrFile.endsWith('.sqlite') || dirOrFile.endsWith('.db') ? dirOrFile : path.join(dirOrFile, 'arcp-state.sqlite');
}

const projection = (state: Partial<State>) => {
  const durable = postRedactionState(state);
  return {
    actors: durable.actors,
    bindings: durable.bindings,
    workspaces: durable.workspaces,
    members: durable.members,
    goals: durable.goals,
    tasks: durable.tasks,
    sessions: durable.sessions,
    deliveries: durable.deliveries,
    knowledge: durable.knowledge,
    results: durable.results,
    channelEvents: durable.channelEvents,
    confirmations: durable.confirmations,
  };
};
type StateProjection = ReturnType<typeof projection>;
const projectionRecords = (value: StateProjection): number => Object.values(value).reduce((count, records) => count + records.length, 0);

function firstDifference(expected: unknown, actual: unknown, at = 'state'): string {
  return findDifference(expected, actual, at) ?? `${at}: values are equal`;
}

function findDifference(expected: unknown, actual: unknown, at: string): string | undefined {
  if (Object.is(expected, actual)) return undefined;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return `${at}: expected ${describeValue(expected)}, actual ${describeValue(actual)}`;
    if (expected.length !== actual.length) return `${at}.length: expected ${expected.length}, actual ${actual.length}`;
    for (let index = 0; index < expected.length; index += 1) {
      const difference = findDifference(expected[index], actual[index], `${at}[${index}]`);
      if (difference) return difference;
    }
    return undefined;
  }
  if ((expected && typeof expected === 'object') || (actual && typeof actual === 'object')) {
    if (!expected || typeof expected !== 'object' || !actual || typeof actual !== 'object') return `${at}: expected ${describeValue(expected)}, actual ${describeValue(actual)}`;
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(expected, key)) return `${at}.${key}: expected <absent>, actual ${describeValue((actual as Record<string, unknown>)[key])}`;
      if (!Object.prototype.hasOwnProperty.call(actual, key)) return `${at}.${key}: expected ${describeValue((expected as Record<string, unknown>)[key])}, actual <absent>`;
      const difference = findDifference((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], `${at}.${key}`);
      if (difference) return difference;
    }
    return undefined;
  }
  return `${at}: expected ${describeValue(expected)}, actual ${describeValue(actual)}`;
}

function describeValue(value: unknown): string {
  let rendered: string;
  try { rendered = stableJson(value) ?? String(value); } catch { rendered = String(value); }
  return rendered.length > 240 ? `${rendered.slice(0, 237)}...` : rendered;
}

function verificationError(scope: string, expectedRecords: number, expectedHash: string, actualRecords: number, actualHash: string, expected: unknown, actual: unknown): Error {
  return new Error(`legacy import verification failed${scope ? ` for ${scope}` : ''}: expected ${expectedRecords} records (hash ${expectedHash}), actual ${actualRecords} records (hash ${actualHash}); first difference: ${firstDifference(expected, actual)}`);
}

export class SQLiteStateStore implements StateStore {
  readonly file: string;
  private db?: DatabaseSync;
  private state: State = emptyState();
  private write: Promise<unknown> = Promise.resolve();

  constructor(dirOrFile: string) {
    this.file = resolveDatabasePath(dirOrFile);
  }

  private get connection(): DatabaseSync {
    if (!this.db) throw new Error('SQLite StateStore is not initialized');
    return this.db;
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    await chmod(this.file, 0o600);
    const db = this.connection;
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    // These CREATEs are repeated outside the numbered migration so a database
    // created by an earlier schema-1 build gains the import projection too.
    db.exec('CREATE TABLE IF NOT EXISTS legacy_reminders (source_file TEXT NOT NULL, record_index INTEGER NOT NULL, record_hash TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, imported_at TEXT NOT NULL, PRIMARY KEY(source_file, record_index)); CREATE INDEX IF NOT EXISTS legacy_reminders_hash_idx ON legacy_reminders(record_hash); CREATE TABLE IF NOT EXISTS confirmations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);');
    // These objects were never populated by the SQLite projection. Remove
    // leftovers from pre-release databases while keeping runtime observations
    // and all durable ARCP projections intact.
    db.exec('DROP TABLE IF EXISTS corrections; DROP TABLE IF EXISTS gates; DROP INDEX IF EXISTS event_journal_workspace_idx; DROP INDEX IF EXISTS event_journal_kind_idx;');
    // Keep the historical name queryable for tooling that used the first
    // migration draft, while storing the richer projection in legacy_reminders.
    try { db.exec('DROP VIEW IF EXISTS legacy_records'); } catch { /* an old table with this name is left untouched */ }
    try { db.exec('CREATE VIEW IF NOT EXISTS legacy_records AS SELECT source_file, record_index, record_hash, kind, payload, imported_at FROM legacy_reminders'); } catch { /* an old table already supplies the compatibility name */ }
    const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as SqliteRow[]).map((row) => Number(row.version)));
    for (const [version, sql] of MIGRATIONS) {
      if (applied.has(version)) continue;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    this.state = this.loadState();
  }

  snapshot(): State { return structuredClone(this.state); }

  async mutate<T>(fn: (state: State) => T): Promise<T> {
    let result!: T;
    const operation = this.write.catch(() => undefined).then(() => {
      const before = structuredClone(this.state);
      try {
        result = fn(this.state);
        this.persist(this.state);
        return result;
      } catch (error) {
        this.state = before;
        throw error;
      }
    });
    this.write = operation.catch(() => undefined);
    await operation;
    return result;
  }

  /** Serialize operations that include their own transaction (for example a
   * source import) with ordinary state mutations. */
  private enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
    const operation = this.write.catch(() => undefined).then(fn);
    this.write = operation.catch(() => undefined);
    return operation;
  }

  async prune(maxRows = 200): Promise<void> {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new Error('prune maxRows must be a positive integer');
    await this.mutate((state) => {
      const deliveries = [...state.deliveries].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const removedEvents = new Set(deliveries.slice(maxRows).map((item) => item.eventId).filter((id): id is string => Boolean(id)));
      state.deliveries = deliveries.slice(0, maxRows);
      state.channelEvents = state.channelEvents.filter((event) => !removedEvents.has(event.id));
    });
  }

  close(): void { this.db?.close(); this.db = undefined; }

  private loadState(): State {
    const db = this.connection;
    const rows = (name: string) => (db.prepare(`SELECT payload FROM ${name}`).all() as SqliteRow[]).map((row) => parse<Record<string, unknown>>(row.payload, {}));
    const content = new Map((db.prepare('SELECT id, summary, evidence_refs, content_hash, sensitivity, retention FROM content').all() as SqliteRow[]).map((row) => [String(row.id), { summary: String(row.summary), evidenceRefs: parse<string[]>(row.evidence_refs, []), contentHash: String(row.content_hash), sensitivity: String(row.sensitivity) as 'normal' | 'sensitive', retention: String(row.retention) as 'standard' | 'bounded' }]));
    const channelEvents = (db.prepare('SELECT * FROM channel_events').all() as SqliteRow[]).map((row) => {
      const event = parse<Record<string, unknown>>(row.envelope, {});
      const transitions = (db.prepare('SELECT state, at FROM event_transitions WHERE event_id = ? ORDER BY rowid').all(String(row.event_id)) as SqliteRow[]).map((item) => ({ state: String(item.state), at: String(item.at) }));
      return { ...event, id: String(row.event_id), content: content.get(String(row.content_id)) ?? { summary: '', evidenceRefs: [], contentHash: '', sensitivity: 'normal', retention: 'standard' }, deliveryState: String(row.delivery_state), transitions, createdAt: String(row.created_at), ...(row.delivered_at ? { deliveredAt: String(row.delivered_at) } : {}), ...(row.processed_at ? { processedAt: String(row.processed_at) } : {}), ...(row.acknowledged_at ? { acknowledgedAt: String(row.acknowledged_at) } : {}), ...(row.undeliverable_reason ? { undeliverableReason: String(row.undeliverable_reason) } : {}) } as unknown as ChannelEvent;
    });
    const knowledge = (db.prepare('SELECT payload, content_id FROM knowledge').all() as SqliteRow[]).map((row) => {
      const payload = parse<Record<string, unknown>>(row.payload, {});
      const tags = Array.isArray(payload.tags) ? payload.tags.map(String) : [];
      return { ...payload, text: content.get(String(row.content_id))?.summary ?? '', tags };
    });
    const results = (db.prepare('SELECT payload, content_id FROM results').all() as SqliteRow[]).map((row) => { const payload = parse<Record<string, unknown>>(row.payload, {}); const item = content.get(String(row.content_id)); return { ...payload, summary: item?.summary ?? '', evidenceRefs: item?.evidenceRefs ?? [] }; });
    const confirmations = rows('confirmations').map(({ id: _id, ...confirmation }) => confirmation) as unknown as State['confirmations'];
    return postRedactionState({ actors: rows('actors') as unknown as State['actors'], bindings: rows('actor_bindings') as unknown as State['bindings'], workspaces: rows('workspaces') as unknown as State['workspaces'], goals: rows('goals') as unknown as State['goals'], members: rows('members') as unknown as State['members'], tasks: rows('tasks') as unknown as State['tasks'], sessions: rows('runtimes') as unknown as State['sessions'], deliveries: rows('deliveries') as unknown as State['deliveries'], knowledge: knowledge as State['knowledge'], results: results as State['results'], channelEvents, confirmations });
  }

  private persist(state: State): void {
    const db = this.connection;
    db.exec('BEGIN IMMEDIATE');
    try {
      this.persistWithinTransaction(state);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  private persistWithinTransaction(state: State): void {
    const durable = postRedactionState(state);
    this.persistContent(durable);
    for (const table of ['workspaces', 'actors', 'actor_bindings', 'goals', 'members', 'tasks', 'runtimes', 'deliveries', 'confirmations', 'knowledge', 'results', 'channel_events']) this.connection.exec(`DELETE FROM ${table}`);
    this.persistRows('workspaces', durable.workspaces);
    this.persistRows('actors', durable.actors);
    this.persistRows('actor_bindings', durable.bindings);
    this.persistRows('goals', durable.goals);
    this.persistRows('members', durable.members);
    this.persistRows('tasks', durable.tasks);
    this.persistRows('runtimes', durable.sessions);
    this.persistRows('deliveries', durable.deliveries);
    this.persistRows('confirmations', durable.confirmations.map((confirmation) => ({ ...confirmation, id: confirmation.tokenHash })));
    this.persistContentRows('knowledge', durable.knowledge, (item) => ({ workspace_id: item.workspaceId, content: { summary: item.text, evidenceRefs: [], sensitivity: 'normal', retention: 'standard' } }));
    this.persistContentRows('results', durable.results, (item) => ({ workspace_id: item.workspaceId, content: { summary: item.summary, evidenceRefs: item.evidenceRefs, sensitivity: 'normal', retention: 'standard' } }));
    this.persistEvents(durable.channelEvents);
    this.persistObservations(durable);
  }

  private persistRows(table: string, records: Array<{ id: string }>): void {
    const statement = this.connection.prepare(`INSERT INTO ${table}(id, payload) VALUES (?, ?)`);
    for (const record of records) statement.run(String(record.id), json(record));
  }

  private persistContent(state: State): void {
    for (const event of state.channelEvents) this.ensureContent(contentAddress(event.content.summary, event.content.evidenceRefs), event.content.summary, event.content.evidenceRefs, event.content.sensitivity, event.content.retention);
    for (const entry of state.knowledge) this.ensureContent(contentAddress(entry.text, []), entry.text, []);
    for (const result of state.results) this.ensureContent(contentAddress(result.summary, result.evidenceRefs), result.summary, result.evidenceRefs);
  }

  /** Content is addressed by its immutable payload hash, regardless of which
   * projection (event, result, or knowledge) references it. Existing rows from
   * the pre-canonical layout are reused by hash so upgrades preserve FKs. */
  private ensureContent(contentHash: string, summary: string, evidenceRefs: string[], sensitivity: 'normal' | 'sensitive' = 'normal', retention: 'standard' | 'bounded' = 'standard'): string {
    const existing = this.connection.prepare('SELECT id FROM content WHERE content_hash = ?').get(contentHash) as SqliteRow | undefined;
    if (existing) return String(existing.id);
    const id = `content:${contentHash}`;
    this.connection.prepare('INSERT INTO content(id, content_hash, summary, evidence_refs, sensitivity, retention, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, contentHash, summary, json(evidenceRefs), sensitivity, retention, new Date().toISOString());
    return id;
  }

  private persistContentRows<T extends { id: string }>(table: string, records: T[], metadata: (record: T) => { workspace_id: string; content: { summary: string; evidenceRefs: string[]; sensitivity: 'normal' | 'sensitive'; retention: 'standard' | 'bounded' } }): void {
    const statement = this.connection.prepare(`INSERT INTO ${table}(id, workspace_id, content_id, payload) VALUES (?, ?, ?, ?)`);
    for (const record of records) {
      const value = metadata(record);
      const payload = { ...(record as Record<string, unknown>) };
      delete payload.text;
      delete payload.summary;
      delete payload.evidenceRefs;
      const contentId = this.ensureContent(contentAddress(value.content.summary, value.content.evidenceRefs), value.content.summary, value.content.evidenceRefs, value.content.sensitivity, value.content.retention);
      statement.run(record.id, value.workspace_id, contentId, json(payload));
    }
  }

  private persistEvents(events: ChannelEvent[]): void {
    const journal = this.connection.prepare('INSERT OR IGNORE INTO event_journal(event_id, workspace_id, goal_id, task_id, result_id, source_member_id, source_actor_id, target_member_id, target_actor_id, target_role, target_subscription, kind, urgency, decision_required, content_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const projection = this.connection.prepare('INSERT INTO channel_events(event_id, envelope, content_id, delivery_state, created_at, delivered_at, processed_at, acknowledged_at, undeliverable_reason, related_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const transition = this.connection.prepare('INSERT OR IGNORE INTO event_transitions(event_id, state, at) VALUES (?, ?, ?)');
    for (const event of events) {
      const contentId = this.ensureContent(contentAddress(event.content.summary, event.content.evidenceRefs), event.content.summary, event.content.evidenceRefs, event.content.sensitivity, event.content.retention);
      const { content: _content, transitions: _transitions, deliveryState: _deliveryState, deliveredAt: _deliveredAt, processedAt: _processedAt, acknowledgedAt: _acknowledgedAt, undeliverableReason: _undeliverableReason, ...envelope } = event;
      const prior = this.connection.prepare('SELECT kind, urgency, decision_required, content_id, created_at FROM event_journal WHERE event_id = ?').get(event.id) as SqliteRow | undefined;
      if (prior && (String(prior.kind) !== event.kind || String(prior.urgency) !== event.urgency || Number(prior.decision_required) !== (event.decisionRequired ? 1 : 0) || String(prior.content_id) !== contentId || String(prior.created_at) !== event.createdAt)) throw new Error(`ChannelEvent id ${event.id} conflicts with the append-only journal`);
      journal.run(event.id, event.workspaceId ?? null, event.goalId ?? null, event.taskId ?? null, event.resultId ?? null, event.sourceMemberId ?? null, event.sourceActorId ?? null, event.targetMemberId ?? null, event.targetActorId ?? null, event.targetRole ?? null, event.targetSubscription ?? null, event.kind, event.urgency, event.decisionRequired ? 1 : 0, contentId, event.createdAt);
      projection.run(event.id, json(envelope), contentId, event.deliveryState, event.createdAt, event.deliveredAt ?? null, event.processedAt ?? null, event.acknowledgedAt ?? null, event.undeliverableReason ?? null, event.relatedEventId ?? null);
      for (const item of event.transitions) transition.run(event.id, item.state, item.at);
    }
  }

  private persistObservations(state: State): void {
    const latest = new Map((this.connection.prepare('SELECT runtime_id, snapshot_hash FROM runtime_observations WHERE id IN (SELECT max(id) FROM runtime_observations GROUP BY runtime_id)').all() as SqliteRow[]).map((row) => [String(row.runtime_id), String(row.snapshot_hash)]));
    const insert = this.connection.prepare('INSERT INTO runtime_observations(runtime_id, observed_at, snapshot, snapshot_hash) VALUES (?, ?, ?, ?)');
    for (const session of state.sessions) {
      if (!session.observed || !session.lastObservedAt) continue;
      const snapshot = { observed: session.observed, lastTurnState: session.lastTurnState, state: session.state };
      const snapshotHash = hash(snapshot);
      if (latest.get(session.id) === snapshotHash) continue;
      insert.run(session.id, session.lastObservedAt, json(snapshot), snapshotHash);
    }
    const runtimes = (this.connection.prepare('SELECT DISTINCT runtime_id FROM runtime_observations').all() as SqliteRow[]).map((row) => String(row.runtime_id));
    const prune = this.connection.prepare(`DELETE FROM runtime_observations WHERE runtime_id = ? AND id NOT IN (SELECT id FROM runtime_observations WHERE runtime_id = ? ORDER BY id DESC LIMIT ${OBSERVATION_LIMIT})`);
    for (const runtimeId of runtimes) prune.run(runtimeId, runtimeId);
  }

  status(): DatabaseStatus {
    const db = this.connection;
    const counts: Record<string, number> = {};
    for (const table of ['event_journal', 'channel_events', 'content', 'workspaces', 'actors', 'members', 'goals', 'tasks', 'runtimes', 'deliveries', 'confirmations', 'knowledge', 'results', 'runtime_observations', 'legacy_reminders', 'migration_audit']) counts[table] = Number((db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as SqliteRow).count);
    const mode = awaitableStat(this.file);
    return { path: this.file, schemaVersion: Number((db.prepare('SELECT max(version) AS version FROM schema_migrations').get() as SqliteRow).version ?? 0), journalMode: String((db.prepare('PRAGMA journal_mode').get() as SqliteRow).journal_mode), foreignKeys: Number((db.prepare('PRAGMA foreign_keys').get() as SqliteRow).foreign_keys), busyTimeout: Number((db.prepare('PRAGMA busy_timeout').get() as SqliteRow).timeout), observations: counts.runtime_observations, tables: counts, mode };
  }

  check(): DatabaseCheck { const status = this.status(); const db = this.connection; return { ...status, quickCheck: String((db.prepare('PRAGMA quick_check').get() as SqliteRow).quick_check), integrityCheck: String((db.prepare('PRAGMA integrity_check').get() as SqliteRow).integrity_check) }; }

  async backupTo(out: string): Promise<{ out: string; pages: number }> { await mkdir(path.dirname(out), { recursive: true }); this.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)'); const pages = await backup(this.connection, out); this.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)'); await chmod(out, 0o600); return { out, pages }; }

  export(kind?: string, since?: string): DatabaseExport {
    const db = this.connection;
    const rows = (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params as any[]) as SqliteRow[];
    const events = rows('SELECT c.*, j.kind, e.summary, e.evidence_refs, e.content_hash, e.sensitivity, e.retention FROM channel_events c JOIN event_journal j ON j.event_id = c.event_id LEFT JOIN content e ON e.id = c.content_id WHERE (? IS NULL OR c.created_at >= ?) ORDER BY c.created_at', [since ?? null, since ?? null]).map((row) => ({ ...parse<Record<string, unknown>>(row.envelope, {}), id: row.event_id, kind: row.kind, deliveryState: row.delivery_state, content: { summary: row.summary, evidenceRefs: parse<string[]>(row.evidence_refs, []), contentHash: row.content_hash, sensitivity: row.sensitivity, retention: row.retention } }));
    const knowledge = rows('SELECT k.payload, c.summary, c.evidence_refs FROM knowledge k LEFT JOIN content c ON c.id = k.content_id').map((row) => ({ ...parse<Record<string, unknown>>(row.payload, {}), text: row.summary, evidenceRefs: parse<string[]>(row.evidence_refs, []) }));
    const results = rows('SELECT r.payload, c.summary, c.evidence_refs FROM results r LEFT JOIN content c ON c.id = r.content_id').map((row) => ({ ...parse<Record<string, unknown>>(row.payload, {}), summary: row.summary, evidenceRefs: parse<string[]>(row.evidence_refs, []) }));
    return { exportedAt: new Date().toISOString(), ...(kind ? { kind } : {}), ...(since ? { since } : {}), events: kind ? events.filter((event) => event.kind === kind) : events, knowledge, results };
  }

  async importLegacy(sourceDir: string): Promise<ImportReport> {
    const root = path.resolve(sourceDir); const statePath = path.join(root, 'arcp-state.json');
    // Read and parse every source before acquiring the SQLite write transaction.
    // This keeps file I/O out of BEGIN IMMEDIATE and gives a concurrent writer a
    // single, deterministic source snapshot to import.
    const stateText = await readFile(statePath, 'utf8');
    const parsedState = JSON.parse(stateText) as Partial<State>;
    const sourceState = postRedactionState(parsedState);
    const legacyValues = (file: string, text: string): unknown[] => {
      if (file === statePath) return Object.values(parsedState).filter((value) => Array.isArray(value)).flat();
      if (file.endsWith('.jsonl')) return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const value = JSON.parse(text); return Array.isArray(value) ? value : Object.values(value ?? {});
    };
    const names = (await readdir(root)).filter((name) => name !== 'arcp-state.json' && (name === 'reminders.json' || name.endsWith('.jsonl'))).sort();
    const inputs = [{ file: statePath, text: stateText, values: legacyValues(statePath, stateText) }, ...await Promise.all(names.map(async (name) => {
      const file = path.join(root, name); const text = await readFile(file, 'utf8');
      return { file, text, values: legacyValues(file, text) };
    }))];
    const expectedProjection = projection(parsedState); const expectedProjectionHash = hash(expectedProjection);
    const stateSourceReport = { file: 'arcp-state.json', records: projectionRecords(expectedProjection), contentHash: expectedProjectionHash, importedRecords: 0, importedHash: hash([]), match: false };
    // Sidecar proof is based on the per-record hashes read back from SQLite;
    // retaining the raw source hash separately in migration_audit detects file
    // changes without persisting private reminder text.
    const sourceReports: ImportReport['sources'] = [stateSourceReport, ...inputs.slice(1).map((input) => ({ file: path.basename(input.file), records: input.values.length, contentHash: hash(input.values.map((value) => hash(value))), importedRecords: 0, importedHash: hash([]), match: false }))];
    const stateReport: ImportReport['state'] = { records: projectionRecords(expectedProjection), contentHash: expectedProjectionHash, importedRecords: 0, importedHash: hash([]), match: false };
    const report: ImportReport = { imported: true, noop: false, sources: sourceReports, state: stateReport };
    const sourceHashes = new Map(inputs.map((input) => [path.basename(input.file), hash(input.text)]));
    return this.enqueue(async () => {
      // Queue the read/no-op decision too: otherwise a concurrent mutation
      // could land after this method's preflight and be silently ignored.
      const currentProjection = projection(this.loadState());
      const auditRows = new Map((this.connection.prepare('SELECT source_file, source_hash FROM migration_audit').all() as SqliteRow[]).map((row) => [String(row.source_file), String(row.source_hash)]));
      const legacyRows = (name: string) => (this.connection.prepare('SELECT record_index, record_hash FROM legacy_reminders WHERE source_file = ? ORDER BY record_index').all(name) as SqliteRow[]);
      const importedSidecars = new Set(inputs.slice(1).map((input) => path.basename(input.file)));
      const storedSidecars = (this.connection.prepare('SELECT DISTINCT source_file FROM legacy_reminders').all() as SqliteRow[]).map((row) => String(row.source_file));
      const stateMatches = auditRows.get('arcp-state.json') === sourceHashes.get('arcp-state.json') && hash(currentProjection) === expectedProjectionHash;
      const sidecarsMatch = storedSidecars.every((source) => importedSidecars.has(source)) && inputs.slice(1).every((input, index) => {
        const source = sourceReports[index + 1]; const rows = legacyRows(path.basename(input.file));
        const importedValues = rows.map((row) => String(row.record_hash));
        return auditRows.get(source.file) === sourceHashes.get(source.file) && rows.length === source.records && hash(importedValues) === hash(input.values.map((value) => hash(value)));
      });
      if (stateMatches && sidecarsMatch) {
        const importedHash = hash(currentProjection); const importedState = { records: projectionRecords(currentProjection), contentHash: importedHash, importedRecords: projectionRecords(currentProjection), importedHash, match: true };
        stateSourceReport.importedRecords = importedState.importedRecords; stateSourceReport.importedHash = importedState.importedHash; stateSourceReport.match = true;
        for (const source of sourceReports.slice(1)) { source.importedRecords = source.records; source.importedHash = hash(inputs.find((input) => path.basename(input.file) === source.file)!.values.map((value) => hash(value))); source.match = true; }
        return { imported: false, noop: true, sources: sourceReports, state: importedState };
      }
      const db = this.connection; const before = structuredClone(this.state); db.exec('BEGIN IMMEDIATE');
      try {
        this.state = sourceState;
        this.persistWithinTransaction(this.state);
        const importedProjection = projection(this.loadState()); const importedHash = hash(importedProjection);
        report.state.importedRecords = projectionRecords(importedProjection); report.state.importedHash = importedHash; report.state.match = report.state.records === report.state.importedRecords && report.state.contentHash === importedHash;
        if (!report.state.match) throw verificationError('', report.state.records, report.state.contentHash, report.state.importedRecords, report.state.importedHash, expectedProjection, importedProjection);
        stateSourceReport.importedRecords = report.state.importedRecords; stateSourceReport.importedHash = importedHash; stateSourceReport.match = true;
        const insert = db.prepare('INSERT INTO legacy_reminders(source_file, record_index, record_hash, kind, payload, imported_at) VALUES (?, ?, ?, ?, ?, ?)');
        const importedAt = new Date().toISOString();
        if (importedSidecars.size === 0) db.exec('DELETE FROM legacy_reminders');
        else db.prepare(`DELETE FROM legacy_reminders WHERE source_file NOT IN (${[...importedSidecars].map(() => '?').join(',')})`).run(...importedSidecars);
        for (const input of inputs.slice(1)) {
          const source = path.basename(input.file); db.prepare('DELETE FROM legacy_reminders WHERE source_file = ?').run(source);
          for (const [index, value] of input.values.entries()) {
            const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
            const recordHash = hash(value); const kind = String(record.kind ?? 'legacy-reminder');
            insert.run(source, index, recordHash, kind, json(redactLegacyRecord(value)), importedAt);
          }
          const rows = (db.prepare('SELECT record_index, record_hash FROM legacy_reminders WHERE source_file = ? ORDER BY record_index').all(source) as SqliteRow[]);
          const importedValues = rows.map((row) => String(row.record_hash)); const sourceReport = sourceReports.find((item) => item.file === source)!;
          sourceReport.importedRecords = rows.length; sourceReport.importedHash = hash(importedValues); sourceReport.match = sourceReport.records === rows.length && sourceReport.importedHash === hash(input.values.map((value) => hash(value)));
          if (!sourceReport.match) {
            const expectedRecords = input.values.map((value) => hash(value));
            const importedRecords = rows.map((row) => String(row.record_hash));
            throw verificationError(source, sourceReport.records, sourceReport.contentHash, rows.length, sourceReport.importedHash, expectedRecords, importedRecords);
          }
        }
        this.state = this.loadState();
        const audit = db.prepare('INSERT OR REPLACE INTO migration_audit(source_file, source_hash, imported_at, report) VALUES (?, ?, ?, ?)');
        for (const input of inputs) audit.run(path.basename(input.file), sourceHashes.get(path.basename(input.file))!, importedAt, json(report));
        db.exec('COMMIT'); return report;
      } catch (error) { db.exec('ROLLBACK'); this.state = before; throw error; }
    });
  }
}

function redactLegacyRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLegacyRecord);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/body|message|prompt|token|secret|credential|password|private.?key/i.test(key)) continue;
    result[key] = redactLegacyRecord(item);
  }
  return result;
}

// Keeping this helper synchronous avoids making status a surprising async API for
// callers that are already inside a diagnostic command.
function awaitableStat(file: string): string {
  try { return `0${(statSync(file).mode & 0o777).toString(8)}`; } catch { return '0600'; }
}
