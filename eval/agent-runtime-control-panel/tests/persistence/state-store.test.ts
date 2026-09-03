import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQLiteStateStore } from '../../../../skills/agent-runtime-control-panel/runtime/src/state-store.js';

const root = () => mkdtemp(path.join(os.tmpdir(), 'arcp-sqlite-'));
const event = (id: string, summary = 'event') => ({ id, workspaceId: 'workspace-1', kind: 'finding' as const, urgency: 'normal' as const, decisionRequired: false, content: { summary, evidenceRefs: ['result-ref'], contentHash: `hash-${id}`, sensitivity: 'normal' as const, retention: 'bounded' as const }, deliveryState: 'queued' as const, transitions: [{ state: 'queued' as const, at: '2026-01-01T00:00:00.000Z' }], createdAt: '2026-01-01T00:00:00.000Z' });

describe('SQLite StateStore', () => {
  it('initializes crash-safe numbered migrations with required SQLite settings', async () => {
    const dir = await root(); const store = new SQLiteStateStore(dir); await store.init();
    expect(store.status()).toMatchObject({ schemaVersion: 4, journalMode: 'wal', foreignKeys: 1, busyTimeout: 5000, mode: '0600' });
    const db = new DatabaseSync(store.file);
    expect((db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as any[]).map((row) => row.version)).toEqual([1, 2, 3, 4]);
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('corrections', 'gates', 'legacy_records')").all() as any[])).toEqual([]);
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_observations'").all() as any[])).toHaveLength(1);
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'runtime_observations_runtime_idx'").all() as any[])).toHaveLength(1);
    expect(store.status().tables).toMatchObject({ execution_surfaces: 0, surface_claims: 0, runtime_bindings: 0 });
    expect(store.check()).toMatchObject({ quickCheck: 'ok', integrityCheck: 'ok' }); db.close(); store.close();
  });

  it('deduplicates a stable event journal id while keeping content out of envelopes', async () => {
    const dir = await root(); const store = new SQLiteStateStore(dir); await store.init();
    await store.mutate((state) => state.channelEvents.push(event('stable-event')));
    await store.mutate((state) => state.channelEvents[0].transitions.push({ state: 'delivered', at: '2026-01-01T00:00:01.000Z' }));
    const db = new DatabaseSync(store.file);
    expect((db.prepare('SELECT count(*) AS count FROM event_journal').get() as any).count).toBe(1);
    expect((db.prepare('SELECT count(*) AS count FROM event_transitions').get() as any).count).toBe(2);
    const envelope = String((db.prepare('SELECT envelope FROM channel_events').get() as any).envelope);
    expect(envelope).not.toContain('event-ref'); expect(envelope).not.toContain('result-ref');
    expect(store.snapshot().channelEvents[0].content.summary).toBe('event'); db.close(); store.close();
  });

  it('serializes concurrent mutations without losing projection updates', async () => {
    const dir = await root(); const store = new SQLiteStateStore(dir); await store.init();
    await Promise.all(Array.from({ length: 25 }, (_, index) => store.mutate((state) => state.channelEvents.push(event(`concurrent-${index}`)))));
    expect(store.status().tables.event_journal).toBe(25); expect(store.snapshot().channelEvents).toHaveLength(25); store.close();
  });

  it('redacts credentials, paths and delivery bodies and bounds runtime observations', async () => {
    const dir = await root(); const store = new SQLiteStateStore(dir); await store.init();
    await store.mutate((state) => {
      state.credentials.secret = 'credential-secret'; state.memberCredentials.secret = 'member-secret';
      state.deliveries.push({ id: 'delivery-1', fromActorId: 'actor', runtimeSessionId: 'runtime-1', generation: 1, body: 'private prompt', command: 'normal', state: 'queued', createdAt: '2026-01-01T00:00:00.000Z' });
      state.sessions.push({ id: 'runtime-1', actorId: 'actor', goalId: 'goal', bindingId: 'binding', generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', profileId: 'profile', provider: 'codex', model: 'model', workspace: '/private/path', state: 'idle', observed: { mode: 'auto' }, lastObservedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' });
    });
    for (let i = 1; i <= 105; i += 1) await store.mutate((state) => { const session = state.sessions[0]; session.observed = { mode: `mode-${i}` }; session.lastObservedAt = `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`; });
    const db = new DatabaseSync(store.file); const observations = Number((db.prepare('SELECT count(*) AS count FROM runtime_observations').get() as any).count); const raw = readFile(store.file).catch(() => Buffer.from(''));
    expect(observations).toBe(100); expect(store.snapshot().sessions[0].workspace).toBe('/private/path');
    store.close(); const restarted = new SQLiteStateStore(dir); await restarted.init(); expect(restarted.snapshot().credentials).toEqual({}); expect(restarted.snapshot().memberCredentials).toEqual({}); expect(restarted.snapshot().deliveries[0].body).toBe(''); expect(restarted.snapshot().sessions[0].workspace).toBeUndefined(); restarted.close();
    expect(String(await raw)).not.toContain('credential-secret'); expect(String(await raw)).not.toContain('private prompt'); db.close();
  });

  it('round-trips knowledge tags through a newly opened SQLite store', async () => {
    const dir = await root(); const store = new SQLiteStateStore(dir); await store.init();
    const tagged = { id: 'knowledge-tagged', workspaceId: 'workspace-1', authorMemberId: 'member-1', kind: 'learning' as const, text: 'Tagged durable learning', tags: ['sqlite', 'round-trip', 'r2-f13'], createdAt: '2026-01-01T00:00:00.000Z' };
    await store.mutate((state) => state.knowledge.push(tagged));
    store.close();
    const reopened = new SQLiteStateStore(dir); await reopened.init();
    expect(reopened.snapshot().knowledge).toContainEqual(tagged);
    reopened.close();
  });

  it('retains the observation bound independently for each runtime', async () => {
    const dir = await root(); const store = new SQLiteStateStore(dir); await store.init();
    await store.mutate((state: any) => {
      for (const runtimeId of ['runtime-a', 'runtime-b']) state.sessions.push({ id: runtimeId, actorId: 'actor', goalId: `goal-${runtimeId}`, bindingId: 'binding', generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', provider: 'codex', model: 'model', state: 'idle', createdAt: '2026-01-01T00:00:00.000Z', observed: { mode: 'initial' }, lastObservedAt: '2026-01-01T00:00:00.000Z' });
    });
    for (let i = 1; i <= 105; i += 1) await store.mutate((state: any) => { for (const runtime of state.sessions) { runtime.observed = { mode: `${runtime.id}-${i}` }; runtime.lastObservedAt = `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`; } });
    const db = new DatabaseSync(store.file); expect((db.prepare('SELECT runtime_id, count(*) AS count FROM runtime_observations GROUP BY runtime_id ORDER BY runtime_id').all() as any[])).toEqual([{ runtime_id: 'runtime-a', count: 100 }, { runtime_id: 'runtime-b', count: 100 }]); db.close(); store.close();
  });

  it('retains SQLite delivery projections and the append-only journal', async () => {
    const dir = await root(); const store = new SQLiteStateStore(dir); await store.init();
    await store.mutate((state: any) => { for (let i = 0; i < 4; i += 1) { const id = `delivery-${i}`; state.deliveries.push({ id, fromActorId: 'actor', runtimeSessionId: 'runtime', generation: 1, body: `body-${i}`, command: 'normal', state: 'withdrawn', eventId: `event-${i}`, createdAt: `2026-01-0${i + 1}T00:00:00.000Z` }); state.channelEvents.push(event(`event-${i}`)); } });
    await store.prune!(2); const db = new DatabaseSync(store.file); expect((db.prepare('SELECT count(*) AS count FROM deliveries').get() as any).count).toBe(4); expect((db.prepare('SELECT count(*) AS count FROM channel_events').get() as any).count).toBe(4); expect((db.prepare('SELECT count(*) AS count FROM event_journal').get() as any).count).toBe(4); db.close(); store.close();
  });

  it('backs up, exports and idempotently imports copied legacy sources without changing them', async () => {
    const source = await root(); const dbDir = await root();
    const legacy = { actors: [{ id: 'actor-1', clientIdentity: 'owner', label: 'Owner', createdAt: '2026-01-01T00:00:00.000Z' }], channelEvents: [event('legacy-event')], credentials: { hash: 'credential-secret' } };
    await writeFile(path.join(source, 'arcp-state.json'), JSON.stringify(legacy, null, 2)); await writeFile(path.join(source, 'reminders.json'), JSON.stringify([{ id: 'reminder-1', message: 'reminder content' }])); await writeFile(path.join(source, 'reminders.jsonl'), '{"id":"reminder-2","message":"line"}\n');
    const before = await readFile(path.join(source, 'arcp-state.json')); const store = new SQLiteStateStore(dbDir); await store.init();
    const first = await store.importLegacy(source); expect(first).toMatchObject({ imported: true, noop: false, state: { match: true } }); expect(first.sources.filter((item) => item.file !== 'arcp-state.json')).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'reminders.json', records: 1, match: true }), expect.objectContaining({ file: 'reminders.jsonl', records: 1, match: true })]));
    const importedDb = new DatabaseSync(store.file); expect((importedDb.prepare('SELECT count(*) AS count FROM legacy_reminders').get() as any).count).toBe(2); expect((importedDb.prepare('SELECT count(*) AS count FROM legacy_records').get() as any).count).toBe(2); expect(String((importedDb.prepare('SELECT payload FROM legacy_reminders').all() as any[])[0].payload)).not.toContain('reminder content'); importedDb.close(); expect((await readFile(path.join(source, 'arcp-state.json'))).equals(before)).toBe(true);
    expect(await store.importLegacy(source)).toMatchObject({ imported: false, noop: true }); expect(store.export('finding').events).toHaveLength(1);
    const backup = path.join(dbDir, 'backup.sqlite'); await store.backupTo(backup); expect((await stat(backup)).mode & 0o777).toBe(0o600); const backupDb = new DatabaseSync(backup); expect((backupDb.prepare('SELECT count(*) AS count FROM event_journal').get() as any).count).toBe(1); backupDb.close();
    const raw = await readFile(store.file); expect(raw.toString()).not.toContain('credential-secret'); expect(raw.toString()).not.toContain('reminder content'); store.close();
    const reopened = new SQLiteStateStore(dbDir); await reopened.init(); expect(reopened.export('finding').events).toHaveLength(1); expect(reopened.status().schemaVersion).toBe(4); reopened.close();
  });

  it('reuses one hashed content row for an imported Result and identical task candidate event', async () => {
    const source = await root(); const dbDir = await root();
    const summary = 'copied candidate content'; const evidenceRefs: string[] = [];
    const contentHash = createHash('sha256').update(JSON.stringify({ summary, evidenceRefs })).digest('hex');
    const result = { id: 'result-copied', workspaceId: 'workspace-1', taskId: 'task-1', memberId: 'member-1', fence: 1, status: 'candidate' as const, summary, evidenceRefs, createdAt: '2026-01-01T00:00:00.000Z' };
    const candidate = { ...event('candidate-copied', summary), kind: 'task_candidate' as const, decisionRequired: true, resultId: result.id, content: { summary, evidenceRefs, contentHash, sensitivity: 'normal' as const, retention: 'standard' as const } };
    await writeFile(path.join(source, 'arcp-state.json'), JSON.stringify({ results: [result], channelEvents: [candidate] }, null, 2));
    const before = await readFile(path.join(source, 'arcp-state.json')); const beforeHash = createHash('sha256').update(before).digest('hex');
    const store = new SQLiteStateStore(dbDir); await store.init();
    expect(await store.importLegacy(source)).toMatchObject({ imported: true, noop: false });
    const db = new DatabaseSync(store.file);
    const refs = db.prepare('SELECT r.content_id AS result_content, c.content_id AS event_content FROM results r JOIN channel_events c ON c.event_id = (SELECT event_id FROM event_journal WHERE result_id = r.id) WHERE r.id = ?').get(result.id) as any;
    expect(refs.result_content).toBe(refs.event_content);
    expect((db.prepare('SELECT count(*) AS count FROM content').get() as any).count).toBe(1);
    expect(store.check()).toMatchObject({ quickCheck: 'ok', integrityCheck: 'ok' });
    db.close();
    const after = await readFile(path.join(source, 'arcp-state.json')); expect(after.equals(before)).toBe(true); expect(createHash('sha256').update(after).digest('hex')).toBe(beforeHash);
    expect(await store.importLegacy(source)).toMatchObject({ imported: false, noop: true });
    const afterSecond = await readFile(path.join(source, 'arcp-state.json')); expect(afterSecond.equals(before)).toBe(true); expect(createHash('sha256').update(afterSecond).digest('hex')).toBe(beforeHash);
    store.close();
  });

  it('does not mutate an existing database when a copied import is invalid', async () => {
    const source = await root(); const dir = await root(); const store = new SQLiteStateStore(dir); await store.init();
    await store.mutate((state) => state.channelEvents.push(event('existing'))); await writeFile(path.join(source, 'arcp-state.json'), '{not-json');
    await expect(store.importLegacy(source)).rejects.toThrow(); expect(store.status().tables.event_journal).toBe(1); store.close();
  });

  it('rejects wholesale imports into non-empty SQLite targets unless overwrite is explicit', async () => {
    const source = await root(); const dir = await root();
    await writeFile(path.join(source, 'arcp-state.json'), JSON.stringify({ channelEvents: [event('incoming')] }, null, 2));
    const store = new SQLiteStateStore(dir); await store.init(); await store.mutate((state) => state.channelEvents.push(event('existing')));
    await expect(store.importLegacy(source)).rejects.toThrow(/target is not empty; pass --overwrite/);
    expect(store.snapshot().channelEvents.map((item) => item.id)).toEqual(['existing']);
    const report = await store.importLegacy(source, { overwrite: true });
    expect(report).toMatchObject({ imported: true, noop: false, displacedRecords: 1 });
    expect(store.snapshot().channelEvents.map((item) => item.id)).toEqual(['incoming']);
    store.close();
  });

  it('rejects an import when a normalized projection drops a record during persistence', async () => {
    const source = await root(); const dir = await root();
    await writeFile(path.join(source, 'arcp-state.json'), JSON.stringify({ channelEvents: [event('kept'), event('dropped')] }));
    const store = new SQLiteStateStore(dir); await store.init();
    const original = (store as any).persistEvents;
    (store as any).persistEvents = function (events: unknown[]) { return original.call(this, events.slice(0, 1)); };
    await expect(store.importLegacy(source)).rejects.toThrow(/expected 2 records \(hash [0-9a-f]{64}\), actual 1 records \(hash [0-9a-f]{64}\); first difference: state\.channelEvents\.length: expected 2, actual 1/);
    expect(store.status().tables.event_journal).toBe(0);
    store.close();
  });

  it('audits every durable field after reopening a realistic campaign state', async () => {
    // A self-contained state that exercises every redaction and every collection.
    // It must never read the live campaign store: that would couple a committed
    // test to machine-local data and make the assertion depend on unrelated
    // campaign activity.
    const source: any = {
      actors: [{ id: 'actor-1', clientIdentity: 'owner', label: 'Owner', createdAt: '2026-01-01T00:00:00.000Z' }],
      bindings: [{ id: 'binding-1', actorId: 'actor-1', channel: 'local', generation: 1, createdAt: '2026-01-01T00:00:00.000Z' }],
      credentials: { 'actor-1': 'secret-actor-credential' },
      workspaces: [{ id: 'workspace-1', purpose: 'audit', lifecycle: 'active', ownerActorId: 'actor-1', ownerMemberId: 'member-1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      members: [{ id: 'member-1', workspaceId: 'workspace-1', actorId: 'actor-1', joinKind: 'native', label: 'Owner', role: 'owner', capabilities: ['read_context'], lifecycle: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      memberCredentials: { 'member-1': 'secret-member-credential' },
      tasks: [{ id: 'task-1', workspaceId: 'workspace-1', title: 'audit task', lifecycle: 'claimed', ownerMemberId: 'member-1', fence: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      knowledge: [{ id: 'knowledge-1', workspaceId: 'workspace-1', authorMemberId: 'member-1', kind: 'learning', text: 'tagged learning', tags: ['campaign', 'audit'], createdAt: '2026-01-01T00:00:00.000Z' }],
      results: [{ id: 'result-1', workspaceId: 'workspace-1', taskId: 'task-1', memberId: 'member-1', fence: 1, status: 'candidate', summary: 'candidate summary', evidenceRefs: ['ref-1'], createdAt: '2026-01-01T00:00:00.000Z' }],
      goals: [{ id: 'goal-1', actorId: 'actor-1', title: 'audit goal', workspaceId: 'workspace-1', state: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      sessions: [{ id: 'runtime-1', actorId: 'actor-1', goalId: 'goal-1', taskId: 'task-1', bindingId: 'binding-1', generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', workspaceId: 'workspace-1', memberId: 'member-1', profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', workspace: '/private/local/path', state: 'idle', createdAt: '2026-01-01T00:00:00.000Z' }],
      deliveries: [{ id: 'delivery-1', fromActorId: 'actor-1', runtimeSessionId: 'runtime-1', generation: 1, body: 'a prompt body that must never persist', command: 'normal', state: 'waiting_safe_point', createdAt: '2026-01-01T00:00:00.000Z' }],
      channelEvents: [event('event-1', 'audit event')],
      confirmations: [],
      supervisionPolicies: [{ id: 'policy-1', workspaceId: 'workspace-1', reviewAfterMs: 60_000, inactivityAfterMs: 30_000, cooldownMs: 90_000, stewardProfileId: 'codex-worker', automatic: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      supervisionReviews: [{ id: 'supervision-1', workspaceId: 'workspace-1', policyId: 'policy-1', subjectKind: 'task', subjectId: 'task-1', generation: 1, reason: 'inactivity_budget', eventId: 'event-1', breachedAt: '2026-01-01T00:01:00.000Z', lastProgressAt: '2026-01-01T00:00:00.000Z', cooldownUntil: '2026-01-01T00:02:30.000Z', state: 'open' }],
      supervisionSignals: [{ id: 'signal-1', workspaceId: 'workspace-1', subjectId: 'task-1', kind: 'commit', digest: 'e923c2c', observedAt: '2026-01-01T00:00:00.000Z' }],
      executionSurfaces: [{ id: 'surface-1', repositoryId: 'remote:example/repository', checkout: { id: 'checkout-1', repositoryId: 'remote:example/repository', path: '/private/checkout' }, kind: 'working', operationalState: 'accepted', visibilityState: 'visible', adapterBindings: { paseo: { projectId: 'prj-1', workspaceId: 'wks-1' } }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z' }],
      surfaceClaims: [{ id: 'claim-1', executionSurfaceId: 'surface-1', runtimeSessionId: 'runtime-1', holder: 'runtime-1', mode: 'writer', active: false, createdAt: '2026-01-01T00:00:00.000Z', releasedAt: '2026-01-01T00:01:00.000Z' }],
      runtimeBindings: [{ id: 'runtime-binding-1', executionSurfaceId: 'surface-1', runtimeSessionId: 'runtime-1', adapterId: 'paseo', nativeId: 'paseo-agent-1', generation: 1, state: 'retired', visibilityState: 'visible', createdAt: '2026-01-01T00:00:00.000Z' }],
    };
    const expected = structuredClone(source);
    expected.credentials = {};
    expected.memberCredentials = {};
    expected.sessions = expected.sessions.map(({ workspace, ...session }: any) => session);
    expected.deliveries = expected.deliveries.map((delivery: any) => ({ ...delivery, body: '' }));
    Object.assign(expected.channelEvents[0], { priority: 'normal', consumptionPolicy: 'consume_on_delivery', consumptionState: 'open', expectedAction: { kind: 'none', instruction: 'No reply required — this message is consumed when delivered.' }, dispositions: [] });

    const sourceDir = await root();
    await writeFile(path.join(sourceDir, 'arcp-state.json'), JSON.stringify(source));
    const dir = await root(); const store = new SQLiteStateStore(dir); await store.init();
    const report = await store.importLegacy(sourceDir);
    expect(report.state.match).toBe(true);
    store.close();
    const reopened = new SQLiteStateStore(dir); await reopened.init();
    const snapshot: any = reopened.snapshot();
    // The store canonicalizes the content address on import, so the fixture's
    // placeholder digest is expected to change. Assert it is a real digest and
    // adopt it, then require every other durable field to match exactly.
    const persistedHash = snapshot.channelEvents[0].content.contentHash;
    expect(persistedHash).toMatch(/^[0-9a-f]{64}$/);
    expected.channelEvents[0].content.contentHash = persistedHash;
    // Legacy sources predate DocumentArtifacts, so they import as empty.
    expected.documents = [];
    expected.documentRevisions = [];
    expect(snapshot).toEqual(expected);
    expect(snapshot.knowledge.some((entry: any) => entry.tags.length > 0)).toBe(true);
    reopened.close();
  });
});
