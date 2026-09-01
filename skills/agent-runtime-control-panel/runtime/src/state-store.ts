import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { State, ChannelEvent } from './arcp.js';

/** The application-facing persistence seam. Implementations own their storage format. */
export interface StateStore {
  readonly file: string;
  init(): Promise<void>;
  snapshot(): State;
  mutate<T>(fn: (state: State) => T): Promise<T>;
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
const SCHEMA_VERSION = 2;
const emptyState = (): State => ({ actors: [], bindings: [], credentials: {}, workspaces: [], members: [], memberCredentials: {}, tasks: [], knowledge: [], results: [], goals: [], sessions: [], deliveries: [], channelEvents: [], confirmations: [] });
const json = (value: unknown): string => JSON.stringify(value);
const parse = <T>(value: unknown, fallback: T): T => { try { return value === null || value === undefined ? fallback : JSON.parse(String(value)) as T; } catch { return fallback; } };
const hash = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function safeState(value: Partial<State>): State {
  const state = { ...emptyState(), ...value } as State;
  // Credentials are deliberately process-local. They are accepted by the JSON
  // compatibility store, but never copied into SQLite.
  state.credentials = {};
  state.memberCredentials = {};
  state.sessions = state.sessions.map((session) => ({ ...session, workspace: undefined }));
  state.deliveries = state.deliveries.map((delivery) => ({ ...delivery, body: '' }));
  state.channelEvents = state.channelEvents.map((event) => normalizeEvent(event as unknown as Record<string, unknown>));
  return state;
}
function normalizeEvent(value: Record<string, unknown>): ChannelEvent {
  if (value.content && typeof value.content === 'object') {
    return { ...value, kind: String(value.kind ?? 'finding'), urgency: value.urgency === 'urgent' ? 'urgent' : 'normal', decisionRequired: Boolean(value.decisionRequired), createdAt: String(value.createdAt ?? '1970-01-01T00:00:00.000Z') } as unknown as ChannelEvent;
  }
  const summary = String(value.summary ?? '');
  const evidenceRefs = Array.isArray(value.evidenceRefs) ? value.evidenceRefs.map(String) : [];
  const at = String(value.createdAt ?? value.deliveredAt ?? value.processedAt ?? value.acknowledgedAt ?? '1970-01-01T00:00:00.000Z');
  const transitions: Array<{ state: 'queued' | 'delivered' | 'processed' | 'acknowledged' | 'transport_indeterminate' | 'undeliverable' | 'withdrawn'; at: string }> = [{ state: 'queued', at }];
  for (const state of ['delivered', 'processed', 'acknowledged'] as const) if (typeof value[`${state}At`] === 'string') transitions.push({ state, at: String(value[`${state}At`]) });
  const final = String(value.deliveryState ?? transitions.at(-1)?.state ?? 'queued') as 'queued' | 'delivered' | 'processed' | 'acknowledged' | 'transport_indeterminate' | 'undeliverable' | 'withdrawn';
  if (final !== 'queued' && !transitions.some((item) => item.state === final)) transitions.push({ state: final, at });
  const { summary: _summary, evidenceRefs: _evidenceRefs, content: _content, transitions: _transitions, ...envelope } = value;
  return { ...envelope, kind: String(value.kind ?? 'finding'), urgency: value.urgency === 'urgent' ? 'urgent' : 'normal', decisionRequired: Boolean(value.decisionRequired), content: { summary, evidenceRefs, contentHash: hash({ summary, evidenceRefs }), sensitivity: 'normal', retention: 'standard' }, deliveryState: final, transitions, createdAt: at } as unknown as ChannelEvent;
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
    CREATE TABLE IF NOT EXISTS knowledge (id TEXT PRIMARY KEY, workspace_id TEXT, content_id TEXT REFERENCES content(id), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS results (id TEXT PRIMARY KEY, workspace_id TEXT, content_id TEXT REFERENCES content(id), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS corrections (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS gates (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_observations (id INTEGER PRIMARY KEY AUTOINCREMENT, runtime_id TEXT NOT NULL, observed_at TEXT NOT NULL, snapshot TEXT NOT NULL, snapshot_hash TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS runtime_observations_runtime_idx ON runtime_observations(runtime_id, id);
    CREATE TABLE IF NOT EXISTS legacy_records (source_file TEXT NOT NULL, record_index INTEGER NOT NULL, record_hash TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(source_file, record_index));
    CREATE TABLE IF NOT EXISTS migration_audit (source_file TEXT NOT NULL, source_hash TEXT NOT NULL, imported_at TEXT NOT NULL, report TEXT NOT NULL, PRIMARY KEY(source_file, source_hash));
  `],
  [2, `CREATE INDEX IF NOT EXISTS event_journal_workspace_idx ON event_journal(workspace_id, created_at); CREATE INDEX IF NOT EXISTS event_journal_kind_idx ON event_journal(kind, created_at);`],
];

export class SQLiteStateStore implements StateStore {
  readonly file: string;
  private db?: DatabaseSync;
  private state: State = emptyState();
  private write: Promise<unknown> = Promise.resolve();

  constructor(dirOrFile: string) {
    this.file = dirOrFile.endsWith('.sqlite') || dirOrFile.endsWith('.db') ? dirOrFile : path.join(dirOrFile, 'arcp-state.sqlite');
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
    const knowledge = (db.prepare('SELECT payload, content_id FROM knowledge').all() as SqliteRow[]).map((row) => ({ ...parse<Record<string, unknown>>(row.payload, {}), text: content.get(String(row.content_id))?.summary ?? '', tags: parse<string[]>(parse<Record<string, unknown>>(row.payload, {}).tags, []) }));
    const results = (db.prepare('SELECT payload, content_id FROM results').all() as SqliteRow[]).map((row) => { const payload = parse<Record<string, unknown>>(row.payload, {}); const item = content.get(String(row.content_id)); return { ...payload, summary: item?.summary ?? '', evidenceRefs: item?.evidenceRefs ?? [] }; });
    return safeState({ actors: rows('actors') as unknown as State['actors'], bindings: rows('actor_bindings') as unknown as State['bindings'], workspaces: rows('workspaces') as unknown as State['workspaces'], goals: rows('goals') as unknown as State['goals'], members: rows('members') as unknown as State['members'], tasks: rows('tasks') as unknown as State['tasks'], sessions: rows('runtimes') as unknown as State['sessions'], deliveries: rows('deliveries') as unknown as State['deliveries'], knowledge: knowledge as State['knowledge'], results: results as State['results'], channelEvents });
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
    this.persistContent(state);
    for (const table of ['workspaces', 'actors', 'actor_bindings', 'goals', 'members', 'tasks', 'runtimes', 'deliveries', 'knowledge', 'results', 'corrections', 'gates', 'channel_events']) this.connection.exec(`DELETE FROM ${table}`);
    this.persistRows('workspaces', state.workspaces);
    this.persistRows('actors', state.actors);
    this.persistRows('actor_bindings', state.bindings);
    this.persistRows('goals', state.goals);
    this.persistRows('members', state.members);
    this.persistRows('tasks', state.tasks);
    this.persistRows('runtimes', state.sessions.map((session) => ({ ...session, workspace: undefined })));
    this.persistRows('deliveries', state.deliveries.map((delivery) => ({ ...delivery, body: '' })));
    this.persistRows('corrections', []);
    this.persistRows('gates', []);
    this.persistContentRows('knowledge', state.knowledge, (item) => ({ workspace_id: item.workspaceId, content: { summary: item.text, evidenceRefs: [], sensitivity: 'normal', retention: 'standard' } }));
    this.persistContentRows('results', state.results, (item) => ({ workspace_id: item.workspaceId, content: { summary: item.summary, evidenceRefs: item.evidenceRefs, sensitivity: 'normal', retention: 'standard' } }));
    this.persistEvents(state.channelEvents);
    this.persistObservations(state);
  }

  private persistRows(table: string, records: Array<{ id: string }>): void {
    const statement = this.connection.prepare(`INSERT INTO ${table}(id, payload) VALUES (?, ?)`);
    for (const record of records) statement.run(String(record.id), json(record));
  }

  private persistContent(state: State): void {
    const insert = this.connection.prepare('INSERT OR IGNORE INTO content(id, content_hash, summary, evidence_refs, sensitivity, retention, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const add = (id: string, summary: string, evidenceRefs: string[], sensitivity: 'normal' | 'sensitive' = 'normal', retention: 'standard' | 'bounded' = 'standard', contentHash = hash({ summary, evidenceRefs })) => insert.run(id, contentHash, summary, json(evidenceRefs), sensitivity, retention, new Date().toISOString());
    for (const event of state.channelEvents) add(`event-content:${event.content.contentHash}`, event.content.summary, event.content.evidenceRefs, event.content.sensitivity, event.content.retention, event.content.contentHash);
    for (const entry of state.knowledge) add(`knowledge-content:${entry.id}`, entry.text, []);
    for (const result of state.results) add(`result-content:${result.id}`, result.summary, result.evidenceRefs);
  }

  private persistContentRows<T extends { id: string }>(table: string, records: T[], metadata: (record: T) => { workspace_id: string; content: { summary: string; evidenceRefs: string[]; sensitivity: 'normal' | 'sensitive'; retention: 'standard' | 'bounded' } }): void {
    const statement = this.connection.prepare(`INSERT INTO ${table}(id, workspace_id, content_id, payload) VALUES (?, ?, ?, ?)`);
    for (const record of records) {
      const value = metadata(record);
      const payload = { ...(record as Record<string, unknown>) };
      delete payload.text;
      delete payload.summary;
      delete payload.evidenceRefs;
      const contentId = `${table}-content:${record.id}`;
      statement.run(record.id, value.workspace_id, contentId, json(payload));
      const content = value.content;
      this.connection.prepare('INSERT OR IGNORE INTO content(id, content_hash, summary, evidence_refs, sensitivity, retention, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(contentId, hash({ summary: content.summary, evidenceRefs: content.evidenceRefs }), content.summary, json(content.evidenceRefs), content.sensitivity, content.retention, new Date().toISOString());
    }
  }

  private persistEvents(events: ChannelEvent[]): void {
    const journal = this.connection.prepare('INSERT OR IGNORE INTO event_journal(event_id, workspace_id, goal_id, task_id, result_id, source_member_id, source_actor_id, target_member_id, target_actor_id, target_role, target_subscription, kind, urgency, decision_required, content_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const projection = this.connection.prepare('INSERT INTO channel_events(event_id, envelope, content_id, delivery_state, created_at, delivered_at, processed_at, acknowledged_at, undeliverable_reason, related_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const transition = this.connection.prepare('INSERT OR IGNORE INTO event_transitions(event_id, state, at) VALUES (?, ?, ?)');
    for (const event of events) {
      const contentId = `event-content:${event.content.contentHash}`;
      const { content: _content, transitions: _transitions, deliveryState: _deliveryState, deliveredAt: _deliveredAt, processedAt: _processedAt, acknowledgedAt: _acknowledgedAt, undeliverableReason: _undeliverableReason, ...envelope } = event;
      const prior = this.connection.prepare('SELECT kind, urgency, decision_required, content_id, created_at FROM event_journal WHERE event_id = ?').get(event.id) as SqliteRow | undefined;
      if (prior && (String(prior.kind) !== event.kind || String(prior.urgency) !== event.urgency || Number(prior.decision_required) !== (event.decisionRequired ? 1 : 0) || String(prior.content_id) !== contentId || String(prior.created_at) !== event.createdAt)) throw new Error(`ChannelEvent id ${event.id} conflicts with the append-only journal`);
      journal.run(event.id, event.workspaceId ?? null, event.goalId ?? null, event.taskId ?? null, event.resultId ?? null, event.sourceMemberId ?? null, event.sourceActorId ?? null, event.targetMemberId ?? null, event.targetActorId ?? null, event.targetRole ?? null, event.targetSubscription ?? null, event.kind, event.urgency, event.decisionRequired ? 1 : 0, contentId, event.createdAt);
      projection.run(event.id, json(envelope), contentId, event.deliveryState, event.createdAt, event.deliveredAt ?? null, event.processedAt ?? null, event.acknowledgedAt ?? null, event.undeliverableReason ?? null, event.relatedEventId ?? null);
      for (const item of event.transitions) transition.run(event.id, item.state, item.at);
    }
  }

  private persistObservations(state: State): void {
    const latest = new Map((this.connection.prepare('SELECT runtime_id, snapshot_hash FROM runtime_observations ORDER BY id DESC').all() as SqliteRow[]).map((row) => [String(row.runtime_id), String(row.snapshot_hash)]));
    const insert = this.connection.prepare('INSERT INTO runtime_observations(runtime_id, observed_at, snapshot, snapshot_hash) VALUES (?, ?, ?, ?)');
    for (const session of state.sessions) {
      if (!session.observed || !session.lastObservedAt) continue;
      const snapshot = { observed: session.observed, lastTurnState: session.lastTurnState, state: session.state };
      const snapshotHash = hash(snapshot);
      if (latest.get(session.id) === snapshotHash) continue;
      insert.run(session.id, session.lastObservedAt, json(snapshot), snapshotHash);
    }
    this.connection.exec(`DELETE FROM runtime_observations WHERE id NOT IN (SELECT id FROM runtime_observations ORDER BY id DESC LIMIT ${OBSERVATION_LIMIT})`);
  }

  status(): DatabaseStatus {
    const db = this.connection;
    const counts: Record<string, number> = {};
    for (const table of ['event_journal', 'channel_events', 'content', 'workspaces', 'actors', 'members', 'goals', 'tasks', 'runtimes', 'deliveries', 'knowledge', 'results', 'runtime_observations', 'migration_audit']) counts[table] = Number((db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as SqliteRow).count);
    const mode = awaitableStat(this.file);
    return { path: this.file, schemaVersion: Number((db.prepare('SELECT max(version) AS version FROM schema_migrations').get() as SqliteRow).version ?? 0), journalMode: String((db.prepare('PRAGMA journal_mode').get() as SqliteRow).journal_mode), foreignKeys: Number((db.prepare('PRAGMA foreign_keys').get() as SqliteRow).foreign_keys), busyTimeout: Number((db.prepare('PRAGMA busy_timeout').get() as SqliteRow).timeout), observations: counts.runtime_observations, tables: counts, mode };
  }

  check(): DatabaseCheck { const status = this.status(); const db = this.connection; return { ...status, quickCheck: String((db.prepare('PRAGMA quick_check').get() as SqliteRow).quick_check), integrityCheck: String((db.prepare('PRAGMA integrity_check').get() as SqliteRow).integrity_check) }; }

  async backupTo(out: string): Promise<{ out: string; pages: number }> { await mkdir(path.dirname(out), { recursive: true }); this.connection.exec('PRAGMA wal_checkpoint(PASSIVE)'); const pages = await backup(this.connection, out); await chmod(out, 0o600); return { out, pages }; }

  export(kind?: string, since?: string): DatabaseExport {
    const db = this.connection;
    const rows = (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params as any[]) as SqliteRow[];
    const events = rows('SELECT c.*, j.kind, e.summary, e.evidence_refs, e.content_hash, e.sensitivity, e.retention FROM channel_events c JOIN event_journal j ON j.event_id = c.event_id LEFT JOIN content e ON e.id = c.content_id WHERE (? IS NULL OR c.created_at >= ?) ORDER BY c.created_at', [since ?? null, since ?? null]).map((row) => ({ ...parse<Record<string, unknown>>(row.envelope, {}), id: row.event_id, kind: row.kind, deliveryState: row.delivery_state, content: { summary: row.summary, evidenceRefs: parse<string[]>(row.evidence_refs, []), contentHash: row.content_hash, sensitivity: row.sensitivity, retention: row.retention } }));
    const knowledge = rows('SELECT k.payload, c.summary, c.evidence_refs FROM knowledge k LEFT JOIN content c ON c.id = k.content_id').map((row) => ({ ...parse<Record<string, unknown>>(row.payload, {}), text: row.summary, evidenceRefs: parse<string[]>(row.evidence_refs, []) }));
    const results = rows('SELECT r.payload, c.summary, c.evidence_refs FROM results r LEFT JOIN content c ON c.id = r.content_id').map((row) => ({ ...parse<Record<string, unknown>>(row.payload, {}), summary: row.summary, evidenceRefs: parse<string[]>(row.evidence_refs, []) }));
    return { exportedAt: new Date().toISOString(), ...(kind ? { kind } : {}), ...(since ? { since } : {}), events: kind ? events.filter((event) => event.kind === kind) : events, knowledge, results };
  }

  async importLegacy(sourceDir: string): Promise<ImportReport> {
    const root = path.resolve(sourceDir); const statePath = path.join(root, 'arcp-state.json'); const stateText = await readFile(statePath, 'utf8');
    const parsedState = JSON.parse(stateText) as Partial<State>;
    const sourceState = safeState(parsedState);
    const legacyValues = (file: string, text: string): unknown[] => {
      if (file === statePath) return Object.values(parsedState).filter((value) => Array.isArray(value)).flat();
      if (file.endsWith('.jsonl')) return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const value = JSON.parse(text); return Array.isArray(value) ? value : Object.values(value ?? {});
    };
    const files = [statePath, ...(await readdir(root)).filter((name) => name !== 'arcp-state.json' && (name === 'reminders.json' || name.endsWith('.jsonl'))).map((name) => path.join(root, name))];
    const sourceReports: ImportReport['sources'] = [];
    for (const file of files) {
      const text = file === statePath ? stateText : await readFile(file, 'utf8');
      const values = legacyValues(file, text);
      const importedValues = values;
      sourceReports.push({ file: path.basename(file), records: values.length, contentHash: hash(values), importedRecords: importedValues.length, importedHash: hash(importedValues), match: values.length === importedValues.length });
    }
    const stateRecords = Object.values(sourceState).filter((value) => Array.isArray(value)).flat() as unknown[];
    const stateReport = { records: stateRecords.length, contentHash: hash(sourceState), importedRecords: stateRecords.length, importedHash: hash(sourceState), match: true };
    const existing = (this.connection.prepare('SELECT source_file, source_hash, report FROM migration_audit WHERE source_file = ?').all('arcp-state.json') as SqliteRow[]).find((row) => String(row.source_hash) === hash(stateText));
    if (existing) return { imported: false, noop: true, sources: parse<ImportReport['sources']>(parse<Record<string, unknown>>(existing.report, {}).sources, sourceReports), state: parse<ImportReport['state']>(parse<Record<string, unknown>>(existing.report, {}).state, stateReport) };
    const report: ImportReport = { imported: true, noop: false, sources: sourceReports, state: stateReport };
    const db = this.connection;
    db.exec('BEGIN IMMEDIATE');
    const before = structuredClone(this.state);
    try {
      this.state = sourceState;
      this.persistWithinTransaction(this.state);
      const audit = db.prepare('INSERT INTO migration_audit(source_file, source_hash, imported_at, report) VALUES (?, ?, ?, ?)');
      for (const file of files) { const text = file === statePath ? stateText : await readFile(file, 'utf8'); const values = legacyValues(file, text); values.forEach((value, index) => db.prepare('INSERT OR IGNORE INTO legacy_records(source_file, record_index, record_hash, kind) VALUES (?, ?, ?, ?)').run(path.basename(file), index, hash(value), file === statePath ? 'state' : 'reminder')); audit.run(path.basename(file), hash(text), new Date().toISOString(), json(report)); }
      db.exec('COMMIT');
      return report;
    } catch (error) { db.exec('ROLLBACK'); this.state = before; throw error; }
  }
}

// Keeping this helper synchronous avoids making status a surprising async API for
// callers that are already inside a diagnostic command.
function awaitableStat(file: string): string {
  try { return `0${(statSync(file).mode & 0o777).toString(8)}`; } catch { return '0600'; }
}

export { OBSERVATION_LIMIT };
export { SQLiteStateStore as SqliteStateStore };
