import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PaseoCli, asRecord } from './cli.js';
import { Store } from './store.js';
import type { ScheduleObserver } from './schedule-observer.js';
import { ProcessWaitSourceDetector } from './wait-source.js';
import type { WaitSourceDetector } from './wait-source.js';
import type { AgentInfo, ChildrenResult, FailedCandidate, IdleReminderRecord, LedgerType, MessageRecord, MessageScheduleRecord, MessageUrgency, ReminderKind, ReminderRecord, WakeupSourceRecord, WatchdogSnapshot } from './types.js';

const REMINDER_TTL = '30m';
const REMINDER_MAX_TTL_SECONDS = 2 * 60 * 60;
type MessageScheduleInspection = {
  state: 'live' | 'running' | 'success' | 'failed' | 'missing' | 'unknown';
  hasRun: boolean;
};
type HeartbeatRun = Record<string, any>;
type HeartbeatInspection = {
  state: 'live' | 'running' | 'missing' | 'unknown';
  schedule: Record<string, any>;
  runs: HeartbeatRun[];
};

function json(value: unknown): string { return JSON.stringify(value, null, 2); }
function lowerStatus(value: any): string { return String(value ?? '').toLowerCase(); }
function cronForDelay(seconds: number): string {
  const minutes = Math.max(1, Math.min(60, Math.ceil(seconds / 60)));
  return minutes >= 60 ? '0 * * * *' : `*/${minutes} * * * *`;
}
function ttlForDelay(seconds: number): string {
  const ttl = Math.max(60, Math.min(REMINDER_MAX_TTL_SECONDS, Math.max(seconds * 2, 30 * 60)));
  return `${Math.ceil(ttl / 60)}m`;
}
function expiresInSeconds(value: string): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const multiplier = ({ s: 1, m: 60, h: 60 * 60, d: 24 * 60 * 60 } as Record<string, number>)[match[2]];
  const seconds = amount * multiplier;
  return Number.isSafeInteger(amount) && Number.isFinite(seconds) ? seconds : undefined;
}
function reminderExpired(reminder: ReminderRecord, now = Date.now()): boolean {
  const ttl = expiresInSeconds(reminder.expiresIn);
  const created = Date.parse(reminder.createdAt);
  return ttl !== undefined && Number.isFinite(created) && created + ttl * 1000 <= now;
}
function deterministicName(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}
function unwrapPayload(value: unknown): Record<string, any> {
  const record = asRecord(value);
  return record.payload && typeof record.payload === 'object' ? asRecord(record.payload) : record;
}

export class CompanionService {
  readonly cli: PaseoCli;
  readonly store: Store;
  readonly startedAt = new Date().toISOString();
  private reconcileTimer?: NodeJS.Timeout;
  private messageReconcileTimer?: NodeJS.Timeout;
  private lastReconcileAt?: string;
  private port = Number(process.env.PORT || 0);
  private observers = new Set<AbortController>();
  private childWatchInFlight = new Map<string, Promise<unknown>>();
  /** Successful candidate-parent observations; child candidates are refreshed each listing. */
  private childParentCache = new Map<string, string>();
  private messageInFlight = new Map<string, Promise<void>>();
  private immediateDeliveries = new Set<string>();
  private heartbeatReconcileInFlight?: Promise<void>;
  private parkReconcileInFlight = new Map<string, Promise<boolean>>();
  private readonly scheduleObserver?: ScheduleObserver;
  private readonly waitSourceDetector: WaitSourceDetector;
  private readonly watchdogStaleMs: number;

  constructor(cli = new PaseoCli(), store = new Store(), scheduleObserver?: ScheduleObserver, waitSourceDetector: WaitSourceDetector = new ProcessWaitSourceDetector(), options: { watchdogStaleMs?: number } = {}) {
    this.cli = cli; this.store = store; this.scheduleObserver = scheduleObserver; this.waitSourceDetector = waitSourceDetector;
    this.watchdogStaleMs = options.watchdogStaleMs ?? Number(process.env.PASEO_WATCHDOG_STALE_MS || 45 * 60 * 1000);
  }
  async init(): Promise<void> {
    await this.store.init();
    await this.reconcileReminders();
    await this.reconcileMessages();
    await this.store.pruneMessageSchedules();
    this.reconcileTimer = setInterval(() => { void this.reconcileOnce(); }, 180_000);
    this.reconcileTimer.unref();
    this.messageReconcileTimer = setInterval(() => { void this.reconcileMessages(); }, 15_000);
    this.messageReconcileTimer.unref();
  }
  close(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.messageReconcileTimer) clearInterval(this.messageReconcileTimer);
    for (const controller of this.observers) controller.abort();
    this.observers.clear();
    if (this.scheduleObserver && 'close' in this.scheduleObserver && typeof this.scheduleObserver.close === 'function') void this.scheduleObserver.close();
  }
  setPort(port: number): void { this.port = port; }
  health(): Record<string, unknown> {
    return { status: 'ok', uptimeSeconds: Math.floor((Date.now() - Date.parse(this.startedAt)) / 1000), startedAt: this.startedAt, lastReconcileAt: this.lastReconcileAt ?? null };
  }
  runtime(): Record<string, unknown> {
    return { pid: process.pid, cwd: process.cwd(), dataDir: this.store.dir, port: this.port || Number(process.env.PORT || 8787) };
  }

  async listChildren(agentId: string): Promise<ChildrenResult> {
    await this.store.addManager(agentId);
    let candidates: unknown[];
    const failedCandidates: FailedCandidate[] = [];
    try {
      const lsResult = await this.cli.run(['ls', '-g', '--json'], { timeoutMs: 10_000 });
      candidates = Array.isArray(lsResult.value) ? lsResult.value : [];
      if (!Array.isArray(lsResult.value)) failedCandidates.push({ id: '<ls>', error: 'paseo ls returned a non-array response', category: 'invalid-response' });
    } catch (error) {
      failedCandidates.push(this.failedCandidate('<ls>', error));
      candidates = [];
    }
    const children: AgentInfo[] = [];
    let next = 0;
    const worker = async () => {
      while (true) {
        const index = next++;
        if (index >= candidates.length) return;
        const c = asRecord(candidates[index]);
        const id = String(c.id ?? c.agentId ?? '');
        if (!id) {
          failedCandidates.push({ id: '<unknown>', error: 'paseo ls candidate has no id', category: 'invalid-response' });
          continue;
        }
        try {
          const cachedParent = this.childParentCache.get(id);
          if (cachedParent !== undefined && cachedParent !== agentId) continue;
          const inspected = await this.inspectWithRetry(id);
          const parent = inspected.ParentAgentId ?? inspected.parentAgentId;
          const observedParent = Object.prototype.hasOwnProperty.call(inspected, 'ParentAgentId')
            || Object.prototype.hasOwnProperty.call(inspected, 'parentAgentId');
          if (observedParent) this.childParentCache.set(id, String(parent ?? ''));
          if (String(parent ?? '') !== agentId) continue;
          const status = String(inspected.Status ?? inspected.status ?? c.status ?? 'unknown');
          const childId = String(inspected.Id ?? inspected.id ?? id);
          const createdAt = String(inspected.CreatedAt ?? inspected.createdAt ?? c.CreatedAt ?? c.createdAt ?? '');
          const createdMs = Date.parse(createdAt);
          const startedMs = Date.parse(this.startedAt);
          if (!this.store.isChildWatchOptedOut(agentId, childId) && !this.store.isTrackedChild(agentId, childId)
            && Number.isFinite(createdMs) && Number.isFinite(startedMs) && createdMs > startedMs) {
            await this.store.trackChild(agentId, childId, 'auto');
          }
          const [resolvedCwd, hasLivePaseoWait, hasLiveCompanionWatch, parked] = await Promise.all([
            this.resolveChildCwd(inspected, c),
            this.hasLivePaseoWait(childId),
            this.hasLiveCompanionWatch(childId),
            this.isParked(childId, status, inspected.UpdatedAt ?? inspected.updatedAt),
          ]);
          const tracked = this.store.getTrackedChildren(agentId).find((item) => item.childId === childId);
          const git = await this.gitSnapshot(resolvedCwd);
          const child: AgentInfo = {
            id: childId,
            status,
            tracked: Boolean(tracked),
            ...(Number.isFinite(createdMs) ? { createdAt } : {}),
            ...(tracked
              ? { trackedSource: tracked.source, trackedAddedAt: tracked.addedAt, source: tracked.source, addedAt: tracked.addedAt }
              : {}),
            updatedAt: inspected.UpdatedAt ?? inspected.updatedAt,
            ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
            ...((this.pathCandidate(inspected.Worktree ?? inspected.worktree) ?? this.pathCandidate(c.Worktree ?? c.worktree)) ? { worktree: this.pathCandidate(inspected.Worktree ?? inspected.worktree) ?? this.pathCandidate(c.Worktree ?? c.worktree) } : {}),
            parked,
            hasLivePaseoWait,
            hasLiveCompanionWatch,
            hasLiveWakeupSource: this.unionLiveSources(hasLivePaseoWait, hasLiveCompanionWatch),
            gitDirty: git.gitDirty,
            ...(git.latestCommit ? { latestCommit: git.latestCommit } : {}),
          };
          children.push(child);
        } catch (error) {
          failedCandidates.push(this.failedCandidate(id, error));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, Math.max(1, candidates.length)) }, () => worker()));
    const selfWakeupSources = [];
    for (const reminder of this.store.getReminders()) {
      const childWatch = reminder.kind === 'child-watch' || reminder.watchKind === 'child' || Boolean(reminder.subjectChildId);
      if (!childWatch && reminder.kind !== 'watchdog' && reminder.kind !== 'heartbeat-recovery' && reminder.agentId === agentId && reminder.status === 'active' && await this.probeReminder(reminder) === true) selfWakeupSources.push(reminder);
    }
    // Idle reminders are local, durable wakeup sources rather than Paseo
    // heartbeat schedules. Treat an active one as a live source for watchdog
    // coverage so a configured idle nudge prevents a false "bare runner" alert.
    for (const reminder of this.store.getIdleReminders()) {
      if (reminder.agentId === agentId && reminder.status === 'active') {
        selfWakeupSources.push({
          id: reminder.id, agentId, name: `idle-reminder-${reminder.id.slice(0, 8)}`,
          prompt: reminder.message, cron: '', expiresIn: '', status: 'active' as const, createdAt: reminder.createdAt,
        });
      }
    }
    // Heartbeats created outside this process are only considered wakeup
    // sources after an explicit registration and a probe using their original
    // cadence.  The CLI cannot enumerate agent-scoped heartbeats for us.
    for (const source of this.store.getWakeupSources(agentId)) {
      if (await this.probeWakeupSource(source)) {
        selfWakeupSources.push({
          id: source.heartbeatId, daemonId: source.heartbeatId, agentId,
          name: `registered-wakeup-${source.heartbeatId.slice(0, 8)}`,
          prompt: 'Registered external wakeup source', cron: this.wakeupCron(source.cadence),
          expiresIn: '', status: 'active' as const, alive: true, createdAt: source.registeredAt,
        });
      }
    }
    const wakeupSourcesNote = 'companionKnownWakeupSources lists only companion-created and explicitly registered sources; external heartbeats are omitted unless PUT /wakeup-sources registers them.';
    return { children, companionKnownWakeupSources: selfWakeupSources, selfWakeupSources, wakeupSourcesComplete: false, wakeupSourcesNote, partial: failedCandidates.length > 0, failedCandidates };
  }

  private wakeupCron(cadence: string): string {
    return cadence.startsWith('cron:') ? cadence.slice('cron:'.length) : cadence;
  }

  private async probeWakeupSource(source: WakeupSourceRecord): Promise<boolean> {
    const probedAt = new Date().toISOString();
    try {
      const result = asRecord((await this.cli.run([
        'heartbeat', 'update', source.heartbeatId, '--cron', this.wakeupCron(source.cadence), '--json',
      ], { agentId: source.agentId, timeoutMs: 5_000 })).value);
      const payload = unwrapPayload(result);
      const status = lowerStatus(payload.status ?? payload.state ?? payload.Status);
      const active = status === 'active';
      await this.store.upsertWakeupSource({
        ...source, status: active ? 'active' : 'dead', lastProbedAt: probedAt,
        ...(active ? { lastProbeError: undefined } : { lastProbeError: `heartbeat status=${status || 'unknown'}` }),
      });
      return active;
    } catch (error) {
      await this.store.upsertWakeupSource({
        ...source, status: 'dead', lastProbedAt: probedAt,
        lastProbeError: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async registerWakeupSource(heartbeatId: string, agentId: string, cadence: string): Promise<WakeupSourceRecord> {
    if (!heartbeatId?.trim() || !agentId?.trim() || !cadence?.trim()) throw new Error('heartbeatId, agentId, and cadence are required');
    const source = await this.store.upsertWakeupSource({
      heartbeatId: heartbeatId.trim(), agentId: agentId.trim(), cadence: cadence.trim(), status: 'dead', registeredAt: new Date().toISOString(),
    });
    await this.probeWakeupSource(source);
    return this.store.getWakeupSource(source.heartbeatId)!;
  }

  async listWakeupSources(agentId?: string): Promise<WakeupSourceRecord[]> {
    const sources = this.store.getWakeupSources(agentId);
    for (const source of sources) await this.probeWakeupSource(source);
    return this.store.getWakeupSources(agentId);
  }

  async deleteWakeupSource(heartbeatId: string, agentId?: string): Promise<{ heartbeatId: string; status: 'deleted' }> {
    const source = this.store.getWakeupSource(heartbeatId);
    if (!source || (agentId && source.agentId !== agentId)) throw new Error('wakeup source not found');
    await this.store.removeWakeupSource(heartbeatId);
    return { heartbeatId, status: 'deleted' };
  }

  private async inspectWithRetry(id: string): Promise<Record<string, any>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const value = asRecord((await this.cli.run(['inspect', id, '--json'], { timeoutMs: 5_000 })).value);
        if (!Object.keys(value).length) throw new Error('paseo inspect returned an empty response');
        return value;
      } catch (error) { lastError = error; }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private failedCandidate(id: string, error: unknown): FailedCandidate {
    const message = error instanceof Error ? error.message : String(error);
    return { id, error: message, category: /timed out|timeout/i.test(message) ? 'timeout' : (/empty response|non-array/i.test(message) ? 'invalid-response' : 'cli-error') };
  }

  /**
   * A live source is either a proven-live companion reminder or an externally
   * armed `paseo wait <full-agent-id>` process. Any failed inspection is
   * `unknown`, and reconciliation fails closed instead of adding a duplicate.
   */
  private async hasLiveCompanionWatch(childId: string, ignoreReminderId?: string): Promise<boolean | 'unknown'> {
    let unknown = false;
    let live = false;
    for (const reminder of this.store.getReminders()) {
      if (reminder.id === ignoreReminderId || !reminder.subjectChildId || reminder.subjectChildId !== childId || (reminder.kind !== 'child-watch' && reminder.watchKind !== 'child')) continue;
      if (reminder.status !== 'active') continue;
      const state = await this.probeReminder(reminder);
      if (state === true) live = true;
      if (state === 'unknown') unknown = true;
    }
    return live ? true : (unknown ? 'unknown' : false);
  }

  private async hasLivePaseoWait(agentId: string): Promise<boolean | 'unknown'> {
    try { return await this.waitSourceDetector.detect(agentId); } catch { return 'unknown'; }
  }

  private async hasLiveWakeupSource(agentId: string): Promise<boolean | 'unknown'> {
    const [wait, companion] = await Promise.all([this.hasLivePaseoWait(agentId), this.hasLiveCompanionWatch(agentId)]);
    return this.unionLiveSources(wait, companion);
  }
  private unionLiveSources(wait: boolean | 'unknown', companion: boolean | 'unknown'): boolean | 'unknown' {
    if (wait === true || companion === true) return true;
    if (wait === 'unknown' || companion === 'unknown') return 'unknown';
    return false;
  }

  /** Compatibility alias retained for callers from the previous rounds. */
  private async hasLiveWakeup(agentId: string): Promise<boolean | 'unknown'> {
    let unknown = false;
    let local = false;
    for (const reminder of this.store.getReminders()) {
      // Child watches are delivered to their manager, so subjectChildId is the
      // wakeup identity for this query while agentId remains the delivery identity.
      const matches = reminder.subjectChildId === agentId && (reminder.kind === 'child-watch' || reminder.watchKind === 'child');
      if (matches && reminder.status === 'active') {
        const live = await this.probeReminder(reminder);
        if (live === true) local = true;
        if (reminder.alive === 'unknown') unknown = true;
      }
    }
    const external = await this.hasLivePaseoWait(agentId);
    // Always inspect both sources. A proven external wait wins over an
    // uncertain local reminder; uncertainty propagates only when no source is
    // proven live.
    if (external === true || local) return true;
    if (unknown) return 'unknown';
    return external;
  }
  private async gitSnapshot(cwd: unknown): Promise<{ gitDirty: boolean | 'unknown'; latestCommit?: string }> {
    if (typeof cwd !== 'string' || !cwd) return { gitDirty: 'unknown' };
    try {
      const [status, commit] = await Promise.all([runGit(['status', '--porcelain'], cwd), runGit(['rev-parse', 'HEAD'], cwd)]);
      return { gitDirty: Boolean(status.trim()), latestCommit: commit.trim() || undefined };
    } catch {
      return { gitDirty: 'unknown' };
    }
  }

  private pathCandidate(value: unknown): string | undefined {
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return this.pathCandidate(record.path ?? record.cwd ?? record.root ?? record.worktree);
    }
    if (typeof value !== 'string') return undefined;
    const candidate = value.trim();
    return candidate || undefined;
  }

  private async isGitRepo(cwd: string): Promise<boolean> {
    try { return (await runGit(['rev-parse', '--is-inside-work-tree'], cwd)).trim() === 'true'; } catch { return false; }
  }

  /** Resolve only explicitly reported worktrees or git repository cwds; never infer a parent/subdirectory. */
  private async resolveChildCwd(inspected: Record<string, any>, candidate: Record<string, any>): Promise<string | undefined> {
    const worktree = this.pathCandidate(inspected.Worktree ?? inspected.worktree ?? candidate.Worktree ?? candidate.worktree);
    if (worktree && await this.isGitRepo(worktree)) return worktree;
    return undefined;
  }

  private async isParked(childId: string, status: string, updatedAt: unknown): Promise<boolean> {
    const existing = this.parkReconcileInFlight.get(childId);
    if (existing) return existing;
    const operation = this.isParkedOnce(childId, status, updatedAt);
    this.parkReconcileInFlight.set(childId, operation);
    try { return await operation; } finally { this.parkReconcileInFlight.delete(childId); }
  }

  private async isParkedOnce(childId: string, status: string, updatedAt: unknown): Promise<boolean> {
    const parks = this.store.getLedger().filter((record) => record.type === 'park' && record.target === childId && !record.revokedAt);
    if (!parks.length) return false;
    const running = lowerStatus(status) === 'running';
    const updated = typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
    if (running && Number.isFinite(updated)) {
      const stale = parks.filter((park) => {
        const created = Date.parse(park.createdAt);
        return Number.isFinite(created) && updated > created;
      });
      for (const park of stale) {
        if (!park.revokedAt) await this.store.revokeLedger(park, 'child-resumed-after-park');
      }
      const active = this.store.getLedger().filter((record) => record.type === 'park' && record.target === childId && !record.revokedAt);
      if (!active.length) {
        try { await this.cli.run(['agent', 'update', childId, '--label', 'parked=false', '--json']); } catch { /* best effort */ }
        return this.store.getLedger().some((record) => record.type === 'park' && record.target === childId && !record.revokedAt);
      }
      return true;
    }
    return true;
  }
  private async probeReminder(reminder: ReminderRecord, childWatchPairLockHeld = false): Promise<boolean | 'unknown'> {
    if (reminderExpired(reminder)) {
      await this.store.updateReminder(reminder.id, { alive: false, status: 'dead' });
      return false;
    }
    // Child watches are local-poll subscriptions. They intentionally have no
    // daemon; the existing 180s reconciliation loop is their wakeup source.
    if (!reminder.daemonId && this.isChildWatch(reminder, reminder.agentId, reminder.subjectChildId ?? '')) return reminder.status === 'active';
    if (!reminder.daemonId) return false;
    try {
      const observation = await this.inspectHeartbeat(reminder);
      if (observation.state === 'missing') {
        if (reminder.subjectChildId && (reminder.kind === 'child-watch' || reminder.watchKind === 'child')) {
          await this.retireChildWatch(reminder);
          return false;
        }
        return this.rebuildMissingReminder(reminder, childWatchPairLockHeld);
      }
      if (observation.state === 'unknown') {
        await this.store.updateReminder(reminder.id, { alive: 'unknown' });
        return 'unknown';
      }
      await this.observeHeartbeatRuns(reminder, observation);
      const status = lowerStatus(observation.schedule.status ?? observation.schedule.State ?? observation.schedule.state);
      const terminalRuns = observation.runs.filter((run) => /success|succeed|complete|ok|fail|error|timeout|busy/.test(this.runStatus(run))).length;
      if (reminder.maxRuns !== undefined && terminalRuns >= reminder.maxRuns) {
        await this.store.updateReminder(reminder.id, { alive: false, status: 'deleted' });
        return false;
      }
      const alive = observation.state === 'running' || status === 'active';
      await this.store.updateReminder(reminder.id, { alive, status: alive ? 'active' : 'dead', nextRunAt: observation.schedule.nextRunAt ?? observation.schedule.nextRun, lastRunAt: observation.schedule.lastRunAt });
      return alive;
    } catch {
      await this.store.updateReminder(reminder.id, { alive: 'unknown' });
      return 'unknown';
    }
  }

  private normalizeRuns(value: unknown): HeartbeatRun[] {
    const record = unwrapPayload(value);
    const runs = Array.isArray(value) ? value : (record.logs ?? record.runs ?? record.entries ?? []);
    return Array.isArray(runs) ? runs.map(asRecord) : [];
  }

  private runStatus(run: HeartbeatRun): string {
    return lowerStatus(run.status ?? run.state ?? run.outcome ?? run.result);
  }

  private runTime(run: HeartbeatRun): string | undefined {
    const value = run.startedAt ?? run.scheduledFor;
    return typeof value === 'string' && value ? value : undefined;
  }

  private runId(run: HeartbeatRun, index: number): string {
    return String(run.id ?? run.runId ?? run.executionId ?? run.uuid ?? `${this.runTime(run) ?? 'run'}#${index}`);
  }

  private async inspectHeartbeat(reminder: ReminderRecord): Promise<HeartbeatInspection> {
    if (!reminder.daemonId) return { state: 'missing', schedule: {}, runs: [] };
    let schedule: Record<string, any>;
    try {
      const inspectedValue = this.scheduleObserver
        ? await this.scheduleObserver.scheduleInspect(reminder.daemonId)
        : (await this.cli.run(['schedule', 'inspect', reminder.daemonId, '--json'], { agentId: reminder.agentId, timeoutMs: 5_000 })).value;
      schedule = unwrapPayload(inspectedValue);
      if (schedule.error && schedule.schedule === null && /not found|missing/i.test(String(schedule.error))) return { state: 'missing', schedule, runs: [] };
      if (schedule.error && schedule.schedule === undefined) return { state: 'unknown', schedule, runs: [] };
      if (this.scheduleObserver && schedule.schedule && typeof schedule.schedule === 'object') schedule = asRecord(schedule.schedule);
      if (!Object.keys(schedule).length) return { state: 'unknown', schedule: {}, runs: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return /not found|no such schedule|unknown schedule|404/i.test(message)
        ? { state: 'missing', schedule: {}, runs: [] }
        : { state: 'unknown', schedule: {}, runs: [] };
    }
    const scheduleStatus = lowerStatus(schedule.status ?? schedule.State ?? schedule.state);
    if (['deleted', 'expired', 'missing', 'dead'].includes(scheduleStatus)) return { state: 'missing', schedule, runs: [] };
    let logsValue: unknown;
    try { logsValue = this.scheduleObserver
      ? await this.scheduleObserver.scheduleLogs(reminder.daemonId)
      : (await this.cli.run(['schedule', 'logs', reminder.daemonId, '--json'], { agentId: reminder.agentId, timeoutMs: 5_000 })).value; }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return /not found|no such schedule|unknown schedule|404/i.test(message)
        ? { state: 'missing', schedule, runs: [] }
        : { state: 'unknown', schedule, runs: [] };
    }
    const runs = this.normalizeRuns(logsValue);
    if (lowerStatus(runs.at(-1)?.status ?? runs.at(-1)?.state).match(/running|in.?progress|started/)) return { state: 'running', schedule, runs };
    if (/running|in.?progress|started/.test(scheduleStatus)) return { state: 'running', schedule, runs };
    return { state: 'live', schedule, runs };
  }

  private async observeHeartbeatRuns(reminder: ReminderRecord, observation: HeartbeatInspection): Promise<void> {
    const observed = new Set(reminder.observedRunIds ?? []);
    const missedRunIds = new Set(reminder.missedRunIds ?? []);
    let lastFiredAt = reminder.lastFiredAt;
    let lastDeliveredAt = reminder.lastDeliveredAt;
    let newestTime = lastFiredAt ? Date.parse(lastFiredAt) : -Infinity;
    for (let index = 0; index < observation.runs.length; index++) {
      const run = observation.runs[index];
      const id = this.runId(run, index);
      const time = this.runTime(run);
      const parsed = time ? Date.parse(time) : NaN;
      if (time && Number.isFinite(parsed) && parsed >= newestTime) { newestTime = parsed; lastFiredAt = time; }
      const status = this.runStatus(run);
      const terminal = /success|succeed|complete|ok|fail|error|timeout|busy/.test(status);
      if (!terminal || observed.has(id)) continue;
      observed.add(id);
      if (/fail|error|timeout|busy/.test(status)) missedRunIds.add(id);
      if (/success|succeed|complete|ok/.test(status) && time) lastDeliveredAt = time;
    }
    await this.store.updateReminder(reminder.id, {
      observedRunIds: [...observed].slice(-200), missedRunIds: [...missedRunIds].slice(-200), missedFires: missedRunIds.size, lastFiredAt, lastDeliveredAt,
      lastRunAt: observation.runs.length ? this.runTime(observation.runs.at(-1)!) : reminder.lastRunAt,
    });
  }

  private async findExistingSchedule(name: string, agentId: string): Promise<Record<string, any> | undefined | null> {
    try {
      const value = this.scheduleObserver
        ? await this.scheduleObserver.scheduleList()
        : (await this.cli.run(['schedule', 'ls', '--json'], { agentId, timeoutMs: 5_000 })).value;
      const record = unwrapPayload(value);
      if (record.error) return /not found|missing/i.test(String(record.error)) ? undefined : null;
      const rows = Array.isArray(value) ? value : (record.schedules ?? record.items ?? record.entries ?? []);
      if (!Array.isArray(rows)) return undefined;
      return rows.map(asRecord).find((item) => {
        if (String(item.name ?? item.Name ?? '') !== name) return false;
        const status = lowerStatus(item.status ?? item.Status);
        if (status && status !== 'active') return false;
        const target = asRecord(item.target);
        const targetId = String(target.agentId ?? item.agentId ?? item.target ?? '');
        return !targetId || targetId === agentId;
      });
    } catch { return null; }
  }

  private async rebuildMissingReminder(reminder: ReminderRecord, childWatchPairLockHeld = false): Promise<boolean | 'unknown'> {
    const pairKey = reminder.subjectChildId && (reminder.kind === 'child-watch' || reminder.watchKind === 'child')
      ? `${reminder.agentId}\0${reminder.subjectChildId}` : undefined;
    if (pairKey && !childWatchPairLockHeld) {
      const existing = this.childWatchInFlight.get(pairKey);
      if (existing) { await existing; return this.rebuildMissingReminder(reminder, true); }
      const operation = this.rebuildMissingReminder(reminder, true);
      this.childWatchInFlight.set(pairKey, operation);
      try { return await operation; } finally { if (this.childWatchInFlight.get(pairKey) === operation) this.childWatchInFlight.delete(pairKey); }
    }
    if (reminder.subjectChildId && (reminder.kind === 'child-watch' || reminder.watchKind === 'child') && this.store.isChildWatchOptedOut(reminder.agentId, reminder.subjectChildId)) {
      await this.store.clearReminderMissed(reminder.id);
      await this.store.updateReminder(reminder.id, { alive: false, status: 'deleted' });
      return false;
    }
    const originalTtl = expiresInSeconds(reminder.expiresIn);
    const createdAt = Date.parse(reminder.createdAt);
    const remainingSeconds = originalTtl !== undefined && Number.isFinite(createdAt)
      ? Math.ceil((createdAt + originalTtl * 1000 - Date.now()) / 1000) : undefined;
    if (remainingSeconds !== undefined && remainingSeconds <= 0) {
      await this.store.updateReminder(reminder.id, { alive: false, status: 'dead' });
      return false;
    }
    const rebuildExpiresIn = remainingSeconds === undefined ? reminder.expiresIn : `${remainingSeconds}s`;
    const adopted = await this.findExistingSchedule(reminder.name, reminder.agentId);
    if (adopted === null) { await this.store.updateReminder(reminder.id, { alive: 'unknown' }); return 'unknown'; }
    if (adopted) {
      const daemonId = String(adopted.id ?? adopted.scheduleId ?? adopted.heartbeatId ?? '');
      if (daemonId) {
        await this.store.updateReminder(reminder.id, { daemonId, status: 'active', alive: true, nextRunAt: adopted.nextRunAt ?? adopted.nextRun, lastRunAt: adopted.lastRunAt });
        const prior = this.store.getLedger().find((record) => record.type === 'known-red' && record.target === reminder.id && record.verdict === 'heartbeat-missing-rebuilt' && !record.revokedAt);
        if (!prior) await this.store.addLedger({ type: 'known-red', target: reminder.id, verdict: 'heartbeat-missing-rebuilt', reason: `registered heartbeat ${reminder.name} was missing and an existing schedule was adopted` });
        return true;
      }
    }
    try {
      const value = asRecord((await this.cli.run([
        'heartbeat', 'create', reminder.prompt, '--cron', reminder.cron, '--expires-in', rebuildExpiresIn,
        '--name', reminder.name, '--timezone', 'UTC', '--json',
      ], { agentId: reminder.agentId })).value);
      const daemonId = String(value.id ?? value.scheduleId ?? value.heartbeatId ?? '');
      if (!daemonId) { await this.store.updateReminder(reminder.id, { alive: false, status: 'dead' }); return false; }
      if (pairKey && this.store.isChildWatchOptedOut(reminder.agentId, reminder.subjectChildId!)) {
        let retired = true;
        try { await this.cli.run(['heartbeat', 'delete', daemonId, '--json'], { agentId: reminder.agentId }); } catch { retired = false; }
        await this.store.updateReminder(reminder.id, { daemonId, alive: retired ? false : 'unknown', status: retired ? 'deleted' : 'active' });
        return false;
      }
      await this.store.updateReminder(reminder.id, {
        daemonId, status: 'active', alive: true,
        ...(remainingSeconds !== undefined ? { expiresIn: rebuildExpiresIn, createdAt: new Date().toISOString() } : {}),
        nextRunAt: value.nextRunAt ?? value.nextRun, lastRunAt: value.lastRunAt,
      });
      const prior = this.store.getLedger().find((record) => record.type === 'known-red' && record.target === reminder.id && record.verdict === 'heartbeat-missing-rebuilt' && !record.revokedAt);
      if (!prior) await this.store.addLedger({ type: 'known-red', target: reminder.id, verdict: 'heartbeat-missing-rebuilt', reason: `registered heartbeat ${reminder.name} was missing and rebuilt` });
      return true;
    } catch {
      await this.store.updateReminder(reminder.id, { alive: false, status: 'dead' });
      return false;
    }
  }

  async spawn(body: { provider: string; model?: string; title: string; cwd: string; prompt: string; label?: string; waitTimeoutSeconds?: number }, managerId?: string): Promise<unknown> {
    await this.store.addManager(managerId);
    const args = ['run', '-d', '--provider', body.provider, ...(body.model ? ['--model', body.model] : []), '--title', body.title, '--cwd', body.cwd];
    if (body.label) args.push('--label', body.label);
    args.push('--json', body.prompt);
    const result = asRecord((await this.cli.run(args)).value);
    return { ...result, id: result.agentId ?? result.id };
  }

  async createReminder(body: { agentId: string; delaySeconds: number; message: string; context?: object; ackRequired?: boolean; subjectChildId?: string; kind?: ReminderKind; watchKind?: 'child'; name?: string; maxRuns?: number; eventType?: string; criterion?: string }): Promise<ReminderRecord> {
    await this.store.addManager(body.agentId);
    if (!Number.isFinite(body.delaySeconds) || body.delaySeconds <= 0) throw new Error('delaySeconds must be positive');
    if (body.maxRuns !== undefined && (!Number.isSafeInteger(body.maxRuns) || body.maxRuns <= 0)) throw new Error('maxRuns must be a positive integer');
    const localId = randomUUID();
    const cron = cronForDelay(body.delaySeconds);
    const expiresIn = ttlForDelay(body.delaySeconds);
    const endpointPort = this.port || Number(process.env.PORT || 8787);
    const ack = `curl -X DELETE http://127.0.0.1:${endpointPort}/reminders/${localId} -H 'content-type: application/json' -d '{"reason":"acknowledged"}'`;
    const prompt = [
      `type=reminder id=${localId} target=${body.agentId} event=${body.kind ?? 'generic'} criterion=wall-clock-delay:${body.delaySeconds}s triggeredAt=${new Date().toISOString()}`,
      body.message, body.context ? `Structured context: ${json(body.context)}` : 'Structured context: {}',
      `Cancel/acknowledge this reminder with: ${ack}`,
      body.maxRuns && body.maxRuns > 1 ? `This reminder repeats up to ${body.maxRuns} times; the next run follows its cron schedule.` : body.maxRuns === undefined ? 'This reminder repeats on its cron schedule; the next run is reported by the companion. Cancel it before the next run if no longer needed.' : '',
      body.ackRequired === false ? '' : 'Do not drop this reminder without an explicit acknowledgement.',
    ].filter(Boolean).join('\n');
    const pending: ReminderRecord = {
      id: localId,
      agentId: body.agentId,
      name: body.name ?? (body.kind === 'child-watch' && body.subjectChildId
        ? deterministicName('companion-child-watch', `${body.agentId}\0${body.subjectChildId}`)
        : `companion-reminder-${localId.slice(0, 8)}`),
      prompt,
      cron,
      expiresIn,
      status: 'pending',
      createdAt: new Date().toISOString(),
      ...(body.maxRuns !== undefined ? { maxRuns: body.maxRuns } : {}),
      ...(body.eventType ? { eventType: body.eventType } : {}),
      ...(body.criterion ? { criterion: body.criterion } : {}),
      ...(body.subjectChildId ? { subjectChildId: body.subjectChildId } : {}),
      ...(body.kind ? { kind: body.kind } : {}),
      ...(body.watchKind ? { watchKind: body.watchKind } : {}),
    };
    await this.store.addReminder(pending);
    try {
      const existing = await this.findExistingSchedule(pending.name, body.agentId);
      if (existing) {
        const existingId = String(existing.id ?? existing.scheduleId ?? existing.heartbeatId ?? '');
        if (existingId) {
          await this.store.updateReminder(localId, { daemonId: existingId, status: 'active', alive: true, nextRunAt: existing.nextRunAt ?? existing.nextRun, lastRunAt: existing.lastRunAt });
          return this.store.findReminder(localId)!;
        }
      }
      const value = asRecord((await this.cli.run(['heartbeat', 'create', prompt, '--cron', cron, '--expires-in', expiresIn, ...(body.maxRuns !== undefined ? ['--max-runs', String(body.maxRuns)] : []), '--name', pending.name, '--timezone', 'UTC', '--json'], { agentId: body.agentId })).value);
      await this.store.updateReminder(localId, { daemonId: String(value.id ?? value.heartbeatId ?? ''), status: 'active', alive: true, nextRunAt: value.nextRunAt, lastRunAt: value.lastRunAt });
      return this.store.findReminder(localId)!;
    } catch (error) {
      await this.store.updateReminder(localId, { status: 'dead' });
      throw error;
    }
  }

  async deleteReminder(id: string, reason: string): Promise<unknown> {
    const idle = this.store.findIdleReminder(id);
    if (idle) return this.deleteIdleReminder(id, reason);
    const reminder = this.store.findReminder(id);
    if (!reminder) throw new Error('reminder not found');
    const childWatch = Boolean(reminder.subjectChildId && (reminder.kind === 'child-watch' || reminder.watchKind === 'child'));
    const markDeleted = async () => {
      await this.store.clearReminderMissed(reminder.id);
      await this.store.updateReminder(reminder.id, { status: 'deleted', alive: false });
      if (childWatch) {
        // Any explicit DELETE of a child-watch is an operator opt-out. Keep
        // that intent durable so reconciliation and restart cannot recreate
        // the cancelled watch under the same child/event identity.
        // The child remains tracked independently; only its watch is opted out.
        await this.store.optOutChildWatch(reminder.agentId, reminder.subjectChildId!, reason);
        await this.suppressRecoveryForChild(reminder.agentId, reminder.subjectChildId!, [reminder.id]);
      }
      if (reminder.kind === 'heartbeat-recovery') {
        for (const source of this.store.getReminders().filter((item) => item.agentId === reminder.agentId && item.id !== reminder.id && (item.missedFires ?? 0) > 0)) await this.store.clearReminderMissed(source.id);
      }
      await this.store.addLedger({ type: 'deferred', target: reminder.agentId, verdict: 'reminder-deleted', reason });
      return { id: reminder.id, status: 'deleted' };
    };
    if (!reminder.daemonId) return markDeleted();
    if (this.scheduleObserver) {
      try {
        const observed = unwrapPayload(await this.scheduleObserver.scheduleInspect(reminder.daemonId));
        const status = lowerStatus(observed.status ?? observed.State ?? observed.state);
        if ((observed.schedule === null && /not found|missing/i.test(String(observed.error ?? ''))) || ['missing', 'deleted', 'expired', 'completed'].includes(status)) return markDeleted();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/(?:not found|no such schedule|unknown schedule|404)/i.test(message)) return markDeleted();
      }
    }
    let result: { value: unknown };
    try {
      result = await this.cli.run(['heartbeat', 'delete', reminder.daemonId, '--json'], { agentId: reminder.agentId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const locallyExpired = reminderExpired(reminder);
      const terminal = /(?:not found|no such schedule|unknown schedule|already expired|expired|completed|already completed|deleted)/i.test(message)
        || (locallyExpired && /schedule_request_failed/i.test(message));
      if (!terminal) throw error;
      return markDeleted();
    }
    await markDeleted();
    return result.value;
  }

  private cancelCommand(id: string): string {
    const endpointPort = this.port || Number(process.env.PORT || 8787);
    return `curl -X DELETE http://127.0.0.1:${endpointPort}/reminders/${id} -H 'content-type: application/json' -d '{"reason":"processed"}'`;
  }

  async createIdleReminder(body: { agentId: string; thresholdSeconds: number; message: string; once?: boolean }): Promise<IdleReminderRecord> {
    await this.store.addManager(body.agentId);
    if (!Number.isFinite(body.thresholdSeconds) || body.thresholdSeconds <= 0) throw new Error('thresholdSeconds must be positive');
    if (!body.message?.trim()) throw new Error('message is required');
    const record: IdleReminderRecord = {
      id: randomUUID(), agentId: body.agentId, message: body.message, thresholdSeconds: body.thresholdSeconds,
      once: body.once === true, status: 'active', createdAt: new Date().toISOString(),
    };
    await this.store.addIdleReminder(record);
    return record;
  }

  private async observeIdleReminder(reminder: IdleReminderRecord, now = Date.now()): Promise<IdleReminderRecord> {
    if (reminder.status !== 'active') return reminder;
    let status = '';
    let updated = '';
    try {
      const inspected = await this.inspectWithRetry(reminder.agentId);
      status = lowerStatus(inspected.Status ?? inspected.status);
      updated = String(inspected.UpdatedAt ?? inspected.updatedAt ?? '');
    } catch { return reminder; }
    if (status !== 'idle' || !updated) {
      if (reminder.idleSince || reminder.lastObservedUpdatedAt !== updated) {
        await this.store.updateIdleReminder(reminder.id, { idleSince: undefined, lastObservedUpdatedAt: updated || undefined });
      }
      return this.store.findIdleReminder(reminder.id)!;
    }
    const changed = reminder.lastObservedUpdatedAt !== updated;
    let current = reminder;
    if (changed || !reminder.idleSince) {
      current = await this.store.updateIdleReminder(reminder.id, { idleSince: new Date(now).toISOString(), lastObservedUpdatedAt: updated }) ?? reminder;
    }
    const since = current.idleSince ? Date.parse(current.idleSince) : NaN;
    if (!Number.isFinite(since) || now - since < current.thresholdSeconds * 1000) return current;
    const body = [
      `type=idle-reminder id=${current.id} target=${current.agentId} event=manager-idle criterion=status=idle and updatedAt unchanged for ${current.thresholdSeconds}s triggeredAt=${new Date(now).toISOString()}`,
      current.message,
      `Cancel this reminder with: ${this.cancelCommand(current.id)}`,
      current.once ? 'This reminder is one-shot and will self-delete after delivery.' : `This reminder repeats; after this delivery it will begin a new ${current.thresholdSeconds}s idle window.`,
    ].join('\n');
    await this.postMessage({ to: current.agentId, from: 'companion', body });
    if (current.once) {
      await this.store.updateIdleReminder(current.id, { status: 'deleted', idleSince: undefined, lastTriggeredAt: new Date(now).toISOString() });
    } else {
      await this.store.updateIdleReminder(current.id, { idleSince: undefined, lastTriggeredAt: new Date(now).toISOString() });
    }
    return this.store.findIdleReminder(current.id)!;
  }

  async listIdleReminders(agentId?: string): Promise<Array<IdleReminderRecord & { idleForSeconds: number; remainingSeconds: number }>> {
    const records = this.store.getIdleReminders().filter((item) => !agentId || item.agentId === agentId);
    const now = Date.now();
    const output: Array<IdleReminderRecord & { idleForSeconds: number; remainingSeconds: number }> = [];
    for (const record of records) {
      const observed = record.status === 'active' ? await this.observeIdleReminder(record, now) : record;
      const since = observed.idleSince ? Date.parse(observed.idleSince) : NaN;
      const idleForSeconds = Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
      output.push({ ...observed, idleForSeconds, remainingSeconds: Math.max(0, observed.thresholdSeconds - idleForSeconds) });
    }
    return output;
  }

  async deleteIdleReminder(id: string, reason: string): Promise<{ id: string; status: 'deleted' }> {
    if (!reason?.trim()) throw new Error('reason is required');
    const record = this.store.findIdleReminder(id);
    if (!record) throw new Error('idle reminder not found');
    if (record.status !== 'deleted') {
      await this.store.updateIdleReminder(id, { status: 'deleted', idleSince: undefined });
      await this.store.addLedger({ type: 'deferred', target: id, verdict: 'reminder-deleted', reason });
    }
    return { id, status: 'deleted' };
  }

  private async reconcileIdleReminders(): Promise<void> {
    for (const reminder of this.store.getIdleReminders().filter((item) => item.status === 'active')) await this.observeIdleReminder(reminder);
  }

  private watchdogReminderId(managerId: string, childId: string, eventType: string): string {
    return deterministicName('companion-watchdog', `${managerId}\0${childId}\0${eventType}`);
  }

  private async ensureWatchdogReminder(managerId: string, childId: string, eventType: string, criterion: string): Promise<ReminderRecord | undefined> {
    const id = this.watchdogReminderId(managerId, childId, eventType);
    const existing = this.store.findReminder(id);
    if (existing?.status === 'deleted') return undefined;
    if (existing) return existing;
    const record: ReminderRecord = {
      id, agentId: managerId, name: id, prompt: '', cron: '', expiresIn: '', status: 'active', createdAt: new Date().toISOString(),
      kind: 'watchdog', eventType, criterion,
    };
    await this.store.addReminder(record);
    return record;
  }

  private async notifyWatchdog(managerId: string, childId: string, eventType: string, criterion: string, detail: string, ephemeral: boolean, snapshot: WatchdogSnapshot): Promise<boolean> {
    const reminder = await this.ensureWatchdogReminder(managerId, childId, eventType, criterion);
    if (!reminder) return false;
    const notified = new Set(snapshot.notified ?? []);
    if (notified.has(eventType)) return false;
    const body = [
      `type=watchdog id=${reminder.id} target=${managerId} event=${eventType} criterion=${criterion} triggeredAt=${new Date().toISOString()}`,
      `snapshot: child=${snapshot.childId} status=${snapshot.status} updatedAt=${snapshot.updatedAt ?? 'unknown'} hasLivePaseoWait=${snapshot.hasLivePaseoWait ?? 'unknown'} gitDirty=${snapshot.gitDirty ?? 'unknown'} latestCommit=${snapshot.latestCommit ?? 'unknown'}`,
      detail,
      `Cancel this alert with: ${this.cancelCommand(reminder.id)}`,
      ephemeral ? 'This health alert is non-acknowledgement based; the alert ID remains cancellable.' : 'Acknowledge this completion alert after review; future matching transitions remain deduplicated by this ID.',
    ].join('\n');
    await this.postMessage({ to: managerId, from: 'companion', body, urgency: ephemeral ? 'urgent' : 'normal', ...(ephemeral ? { kind: 'heartbeat-recovery' as const } : {}) });
    snapshot.notified = [...notified, eventType];
    return true;
  }

  async watchdogTick(managerId: string, now = Date.now(), staleMs = this.watchdogStaleMs, listed?: ChildrenResult, managerWait?: boolean | 'unknown'): Promise<void> {
    const snapshotResult = listed ?? await this.listChildren(managerId);
    const running = snapshotResult.children.filter((child) => lowerStatus(child.status) === 'running');
    const activeChildren = new Set(snapshotResult.children.map((child) => child.id));
    for (const child of snapshotResult.children) {
      const prior = this.store.getWatchdogSnapshot(managerId, child.id);
      const snapshot: WatchdogSnapshot = { managerId, childId: child.id, status: child.status, updatedAt: child.updatedAt, hasLivePaseoWait: child.hasLivePaseoWait, gitDirty: child.gitDirty, latestCommit: child.latestCommit, notified: [...(prior?.notified ?? [])] };
      const status = lowerStatus(child.status);
      const previousStatus = lowerStatus(prior?.status);
      if (child.tracked && prior && previousStatus === 'running' && ['idle', 'closed'].includes(status)) {
        await this.notifyWatchdog(managerId, child.id, 'child-completed', 'previous status=running and current status=idle|closed', `child=${child.id} ${prior.status}→${child.status}, lastUpdatedAt=${child.updatedAt ?? 'unknown'}`, false, snapshot);
      }
      const fallbackArmed = child.tracked && this.store.getReminders().some((reminder) => this.isChildWatch(reminder, managerId, child.id) && reminder.status === 'active' && !reminder.daemonId);
      const waitLost = child.tracked && status === 'running' && prior?.hasLivePaseoWait === true && child.hasLivePaseoWait === false;
      if (waitLost && fallbackArmed) {
        await this.notifyWatchdog(managerId, child.id, 'child-wait-lost', 'running tracked child transitioned hasLivePaseoWait=true→false', `child=${child.id} paseo wait disappeared; using 300s polling fallback, latency bound immediate→5 minutes`, true, snapshot);
      } else if (child.hasLivePaseoWait === true) snapshot.notified = (snapshot.notified ?? []).filter((item) => item !== 'child-wait-lost');
      const noWakeup = status === 'running' && child.hasLiveWakeupSource === false;
      if (noWakeup) await this.notifyWatchdog(managerId, child.id, 'child-no-wakeup', 'status=running and hasLiveWakeupSource=false', `child=${child.id} running without a live wakeup source, lastUpdatedAt=${child.updatedAt ?? 'unknown'}`, true, snapshot);
      else snapshot.notified = (snapshot.notified ?? []).filter((item) => item !== 'child-no-wakeup');
      const updatedMs = child.updatedAt ? Date.parse(child.updatedAt) : NaN;
      const stale = status === 'running' && Number.isFinite(updatedMs) && now - updatedMs > staleMs;
      if (stale) await this.notifyWatchdog(managerId, child.id, 'child-stale', `status=running and updatedAt older than ${Math.round(staleMs / 60000)} minutes`, `child=${child.id} running, lastUpdatedAt=${child.updatedAt}`, true, snapshot);
      else snapshot.notified = (snapshot.notified ?? []).filter((item) => item !== 'child-stale');
      await this.store.setWatchdogSnapshot(snapshot);
    }
    const managerSnapshot = this.store.getWatchdogSnapshot(managerId, '__manager__') ?? { managerId, childId: '__manager__', status: '', notified: [] };
    const observedManagerWait = managerWait ?? await this.hasLivePaseoWait(managerId);
    managerSnapshot.hasLivePaseoWait = observedManagerWait;
    const managerNoWakeup = running.length > 0 && snapshotResult.companionKnownWakeupSources.length === 0 && observedManagerWait === false;
    const managerBareCriterion = 'running child status observed, no live companion-created or registered wakeup source observed, and no live paseo wait; external sources may be invisible';
    const managerBareDetail = `manager=${managerId} has ${running.length} running child(ren); companion checked only companion-created and registered sources, so external wakeup sources may be invisible`;
    if (managerNoWakeup) await this.notifyWatchdog(managerId, '__manager__', 'manager-bare', managerBareCriterion, managerBareDetail, true, managerSnapshot);
    else managerSnapshot.notified = (managerSnapshot.notified ?? []).filter((item) => item !== 'manager-bare');
    managerSnapshot.status = managerNoWakeup ? 'running-children' : 'covered';
    await this.store.setWatchdogSnapshot(managerSnapshot);
    // Historical snapshots for children no longer returned are deliberately
    // retained: a restart or transient listing gap must not replay alerts.
    void activeChildren;
  }

  /** Persist before handing a coalesced batch to Paseo's turn-boundary queue. */
  async postMessage(body: { to: string; from: string; body: string; urgency?: MessageUrgency; immediate?: boolean; kind?: 'heartbeat-recovery'; recoveryManagerId?: string; recoveryCounts?: Record<string, number>; recoveryRunIds?: Record<string, string[]> }): Promise<MessageRecord & {
    schedule: null;
    delivery: { id: string; transport: 'paseo-send' | 'heartbeat'; status: 'accepted' | 'pending'; acceptedAt: string | null; batchIds: string[] } | null;
  }> {
    if (!body.to?.trim() || !body.from?.trim() || !body.body?.trim()) throw new Error('to, from, and body are required');
    if (body.urgency !== undefined && body.urgency !== 'normal' && body.urgency !== 'urgent') throw new Error('urgency must be normal or urgent');
    const message: MessageRecord = {
      id: randomUUID(),
      to: body.to.trim(),
      from: body.from.trim(),
      body: body.body,
      urgency: body.urgency ?? 'normal',
      status: 'pending',
      createdAt: new Date().toISOString(),
      ...(body.kind ? { kind: body.kind } : {}),
      ...(body.recoveryManagerId ? { recoveryManagerId: body.recoveryManagerId } : {}),
      ...(body.recoveryCounts ? { recoveryCounts: body.recoveryCounts } : {}),
      ...(body.recoveryRunIds ? { recoveryRunIds: body.recoveryRunIds } : {}),
    };
    // This write deliberately precedes every daemon call.
    await this.store.addMessage(message);
    if (body.immediate) this.immediateDeliveries.add(message.to);
    try { await this.ensureMessageDelivery(message.to); }
    finally { if (body.immediate) this.immediateDeliveries.delete(message.to); }
    const audit = this.store.getMessageSchedules().find((item) => item.batchIds.includes(message.id)) ?? null;
    const delivery = audit ? {
      id: audit.id,
      transport: (audit.transport ?? 'paseo-send') as 'paseo-send' | 'heartbeat',
      status: audit.status === 'completed' ? 'accepted' as const : 'pending' as const,
      acceptedAt: audit.status === 'completed' ? audit.lastRunAt ?? null : null,
      batchIds: audit.batchIds,
    } : null;
    if (audit?.status === 'completed') return { ...message, status: 'delivered', deliveredAt: audit.lastRunAt, schedule: null, delivery };
    return { ...message, schedule: null, delivery };
  }

  getMessages(to?: string): MessageRecord[] {
    return this.store.getMessages().filter((message) => !to || message.to === to);
  }

  async deleteMessage(id: string, reason: string): Promise<{ id: string; status: 'deleted'; retirementPending: boolean }> {
    if (!reason?.trim()) throw new Error('reason is required');
    const message = this.store.getMessages().find((item) => item.id === id);
    if (!message) {
      const retired = this.store.getLedger().some((record) => record.type === 'deferred' && record.target === id
        && (record.verdict === 'message-acknowledged' || record.verdict === 'message-deleted'));
      if (retired) return { id, status: 'deleted', retirementPending: false };
      throw new Error('message not found');
    }
    const wasDelivered = message.status === 'delivered';
    await this.store.updateMessage(id, { status: 'cancelled' });
    const retirementPending = await this.cleanupCancelledMessage(id);
    if (!retirementPending) await this.store.removeMessages([id]);
    await this.store.addLedger({ type: 'deferred', target: id, verdict: wasDelivered ? 'message-acknowledged' : 'message-deleted', reason });
    return { id, status: 'deleted', retirementPending };
  }

  private async cleanupCancelledMessage(id: string): Promise<boolean> {
    const schedules = this.store.getMessageSchedules().filter((schedule) => schedule.batchIds.includes(id));
    for (const schedule of schedules) {
      if (['pending', 'active', 'running'].includes(schedule.status)) {
        if (schedule.transport === 'heartbeat' && schedule.daemonId) {
          try { await this.cli.run(['heartbeat', 'delete', schedule.daemonId, '--json'], { agentId: schedule.recipient }); }
          catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/not found|no such heartbeat|unknown heartbeat|404/i.test(message)) return true;
          }
          await this.store.updateMessageSchedule(schedule.id, { status: 'deleted', daemonId: undefined });
        } else await this.migrateLegacyMessageSchedule(schedule);
      }
    }
    return false;
  }

  private sortMessages(messages: MessageRecord[]): MessageRecord[] {
    return [...messages].sort((a, b) => {
      const urgency = (a.urgency === 'urgent' ? 0 : 1) - (b.urgency === 'urgent' ? 0 : 1);
      if (urgency) return urgency;
      const sender = a.from.localeCompare(b.from);
      if (sender) return sender;
      const timestamp = a.createdAt.localeCompare(b.createdAt);
      return timestamp || a.id.localeCompare(b.id);
    });
  }

  private messagePrompt(recipient: string, messages: MessageRecord[]): string {
    const grouped = new Map<string, MessageRecord[]>();
    for (const message of this.sortMessages(messages)) {
      const sender = grouped.get(message.from) ?? [];
      sender.push(message);
      grouped.set(message.from, sender);
    }
    const lines = [`Deliver the queued messages below to ${recipient}. Do not send a response through the companion; process each message exactly once.`];
    for (const [sender, senderMessages] of grouped) {
      lines.push(`From: ${sender}`);
      for (const message of senderMessages) {
        lines.push(`- [id=${message.id}] [${message.createdAt}] (${message.urgency}) ${message.body}`);
      }
    }
    // Recovery transport remains self-cleaning at delivery time; its durable
    // reminder record is the cancellation handle, so do not append a message
    // acknowledgement endpoint to that ephemeral transport payload.
    const acknowledgements = this.sortMessages(messages).filter((message) => message.kind !== 'heartbeat-recovery');
    if (acknowledgements.length) lines.push('After processing, acknowledge each message separately (no batch acknowledgement) with:');
    for (const message of acknowledgements) {
      const endpointPort = this.port || Number(process.env.PORT || 8787);
      lines.push(`curl -X DELETE http://127.0.0.1:${endpointPort}/messages/${message.id} -H 'content-type: application/json' -d '{"reason":"processed"}'`);
    }
    return lines.join('\n');
  }

  private transportPrompt(prompt: string, transport: 'heartbeat' | 'paseo-send', reason?: string): string {
    const marker = transport === 'heartbeat'
      ? 'AUTOMATED_COMPANION_EVENT transport=heartbeat NOT_USER_INPUT'
      : `AUTOMATED_COMPANION_EVENT transport=fallback-send NOT_USER_INPUT reason=${reason ?? 'explicit immediate=true'}`;
    return `${marker}\n${prompt}`;
  }

  private async inspectMessageSchedule(schedule: MessageScheduleRecord): Promise<MessageScheduleInspection> {
    if (!schedule.daemonId) return { state: 'missing', hasRun: false };
    try {
      const inspectValue = this.scheduleObserver
        ? await this.scheduleObserver.scheduleInspect(schedule.daemonId)
        : (await this.cli.run(['schedule', 'inspect', schedule.daemonId, '--json'], { agentId: schedule.recipient, timeoutMs: 5_000 })).value;
      const inspectedEnvelope = unwrapPayload(inspectValue);
      if (inspectedEnvelope.schedule === null && /not found|missing/i.test(String(inspectedEnvelope.error ?? ''))) return { state: 'missing', hasRun: false };
      if (inspectedEnvelope.error && inspectedEnvelope.schedule === undefined) return { state: 'unknown', hasRun: false };
      const inspected = asRecord(inspectedEnvelope.schedule && typeof inspectedEnvelope.schedule === 'object' ? inspectedEnvelope.schedule : inspectedEnvelope);
      if (!Object.keys(inspected).length) return { state: 'unknown', hasRun: false };
      const logsValue = this.scheduleObserver
        ? await this.scheduleObserver.scheduleLogs(schedule.daemonId)
        : (await this.cli.run(['schedule', 'logs', schedule.daemonId, '--json'], { agentId: schedule.recipient, timeoutMs: 5_000 })).value;
      const logsRecord = unwrapPayload(logsValue);
      if (!Array.isArray(logsValue) && !Array.isArray(logsRecord.logs) && !Array.isArray(logsRecord.runs) && !Array.isArray(logsRecord.entries)) return { state: 'unknown', hasRun: false };
      const logs = Array.isArray(logsValue) ? logsValue : (logsRecord.logs ?? logsRecord.runs ?? logsRecord.entries ?? []);
      const latest = Array.isArray(logs) && logs.length ? asRecord(logs[logs.length - 1]) : {};
      const hasRun = Array.isArray(logs) && logs.length > 0;
      const runStatus = lowerStatus(latest.status ?? latest.state ?? latest.outcome ?? latest.result);
      const scheduleStatus = lowerStatus(inspected.status ?? inspected.Status ?? inspected.state ?? inspected.State);
      // A terminal run log is authoritative over the wrapper schedule status:
      // Paseo may report a max-runs schedule as completed after a busy failure.
      if (runStatus) {
        if (/running|in.?progress|started/.test(runStatus)) return { state: 'running', hasRun };
        if (/fail|error|timeout|busy/.test(runStatus)) return { state: 'failed', hasRun };
        if (/success|succeed|complete|ok/.test(runStatus)) return { state: 'success', hasRun };
        return { state: 'unknown', hasRun };
      }
      // A completed wrapper without a terminal successful/failed run log is
      // not delivery evidence. Preserve the queue and wait for a real log.
      if (/complete|success|succeed|fail|error/.test(scheduleStatus)) return { state: 'unknown', hasRun };
      if (['deleted', 'expired', 'missing', 'dead'].includes(scheduleStatus)) return { state: 'missing', hasRun };
      return { state: 'live', hasRun };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { state: /not found|no such schedule|unknown schedule|404/i.test(message) ? 'missing' : 'unknown', hasRun: false };
    }
  }

  /** Retire schedules written by releases that used heartbeat delivery. */
  private async migrateLegacyMessageSchedules(): Promise<void> {
    for (const schedule of this.store.getMessageSchedules()) {
      if (schedule.transport === 'heartbeat' || !['pending', 'active', 'running'].includes(schedule.status)) continue;
      await this.migrateLegacyMessageSchedule(schedule);
    }
  }

  private async reconcileHeartbeatMessageSchedules(): Promise<void> {
    for (const schedule of this.store.getMessageSchedules().filter((item) => item.transport === 'heartbeat' && ['active', 'running'].includes(item.status))) {
      const observed = await this.inspectMessageSchedule(schedule);
      if (observed.state === 'success') {
        const deliveredAt = new Date().toISOString();
        await this.store.updateMessageSchedule(schedule.id, { status: 'completed', lastRunAt: deliveredAt });
        try { await this.finalizeAcceptedMessageSchedule({ ...schedule, status: 'completed', lastRunAt: deliveredAt }); } catch { /* retry local cleanup later */ }
      } else if (observed.state === 'failed' || observed.state === 'missing') {
        await this.store.updateMessageSchedule(schedule.id, { status: 'failed' });
        console.warn(JSON.stringify({ type: 'message-delivery-terminal', recipient: schedule.recipient, generation: schedule.generation, batchIds: schedule.batchIds, transport: 'heartbeat', reason: observed.state }));
      }
    }
  }

  private async migrateLegacyMessageSchedule(schedule: MessageScheduleRecord): Promise<void> {
    if (schedule.daemonId) {
      try {
        // Legacy message generations were heartbeat daemons, so use the
        // heartbeat endpoint for cleanup.  `schedule delete` is not valid for
        // these records and can leave the daemon active in Paseo.
        await this.cli.run(['heartbeat', 'delete', schedule.daemonId, '--json'], { agentId: schedule.recipient, timeoutMs: 5_000 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A missing daemon is already retired.  Other failures leave the
        // legacy record live so no replacement send can duplicate its batch.
        if (!/not found|no such heartbeat|unknown heartbeat|404/i.test(message)) {
          console.warn(JSON.stringify({ type: 'message-delivery-failed', recipient: schedule.recipient, generation: schedule.generation, batchIds: schedule.batchIds, transport: 'legacy-heartbeat-delete', error: message }));
          throw error;
        }
      }
    }
    await this.store.updateMessageSchedule(schedule.id, { status: 'deleted', daemonId: undefined });
  }

  /** Finish local cleanup for a generation whose send was already accepted. */
  private async finalizeAcceptedMessageSchedule(schedule: MessageScheduleRecord): Promise<void> {
    const messages = this.store.getMessages().filter((message) => schedule.batchIds.includes(message.id));
    const deliveredAt = schedule.lastRunAt ?? new Date().toISOString();
    for (const message of messages) {
      if (message.kind === 'heartbeat-recovery') {
        await this.completeRecovery(message);
        await this.store.removeMessages([message.id]);
      } else if (message.status === 'pending') {
        await this.store.updateMessage(message.id, { status: 'delivered', deliveredAt });
      }
    }
  }

  private async createMessageSchedule(recipient: string, batch: MessageRecord[]): Promise<MessageScheduleRecord | undefined> {
    const generation = randomUUID();
    const local: MessageScheduleRecord = {
      id: randomUUID(),
      recipient,
      generation,
      batchIds: batch.map((message) => message.id),
      prompt: this.messagePrompt(recipient, batch),
      status: 'pending',
      transport: this.immediateDeliveries.has(recipient) ? 'paseo-send' : 'heartbeat',
      createdAt: new Date().toISOString(),
    };
    const basePrompt = local.prompt;
    await this.store.addMessageSchedule(local);
    if (local.transport === 'heartbeat') {
      const cron = '* * * * *';
      const name = `companion-message-${local.generation}`;
      let daemonId: string | undefined;
      try {
        local.prompt = this.transportPrompt(basePrompt, 'heartbeat');
        const value = asRecord((await this.cli.run([
          'heartbeat', 'create', local.prompt, '--cron', cron, '--expires-in', '30m', '--max-runs', '1',
          '--name', name, '--timezone', 'UTC', '--json',
        ], { agentId: recipient })).value);
        daemonId = String(value.id ?? value.heartbeatId ?? '') || undefined;
        if (!daemonId) throw new Error('heartbeat create returned no id');
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const fallbackReason = `heartbeat-create-failed: ${reason}`;
        local.transport = 'paseo-send';
        local.transportReason = fallbackReason;
        console.warn(JSON.stringify({ type: 'message-delivery-fallback', recipient, generation: local.generation, batchIds: local.batchIds, transport: 'paseo-send', reason: fallbackReason }));
      }
      if (daemonId) {
        await this.store.updateMessageSchedule(local.id, { daemonId, status: 'active', transport: 'heartbeat', prompt: local.prompt });
        console.log(JSON.stringify({ type: 'message-delivery-armed', recipient, generation: local.generation, batchIds: local.batchIds, transport: 'heartbeat', daemonId }));
        return this.store.getMessageSchedules().find((item) => item.id === local.id);
      }
    }
    let acceptedAt: string;
    if (local.transport === 'paseo-send') {
      const reason = local.transportReason ?? 'explicit immediate=true';
      local.prompt = this.transportPrompt(basePrompt, 'paseo-send', reason);
      await this.store.updateMessageSchedule(local.id, { transport: 'paseo-send', prompt: local.prompt, transportReason: reason });
    }
    try {
      const value = unwrapPayload((await this.cli.run(['send', '--no-wait', '--json', recipient, local.prompt])).value);
      const status = lowerStatus(value.status);
      if (!['sent', 'accepted'].includes(status)) throw new Error(`paseo send did not confirm sent status (status=${String(value.status)})`);
      acceptedAt = new Date().toISOString();
      // Mark the local record terminal before receipt cleanup.  If local
      // cleanup fails after acceptance, reconcile can finish it without ever
      // issuing a duplicate send.
      await this.store.updateMessageSchedule(local.id, { status: 'completed', lastRunAt: acceptedAt, transport: 'paseo-send' });
    } catch (error) {
      await this.store.updateMessageSchedule(local.id, { status: 'failed' });
      console.warn(JSON.stringify({ type: 'message-delivery-failed', recipient, generation, batchIds: local.batchIds, transport: 'paseo-send', reason: local.transportReason ?? 'explicit immediate=true', error: error instanceof Error ? error.message : String(error) }));
      return undefined;
    }
    console.log(JSON.stringify({ type: 'message-delivery-accepted', recipient, generation, batchIds: local.batchIds, transport: 'paseo-send', reason: local.transportReason ?? 'explicit immediate=true' }));
    try { await this.finalizeAcceptedMessageSchedule(local); } catch { /* retry cleanup without another send */ }
    return this.store.getMessageSchedules().find((item) => item.id === local.id);
  }

  private async ensureMessageDelivery(recipient: string): Promise<void> {
    const existing = this.messageInFlight.get(recipient);
    if (existing) return existing;
    const operation = this.ensureMessageDeliveryOnce(recipient);
    this.messageInFlight.set(recipient, operation);
    try { await operation; } finally { this.messageInFlight.delete(recipient); }
  }

  private async ensureMessageDeliveryOnce(recipient: string): Promise<void> {
    // Let concurrent POSTs finish their durable writes before taking the batch
    // snapshot. This keeps a burst of arrivals to one schedule generation.
    await new Promise<void>((resolve) => setImmediate(resolve));
    try { await this.migrateLegacyMessageSchedules(); } catch { return; }
    // Complete accepted generations whose local receipt cleanup was interrupted
    // after the send was already accepted.
    for (const schedule of this.store.getMessageSchedules().filter((item) => item.recipient === recipient && item.status === 'completed')) {
      try { await this.finalizeAcceptedMessageSchedule(schedule); } catch { /* accepted send is terminal; retry local cleanup later */ }
    }
    const queued = this.store.getMessages().filter((message) => message.to === recipient && message.status === 'pending');
    const accepted = new Set(this.store.getMessageSchedules().filter((item) => item.recipient === recipient && ['active', 'running', 'failed', 'completed'].includes(item.status)).flatMap((item) => item.batchIds));
    const pending = queued.filter((message) => !accepted.has(message.id));
    if (!pending.length) return;
    await this.createMessageSchedule(recipient, this.sortMessages(pending));
  }

  private async completeRecovery(message: MessageRecord): Promise<void> {
    const counts = message.recoveryCounts ?? {};
    const runIds = message.recoveryRunIds ?? {};
    if (this.store.getRecoveryReceipt(message.id)) return;
    const covered = Object.fromEntries(Object.entries(counts).map(([id, missedFires]) => [id, { missedFires: Number(missedFires), missedRunIds: runIds[id] ?? [] }]));
    await this.store.applyRecoveryReceipt(message.id, covered);
  }

  private async suppressRecoveryForChild(managerId: string, childId: string, reminderIds: string[]): Promise<boolean> {
    const ids = new Set(reminderIds);
    const affected = this.store.getMessages().filter((message) => message.status === 'pending' && message.kind === 'heartbeat-recovery' && message.recoveryManagerId === managerId);
    const removed = new Set<string>();
    const changed = new Set<string>();
    for (const message of affected) {
      const counts = message.recoveryCounts ?? {};
      const runIds = message.recoveryRunIds ?? {};
      const nextCounts = Object.fromEntries(Object.entries(counts).filter(([id]) => !ids.has(id)));
      const nextRunIds = Object.fromEntries(Object.entries(runIds).filter(([id]) => !ids.has(id)));
      if (Object.keys(nextCounts).length === 0) removed.add(message.id);
      else {
        const total = Object.values(nextCounts).reduce((sum, count) => sum + Number(count), 0);
        const body = message.body.split('\n').filter((line) => !line.includes(childId)).join('\n').replace(/missed_fires=\d+/, `missed_fires=${total}`);
        await this.store.updateMessage(message.id, { recoveryCounts: nextCounts, recoveryRunIds: nextRunIds, body });
        changed.add(message.id);
      }
    }
    if (!removed.size && !changed.size) return false;
    if (removed.size) await this.store.removeMessages(removed);
    return false;
  }

  private async reconcileMessages(): Promise<void> {
    // Convert pre-send transport records before considering new deliveries.
    // This also removes any legacy heartbeat daemon without invoking schedule
    // inspection/update/delete APIs.
    try { await this.migrateLegacyMessageSchedules(); } catch { return; }
    for (const message of this.store.getMessages().filter((item) => item.status === 'cancelled')) {
      if (!await this.cleanupCancelledMessage(message.id)) await this.store.removeMessages([message.id]);
    }
    await this.reconcileHeartbeatMessageSchedules();
    if (this.store.isChildWatchOptOutStateCorrupt()) {
      const pairs = new Map<string, string[]>();
      for (const reminder of this.store.getReminders()) {
        if (!reminder.subjectChildId || (reminder.kind !== 'child-watch' && reminder.watchKind !== 'child')) continue;
        const key = `${reminder.agentId}\0${reminder.subjectChildId}`;
        const ids = pairs.get(key) ?? []; ids.push(reminder.id); pairs.set(key, ids);
      }
      for (const [key, ids] of pairs) {
        const separator = key.indexOf('\0');
        await this.suppressRecoveryForChild(key.slice(0, separator), key.slice(separator + 1), ids);
      }
    }
    for (const key of Object.keys(this.store.getChildWatchOptOuts())) {
      const separator = key.indexOf('\0');
      if (separator < 0) continue;
      const managerId = key.slice(0, separator);
      const childId = key.slice(separator + 1);
      const reminderIds = this.store.getReminders().filter((reminder) => this.isChildWatch(reminder, managerId, childId)).map((reminder) => reminder.id);
      await this.suppressRecoveryForChild(managerId, childId, reminderIds);
    }
    const recipients = new Set(this.store.getMessages().filter((message) => message.status === 'pending').map((message) => message.to));
    for (const schedule of this.store.getMessageSchedules()) {
      if (['pending', 'active', 'running', 'completed'].includes(schedule.status)) recipients.add(schedule.recipient);
    }
    for (const recipient of recipients) {
      try { await this.ensureMessageDelivery(recipient); } catch { /* retry next reconciliation */ }
    }
    await this.store.pruneMessageSchedules();
  }

  async compactWake(body: { agentId: string; resumeSteps: string }): Promise<unknown> {
    await this.store.addManager(body.agentId);
    const cron = '*/5 * * * *';
    const localId = randomUUID();
    const prompt = `type=compact-wake id=${localId} target=${body.agentId} event=compact-recovery criterion=compaction completed and manager has not resumed triggeredAt=${new Date().toISOString()}\n${body.resumeSteps}\nThis is a compact recovery reminder; resume all listed steps.\nHealth check: curl -sf http://127.0.0.1:${this.port || Number(process.env.PORT || 8787)}/health || echo "COMPANION DOWN"\nCancel this reminder with: ${this.cancelCommand(localId)}`;
    const name = `compact-wake-${randomUUID().slice(0, 8)}`;
    const pending: ReminderRecord = { id: localId, agentId: body.agentId, name, prompt, cron, expiresIn: '30m', status: 'pending', kind: 'compact-wake', createdAt: new Date().toISOString() };
    await this.store.addReminder(pending);
    try {
      const value = asRecord((await this.cli.run(['heartbeat', 'create', prompt, '--cron', cron, '--expires-in', '30m', '--name', name, '--timezone', 'UTC', '--json'], { agentId: body.agentId })).value);
      const daemonId = String(value.id ?? '');
      await this.store.updateReminder(localId, { daemonId, status: 'active', nextRunAt: value.nextRunAt, lastRunAt: value.lastRunAt });
      const controller = new AbortController();
      this.observers.add(controller);
      void this.observeCompact(body.agentId, body.resumeSteps, daemonId, localId, controller.signal).finally(() => this.observers.delete(controller));
      return { id: daemonId, status: value.status ?? 'active', nextRunAt: value.nextRunAt };
    } catch (error) {
      await this.store.updateReminder(localId, { status: 'dead' });
      throw error;
    }
  }

  private async observeCompact(agentId: string, resumeSteps: string, heartbeatId: string, localId: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + 15 * 60 * 1000;
    try {
      await this.cli.run(['wait', agentId, '--timeout', '900', '--json'], { timeoutMs: 15 * 60 * 1000 + 5_000, signal });
      let stableSince: number | undefined;
      let previousUpdated: string | undefined;
      while (Date.now() < deadline && !signal.aborted) {
        try {
          const inspect = asRecord((await this.cli.run(['inspect', agentId, '--json'], { signal, timeoutMs: 5_000 })).value);
          const status = lowerStatus(inspect.Status ?? inspect.status);
          const updated = String(inspect.UpdatedAt ?? inspect.updatedAt ?? '');
          const now = Date.now();
          console.log(JSON.stringify({ type: 'compact-observation', at: new Date(now).toISOString(), agentId, status, updatedAt: updated }));
          if (status === 'idle' && updated === previousUpdated) stableSince ??= now;
          else stableSince = undefined;
          previousUpdated = updated;
          if (stableSince && now - stableSince >= 60_000) {
            if (this.store.findReminder(localId)?.status === 'deleted') return;
            const prompt = [
              `type=compact-wake id=${localId} target=${agentId} event=compact-recovery criterion=status=idle and updatedAt unchanged for 60s triggeredAt=${new Date(now).toISOString()}`,
              resumeSteps,
              `Cancel this reminder with: ${this.cancelCommand(localId)}`,
            ].join('\n');
            await this.cli.run(['send', agentId, prompt], { signal });
            await this.cli.run(['heartbeat', 'delete', heartbeatId, '--json'], { agentId, signal });
            await this.store.updateReminder(localId, { status: 'deleted' });
            return;
          }
        } catch { /* continue until deadline */ }
        await sleep(5_000, signal);
      }
    } catch { /* fallback heartbeat remains active */ }
  }

  async briefing(id: string, since?: string): Promise<{ commits: string[]; uncommittedChanges: boolean; diffStat: string }> {
    const inspect = asRecord((await this.cli.run(['inspect', id, '--json'])).value);
    const cwd = String(inspect.Cwd ?? inspect.cwd ?? inspect.Worktree ?? inspect.worktree ?? '');
    if (!cwd) return { commits: [], uncommittedChanges: false, diffStat: '' };
    const git = (args: string[]) => runGit(args, cwd);
    try {
      const range = since ? `${since}..HEAD` : 'HEAD~10..HEAD';
      const commitsOut = await git(['log', '--oneline', range]);
      const statusOut = await git(['status', '--porcelain']);
      const diffStat = await git(['diff', '--stat']);
      return { commits: commitsOut.split('\n').map((s) => s.trim()).filter(Boolean), uncommittedChanges: Boolean(statusOut.trim()), diffStat: diffStat.trim() };
    } catch { return { commits: [], uncommittedChanges: false, diffStat: '' }; }
  }

  async addLedger(body: { type: string; target: string; verdict: string; reason: string; recovery?: string }): Promise<unknown> {
    if (!['park', 'known-red', 'deferred'].includes(body.type)) throw new Error('invalid ledger type');
    if (!body.verdict?.trim() || !body.reason?.trim()) throw new Error('verdict and reason are required');
    const record = await this.store.addLedger({ type: body.type as LedgerType, target: body.target, verdict: body.verdict, reason: body.reason, recovery: body.recovery });
    if (body.type === 'park') {
      try { await this.cli.run(['agent', 'update', body.target, '--label', 'parked=true', '--json']); } catch { /* label is best effort */ }
    }
    return record;
  }
  listLedger(type?: string, target?: string): unknown[] {
    return this.store.getLedger().filter((r) => !r.revokedAt && (!type || r.type === type) && (!target || r.target === target));
  }
  async revokeLedger(id: string, reason: string): Promise<unknown> {
    const record = this.store.getLedger().find((r) => r.id === id);
    if (!record || record.revokedAt) throw new Error('ledger record not found');
    await this.store.revokeLedger(record, reason);
    if (record.type === 'park' && !this.store.getLedger().some((item) => item.type === 'park' && item.target === record.target && !item.revokedAt)) {
      try { await this.cli.run(['agent', 'update', record.target, '--label', 'parked=false', '--json']); } catch { /* best effort */ }
    }
    return { ...record, status: 'revoked' };
  }

  async reconcileReminders(): Promise<void> {
    if (this.heartbeatReconcileInFlight) return this.heartbeatReconcileInFlight;
    const operation = this.reconcileRemindersOnce();
    this.heartbeatReconcileInFlight = operation;
    try { await operation; } finally { this.heartbeatReconcileInFlight = undefined; }
  }

  private async reconcileRemindersOnce(): Promise<void> {
    for (const reminder of this.store.getReminders()) {
      if (reminder.status !== 'pending' && reminder.status !== 'active') continue;
      if (reminder.subjectChildId && (reminder.kind === 'child-watch' || reminder.watchKind === 'child') && this.store.isChildWatchOptedOut(reminder.agentId, reminder.subjectChildId)) {
        await this.store.clearReminderMissed(reminder.id);
        await this.retireChildWatch(reminder);
        continue;
      }
      if (reminderExpired(reminder)) {
        await this.store.updateReminder(reminder.id, { alive: false, status: 'dead' });
        continue;
      }
      if (reminder.daemonId) await this.probeReminder(reminder);
      else if (reminder.status === 'pending') await this.store.updateReminder(reminder.id, { status: 'dead' });
    }
    for (const managerId of this.store.getManagers()) {
      try { await this.ensureHeartbeatRecovery(managerId); } catch { /* retry on next reconciliation */ }
    }
    await this.reconcileIdleReminders();
  }

  private async managerIsIdle(managerId: string): Promise<boolean> {
    try {
      const inspected = await this.inspectWithRetry(managerId);
      return ['idle', 'waiting', 'parked'].includes(lowerStatus(inspected.Status ?? inspected.status));
    } catch { return false; }
  }

  private async ensureHeartbeatRecovery(managerId: string): Promise<void> {
    for (const reminder of this.store.getReminders()) {
      if (reminder.agentId === managerId && reminder.subjectChildId && (reminder.kind === 'child-watch' || reminder.watchKind === 'child') && this.store.isChildWatchOptedOut(managerId, reminder.subjectChildId) && (reminder.missedFires ?? 0) > 0) await this.store.clearReminderMissed(reminder.id);
    }
    const missed: ReminderRecord[] = [];
    for (const reminder of this.store.getReminders()) {
      if (reminder.agentId !== managerId || (reminder.subjectChildId && (reminder.kind === 'child-watch' || reminder.watchKind === 'child') && this.store.isChildWatchOptedOut(managerId, reminder.subjectChildId)) || (reminder.alive ?? true) !== true || (reminder.missedFires ?? 0) <= 0) continue;
      if (reminder.subjectChildId && (reminder.kind === 'child-watch' || reminder.watchKind === 'child')) {
        // A child with either a live paseo wait or a live companion watch is
        // already covered; recovery must not wake the manager redundantly.
        const coverage = this.unionLiveSources(await this.hasLivePaseoWait(reminder.subjectChildId), await this.hasLiveCompanionWatch(reminder.subjectChildId, reminder.id));
        if (coverage !== false) continue;
      }
      missed.push(reminder);
    }
    if (!missed.length || !(await this.managerIsIdle(managerId))) return;
    const children = await this.listChildren(managerId);
    const total = missed.reduce((sum, reminder) => sum + (reminder.missedFires ?? 0), 0);
    const lastDelivered = missed.map((reminder) => reminder.lastDeliveredAt).filter(Boolean).sort().at(-1) ?? null;
    const counts = Object.fromEntries(missed.map((reminder) => [reminder.id, reminder.missedFires ?? 0]));
    const runIds = Object.fromEntries(missed.map((reminder) => [reminder.id, reminder.missedRunIds ?? []]));
    const affectedChildIds = new Set(missed.map((reminder) => reminder.subjectChildId).filter((id): id is string => Boolean(id)));
    const childLines = children.children.filter((child) => affectedChildIds.has(child.id))
      .map((child) => `- child=${child.id} status=${child.status} wakeup=${child.hasLiveWakeupSource} parked=${child.parked}`).join('\n') || '- none';
    const sourceLines = missed.map((reminder) => `- source=${reminder.id} child=${reminder.subjectChildId ?? 'self'} missed=${reminder.missedFires ?? 0}`).join('\n');
    const body = [
      `type=heartbeat-recovery id=${deterministicName('companion-recovery', managerId)} target=${managerId} event=missed-heartbeat criterion=one-or-more heartbeat runs failed while manager was busy triggeredAt=${new Date().toISOString()}`,
      `Heartbeat recovery for ${managerId}: missed_fires=${total}; last_delivered_at=${lastDelivered ?? 'null'}.`,
      'This recovery record is durable and cancellable; no individual message acknowledgement is required.',
      'The manager is idle now. Review only the affected sources/children and decide the next action.',
      'Affected sources:', sourceLines,
      'Affected tracked children:', childLines,
      ...(children.partial ? ['Some affected child inspections were unavailable; re-check before acting.'] : []),
      `Cancel this recovery with: ${this.cancelCommand(deterministicName('companion-recovery', managerId))}`,
    ].join('\n');
    const recoveryReminderId = deterministicName('companion-recovery', managerId);
    const recoveryReminder = this.store.findReminder(recoveryReminderId);
    if (recoveryReminder?.status === 'deleted') return;
    if (!recoveryReminder) await this.store.addReminder({
      id: recoveryReminderId, agentId: managerId, name: recoveryReminderId, prompt: body, cron: '', expiresIn: '', status: 'active',
      kind: 'heartbeat-recovery', eventType: 'missed-heartbeat', criterion: 'failed heartbeat runs while manager busy', createdAt: new Date().toISOString(),
    });
    const existing = this.store.getMessages().find((message) => message.status === 'pending' && message.kind === 'heartbeat-recovery' && message.recoveryManagerId === managerId);
    if (existing) {
      // A delivery generation is an immutable snapshot. New observations wait
      // for its success and become the next generation rather than rewriting
      // a prompt that may already be in flight.
      return;
    }
    await this.postMessage({ to: managerId, from: 'companion', body, urgency: 'urgent', kind: 'heartbeat-recovery', recoveryManagerId: managerId, recoveryCounts: counts, recoveryRunIds: runIds });
  }

  async listHeartbeats(): Promise<Array<Record<string, unknown>>> {
    await this.reconcileReminders();
    const now = Date.now();
    return this.store.getReminders().filter((reminder) => reminder.status !== 'deleted').map((reminder) => {
      const expired = reminderExpired(reminder, now);
      return ({
      id: reminder.daemonId ?? reminder.id,
      cron: reminder.cron,
      last_fired_at: reminder.lastFiredAt ?? null,
      last_delivered_at: reminder.lastDeliveredAt ?? null,
      missed_fires: reminder.missedFires ?? 0,
      next_run: reminder.nextRunAt ?? null,
      alive: expired || reminder.status === 'dead' ? false : (reminder.alive ?? (reminder.status === 'active')),
      });
    });
  }

  private resolveHeartbeat(id: string): ReminderRecord | undefined {
    const exact = this.store.getReminders().find((reminder) => reminder.id === id || reminder.daemonId === id);
    if (exact) return exact;
    if (id.length < 8) return undefined;
    const matches = this.store.getReminders().filter((reminder) => reminder.id.startsWith(id) || Boolean(reminder.daemonId?.startsWith(id)));
    if (matches.length > 1) throw new Error('heartbeat id ambiguous');
    return matches[0];
  }

  async deleteHeartbeat(id: string, reason: string): Promise<unknown> {
    if (!reason?.trim()) throw new Error('reason is required');
    const reminder = this.resolveHeartbeat(id);
    if (!reminder) throw new Error('heartbeat not found');
    if (reminder.subjectChildId && (reminder.kind === 'child-watch' || reminder.watchKind === 'child')) {
      return this.unsubscribeChildWatch(reminder.agentId, reminder.subjectChildId, reason);
    }
    return this.deleteReminder(reminder.id, reason);
  }

  private isChildWatch(reminder: ReminderRecord, managerId: string, childId: string): boolean {
    return reminder.agentId === managerId && reminder.subjectChildId === childId && (reminder.kind === 'child-watch' || reminder.watchKind === 'child');
  }

  private async retireChildWatch(reminder: ReminderRecord): Promise<boolean> {
    if (reminder.daemonId) {
      if (this.scheduleObserver) {
        try {
          const observed = unwrapPayload(await this.scheduleObserver.scheduleInspect(reminder.daemonId));
          const status = lowerStatus(observed.status ?? observed.State ?? observed.state);
          if ((observed.schedule === null && /not found|missing/i.test(String(observed.error ?? ''))) || ['missing', 'deleted', 'expired', 'completed'].includes(status)) {
            await this.store.updateReminder(reminder.id, { status: 'deleted' });
            return true;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/(?:not found|no such schedule|unknown schedule|404)/i.test(message)) {
            await this.store.updateReminder(reminder.id, { status: 'deleted' });
            return true;
          }
        }
      }
      try { await this.cli.run(['heartbeat', 'delete', reminder.daemonId, '--json'], { agentId: reminder.agentId }); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/(?:not found|no such schedule|unknown schedule|already expired|expired|completed|deleted)/i.test(message)) return false;
      }
    }
    await this.store.updateReminder(reminder.id, { status: 'deleted' });
    return true;
  }

  private async ensureChildWatch(managerId: string, childId: string, parked: boolean, cwd?: string, force = false, observedWait?: boolean | 'unknown'): Promise<ReminderRecord | undefined> {
    if (!this.store.isTrackedChild(managerId, childId)) return undefined;
    const key = `${managerId}\0${childId}`;
    const existing = this.childWatchInFlight.get(key);
    if (existing) return existing as Promise<ReminderRecord | undefined>;
    const operation = this.ensureChildWatchOnce(managerId, childId, parked, cwd, force, observedWait);
    this.childWatchInFlight.set(key, operation);
    try { return await operation; } finally { if (this.childWatchInFlight.get(key) === operation) this.childWatchInFlight.delete(key); }
  }

  private childWatchPromptMatches(reminder: ReminderRecord, childId: string, cwd?: string): boolean {
    const expectedCwd = cwd ?? 'unknown';
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`"subjectChildId"\\s*:\\s*"${escape(childId)}"`).test(reminder.prompt)
      && new RegExp(`"cwd"\\s*:\\s*"${escape(expectedCwd)}"`).test(reminder.prompt);
  }

  private async createLocalChildWatch(managerId: string, childId: string, cwd?: string): Promise<ReminderRecord> {
    const id = deterministicName('companion-child-watch', `${managerId}\0${childId}`);
    const existing = this.store.findReminder(id);
    const prompt = `Local-poll child-watch subscription for child=${childId}; the companion rechecks it on the existing 300s reconciliation loop. Structured context: ${json({ watchKind: 'child', subjectChildId: childId, cwd: cwd ?? 'unknown' })}`;
    if (existing) {
      await this.store.updateReminder(id, { status: 'active', alive: true, daemonId: undefined, prompt, cron: '*/5 * * * *', expiresIn: '' });
      return this.store.findReminder(id)!;
    }
    const record: ReminderRecord = {
      id, agentId: managerId, subjectChildId: childId, kind: 'child-watch', watchKind: 'child',
      name: id, prompt, cron: '*/5 * * * *', expiresIn: '', status: 'active', alive: true,
      createdAt: new Date().toISOString(),
    };
    await this.store.addReminder(record);
    return record;
  }

  private async ensureChildWatchOnce(managerId: string, childId: string, parked: boolean, cwd?: string, force = false, observedWait?: boolean | 'unknown'): Promise<ReminderRecord | undefined> {
    const records = this.store.getReminders().filter((reminder) => this.isChildWatch(reminder, managerId, childId));
    if (this.store.isChildWatchOptedOut(managerId, childId)) {
      for (const reminder of records) {
        if (reminder.status === 'pending' || reminder.status === 'active') {
          await this.store.clearReminderMissed(reminder.id);
          await this.retireChildWatch(reminder);
        }
      }
      return undefined;
    }
    if (parked) {
      for (const reminder of records) if (reminder.status === 'pending' || reminder.status === 'active') await this.retireChildWatch(reminder);
      return undefined;
    }
    let live: ReminderRecord | undefined;
    let uncertain = false;
    for (const reminder of records) {
      if (reminder.status !== 'pending' && reminder.status !== 'active') continue;
      if (reminder.daemonId) {
        // Child-watch heartbeats from pre-R9 releases are retired once and are
        // never rebuilt; the replacement is the stable local-poll record.
        await this.retireChildWatch(reminder);
        continue;
      }
      if (reminder.status === 'active') {
        const state = await this.probeReminder(reminder, true);
        if (state === 'unknown') { uncertain = true; continue; }
        if (state) {
        if (!live) live = reminder;
        else await this.retireChildWatch(reminder);
        }
      } else if (reminder.status === 'pending') {
        // A pending record without a daemon cannot be a live watch after a
        // restart; mark it dead and replace it below.
        await this.store.updateReminder(reminder.id, { status: 'dead' });
      }
    }
    // `paseo wait` is the primary wakeup source. If it appears after a
    // companion watch was armed, retire the redundant watch but keep the child
    // tracked so future state transitions remain visible to the manager.
    const externalWakeup = observedWait ?? await this.hasLivePaseoWait(childId);
    if (externalWakeup === true && !force) {
      for (const reminder of records) {
        if (reminder.status === 'pending' || reminder.status === 'active') await this.retireChildWatch(reminder);
      }
      return undefined;
    }
    if (live) {
      const expectedCwd = cwd ?? 'unknown';
      const correctedExisting = records.find((record) => record.status === 'active' && this.childWatchPromptMatches(record, childId, cwd));
      if (correctedExisting) {
        if (live.id !== correctedExisting.id) await this.retireChildWatch(live);
        return correctedExisting;
      }
      if (this.childWatchPromptMatches(live, childId, cwd)) return live;
      // Existing watches created before P0 may be live but lack identity/cwd.
      // Arm a distinct corrected schedule first, then retire every old copy.
      const corrected = await this.createLocalChildWatch(managerId, childId, expectedCwd);
      for (const reminder of records) if (reminder.id !== corrected.id && (reminder.status === 'pending' || reminder.status === 'active')) await this.retireChildWatch(reminder);
      return corrected;
    }
    if (uncertain && !force) return undefined;
    // `paseo wait` is the primary wakeup source. Unknown process inspection is
    // fail-closed: never add a companion watch unless absence is proven.
    if (!force && externalWakeup !== false) return undefined;
    return this.createLocalChildWatch(managerId, childId, cwd);
  }

  private async unsubscribeChildWatchOnce(managerId: string, childId: string, reason: string): Promise<Record<string, unknown>> {
    // Unsubscribing a watch opts out only that delivery source. Tracking is a
    // separate observation concern and must survive this operation.
    await this.store.optOutChildWatch(managerId, childId, reason);
    const records = this.store.getReminders().filter((reminder) => this.isChildWatch(reminder, managerId, childId));
    let retirementPending = false;
    let retired = 0;
    for (const reminder of records) {
      if (reminder.status !== 'pending' && reminder.status !== 'active') continue;
      await this.store.clearReminderMissed(reminder.id);
      if (await this.retireChildWatch(reminder)) retired++;
      else retirementPending = true;
    }
    const recoveryPending = await this.suppressRecoveryForChild(managerId, childId, records.map((record) => record.id));
    return { managerId, childId, status: 'unsubscribed', retirementPending: retirementPending || recoveryPending, retiredCount: retired };
  }

  async unsubscribeChildWatch(managerId: string, childId: string, reason: string): Promise<Record<string, unknown>> {
    if (!managerId?.trim() || !childId?.trim() || !reason?.trim()) throw new Error('agentId, childId, and reason are required');
    const key = `${managerId}\0${childId}`;
    await this.store.untrackChild(managerId, childId, reason);
    const existing = this.childWatchInFlight.get(key);
    if (existing) await existing;
    const operation = this.unsubscribeChildWatchOnce(managerId, childId, reason);
    this.childWatchInFlight.set(key, operation.then(() => undefined, () => undefined));
    try { return await operation; }
    finally { this.childWatchInFlight.delete(key); }
  }

  async resubscribeChildWatch(managerId: string, childId: string, reason?: string): Promise<Record<string, unknown>> {
    if (!managerId?.trim() || !childId?.trim()) throw new Error('agentId and childId are required');
    if (this.store.isChildWatchOptOutStateCorrupt()) throw new Error('child-watch opt-out state corrupt');
    const key = `${managerId}\0${childId}`;
    const existing = this.childWatchInFlight.get(key);
    if (existing) await existing;
    const operation = (async () => {
      await this.store.trackChild(managerId, childId, 'explicit');
      const result = await this.ensureChildWatchOnce(managerId, childId, false, undefined, true);
      return { managerId, childId, status: 'subscribed', reason: reason ?? null, watch: result ?? null };
    })();
    this.childWatchInFlight.set(key, operation.then(() => undefined, () => undefined));
    try { return await operation; } finally { this.childWatchInFlight.delete(key); }
  }

  async reconcileOnce(): Promise<void> {
    this.lastReconcileAt = new Date().toISOString();
    await this.reconcileReminders();
    await this.reconcileMessages();
    for (const managerId of this.store.getManagers()) {
      try {
        const listed = await this.listChildren(managerId);
        const { children, companionKnownWakeupSources, partial } = listed;
        if (partial) {
          console.warn(JSON.stringify({ type: 'reconcile-partial-children', managerId, at: new Date().toISOString() }));
          continue;
        }
        for (const child of children) {
          if (child.tracked) await this.ensureChildWatch(managerId, child.id, child.parked, child.cwd, false, child.hasLivePaseoWait);
        }
        // Watchdog notifications are event driven. A tracked-child-empty
        // listing is intentionally silent; no unconditional heartbeat/fallback
        // is created here.
        const managerWait = await this.hasLivePaseoWait(managerId);
        await this.watchdogTick(managerId, Date.now(), this.watchdogStaleMs, listed, managerWait);
        // Keep the historical local health record for callers that inspect
        // reconciliation state, but it is deliberately not a Paseo heartbeat
        // and therefore cannot wake the manager by itself.
        if (children.length && children.every((c) => ['idle', 'archived', 'done', 'completed', 'error'].includes(lowerStatus(c.status))) && companionKnownWakeupSources.length === 0) {
          const existingLedger = this.store.getLedger().find((record) => record.type === 'known-red' && record.target === managerId && record.verdict === 'wakeup-source-missing' && !record.revokedAt);
          if (!existingLedger) await this.store.addLedger({ type: 'known-red', target: managerId, verdict: 'wakeup-source-missing', reason: 'reconciliation found no live wakeup source for completed children' });
        }
      } catch { /* a transient CLI failure is retried next round */ }
    }
  }
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('git timeout')); }, 10_000);
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(err)); });
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    const onAbort = () => { clearTimeout(timer); done(); };
    function done() { signal?.removeEventListener('abort', onAbort); resolve(); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
