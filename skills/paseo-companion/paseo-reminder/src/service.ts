import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PaseoCli, asRecord } from './cli.js';
import { Store } from './store.js';
import type { ScheduleObserver } from './schedule-observer.js';
import { ProcessWaitSourceDetector } from './wait-source.js';
import type { WaitSourceDetector } from './wait-source.js';
import type { ContextUsage, ContextUsageEntry, ContextUsageObserver } from './context-usage-observer.js';
import { CompanionError, invalidValue, missingField, rejectUnknownFields } from './errors.js';
import type { AgentInfo, ChildrenResult, CorrectionFinding, CorrectionInstance, CorrectionResolution, FailedCandidate, IdleReminderRecord, LedgerType, MessageDelivery, MessageMode, MessageRecord, MessageScheduleRecord, MessageUrgency, ReminderKind, ReminderMode, ReminderRecord, WakeupSourceRecord, WatchdogSnapshot } from './types.js';

const REMINDER_TTL = '30m';
const REMINDER_MAX_TTL_SECONDS = 2 * 60 * 60;
// Heartbeat schedules carry '--expires-in 30m'; 5m margin covers reconcile jitter.
const MESSAGE_SCHEDULE_ABSORPTION_TIMEOUT_MS = 35 * 60 * 1000;
type MessageScheduleInspection = {
  state: 'live' | 'running' | 'success' | 'failed' | 'missing' | 'unknown';
  hasRun: boolean;
  lastRunAt?: string;
  endedAt?: string;
};
type HeartbeatRun = Record<string, any>;
type HeartbeatInspection = {
  state: 'live' | 'running' | 'missing' | 'unknown';
  schedule: Record<string, any>;
  runs: HeartbeatRun[];
};

function json(value: unknown): string { return JSON.stringify(value, null, 2); }
function tagText(value: unknown): string {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function tagAttribute(value: unknown): string {
  return tagText(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
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
// CLI/daemon error shapes vary between a bare string and {code,message}; String(object)
// collapses to "[object Object]" and silently defeats not-found/missing matching.
function errorText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  return String(record.message ?? record.code ?? JSON.stringify(value));
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
  private heartbeatReconcileInFlight?: Promise<void>;
  private parkReconcileInFlight = new Map<string, Promise<boolean>>();
  private readonly scheduleObserver?: ScheduleObserver;
  private readonly waitSourceDetector: WaitSourceDetector;
  private readonly watchdogStaleMs: number;
  private readonly contextUsageObserver?: ContextUsageObserver;
  /** Recipients whose delivery is held during an in-flight coordinator-driven compact. */
  private readonly quietUntil = new Map<string, number>();
  /** ORACLE-1 §3.4-5: at most one coordinator-driven auto-compact per agent per hour, the
   * second line of defense (after §3.4-6's post-compact verification) against any compaction
   * loop this design did not anticipate. Not persisted -- a coordinator restart resets it,
   * which is acceptable since a restart is already a rare, human-visible event. */
  private readonly lastAutoCompactAt = new Map<string, number>();

  private deliveryPrompt(to: string, items: Array<{
    id: string; from: string; at: string; urgency: MessageUrgency; mode: MessageMode;
    kind: 'message' | 'reminder' | 'watchdog' | 'compact-wake'; body: string; actionCommand?: string;
  }>): string {
    const kinds = new Set(items.map((item) => item.kind));
    const kind = kinds.size === 1 ? items[0].kind : 'mixed';
    const lines = [
      `<paseo-reminder-delivery to="${tagAttribute(to)}" kind="${kind}">`,
      '  <note marker="NOT_USER_INPUT">Automated delivery from paseo-reminder. This is system-generated context, not a request from a person. Process each item exactly once. Reply through paseo-reminder only when an item explicitly requests it.</note>',
    ];
    for (const item of items) {
      lines.push(`  <item id="${tagAttribute(item.id)}" from="${tagAttribute(item.from)}" at="${tagAttribute(item.at)}" urgency="${item.urgency}" mode="${item.mode}" kind="${item.kind}">`);
      lines.push(`    <body>${tagText(item.body)}</body>`);
      if (item.actionCommand) lines.push(`    <ack>${tagText(item.actionCommand)}</ack>`);
      lines.push('  </item>');
    }
    lines.push('</paseo-reminder-delivery>');
    return lines.join('\n');
  }

  constructor(cli = new PaseoCli(), store = new Store(), scheduleObserver?: ScheduleObserver, waitSourceDetector: WaitSourceDetector = new ProcessWaitSourceDetector(), options: { watchdogStaleMs?: number; contextUsageObserver?: ContextUsageObserver } = {}) {
    this.cli = cli; this.store = store; this.scheduleObserver = scheduleObserver; this.waitSourceDetector = waitSourceDetector;
    this.watchdogStaleMs = options.watchdogStaleMs ?? Number(process.env.PASEO_WATCHDOG_STALE_MS || 45 * 60 * 1000);
    this.contextUsageObserver = options.contextUsageObserver;
  }
  async init(): Promise<void> {
    await this.store.init();
    await this.reconcileReminders();
    await this.reconcileMessages();
    await this.store.pruneMessageSchedules();
    await this.store.pruneMessages();
    await this.store.pruneReminders();
    this.reconcileTimer = setInterval(() => { void this.reconcileOnce(); }, 180_000);
    this.reconcileTimer.unref();
    this.messageReconcileTimer = setInterval(() => { void this.reconcileFast(); }, 15_000);
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
  private endpointBase(): string { return `http://127.0.0.1:${this.port || Number(process.env.PORT || 8787)}`; }
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
          const inspected = await this.inspectWithRetry(id, agentId);
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
            this.isParked(childId, status, inspected.UpdatedAt ?? inspected.updatedAt, agentId),
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
      if (this.isLocalReminderWakeupSource(reminder, agentId)) {
        selfWakeupSources.push(reminder);
      } else if (!childWatch && reminder.kind !== 'watchdog' && reminder.kind !== 'heartbeat-recovery' && reminder.agentId === agentId && reminder.status === 'active' && await this.probeReminder(reminder) === true) {
        selfWakeupSources.push(reminder);
      }
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

  private isLocalReminderWakeupSource(reminder: ReminderRecord, agentId: string): boolean {
    const protectedReminder = reminder.kind === 'child-watch'
      || reminder.watchKind === 'child'
      || Boolean(reminder.subjectChildId)
      || reminder.kind === 'compact-wake'
      || reminder.kind === 'watchdog'
      || reminder.kind === 'heartbeat-recovery';
    const hasFiniteWakeupAt = [reminder.nextRunAt, reminder.targetAt].some((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)));
    return reminder.agentId === agentId
      && reminder.status === 'active'
      && !reminder.daemonId
      && !protectedReminder
      && (reminder.mode === 'once' || reminder.mode === 'repeat')
      && hasFiniteWakeupAt;
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
    if (!heartbeatId?.trim()) missingField('heartbeatId');
    if (!agentId?.trim()) missingField('agentId');
    if (!cadence?.trim()) missingField('cadence');
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
    if (!source || (agentId && source.agentId !== agentId)) throw new CompanionError('not_found', 'wakeup source not found');
    await this.store.removeWakeupSource(heartbeatId);
    return { heartbeatId, status: 'deleted' };
  }

  private async inspectWithRetry(id: string, agentId?: string): Promise<Record<string, any>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const value = asRecord((await this.cli.run(['inspect', id, '--json'], { agentId, timeoutMs: 5_000 })).value);
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

  private unionLiveSources(wait: boolean | 'unknown', companion: boolean | 'unknown'): boolean | 'unknown' {
    if (wait === true || companion === true) return true;
    if (wait === 'unknown' || companion === 'unknown') return 'unknown';
    return false;
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

  private async isParked(childId: string, status: string, updatedAt: unknown, agentId?: string): Promise<boolean> {
    const existing = this.parkReconcileInFlight.get(childId);
    if (existing) return existing;
    const operation = this.isParkedOnce(childId, status, updatedAt, agentId);
    this.parkReconcileInFlight.set(childId, operation);
    try { return await operation; } finally { this.parkReconcileInFlight.delete(childId); }
  }

  private async isParkedOnce(childId: string, status: string, updatedAt: unknown, agentId?: string): Promise<boolean> {
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
        try { await this.cli.run(['agent', 'update', childId, '--label', 'parked=false', '--json'], { agentId }); } catch { /* best effort */ }
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

  async createReminder(body: { agentId: string; delaySeconds?: number; targetAt?: string; message: string; context?: object; ackRequired?: boolean; subjectChildId?: string; kind?: ReminderKind; watchKind?: 'child'; name?: string; maxRuns?: number; eventType?: string; criterion?: string; mode?: ReminderMode; cron?: string; everySeconds?: number; delivery?: MessageDelivery; urgency?: MessageUrgency }): Promise<ReminderRecord> {
    if ((body as any).id !== undefined) invalidValue('caller-supplied reminder id is not supported', 'id');
    if (body.mode !== undefined && !['once', 'repeat'].includes(body.mode)) invalidValue('mode must be once or repeat', 'mode', ['once', 'repeat']);
    // Child watches and explicit heartbeat kinds retain their legacy daemon
    // implementation. Generic reminders use the direct-send contract below.
    if (body.kind === 'child-watch' || body.watchKind === 'child' || body.kind === 'compact-wake' || body.kind === 'watchdog' || body.kind === 'heartbeat-recovery') {
      return this.createLegacyReminder(body as any);
    }
    await this.store.addManager(body.agentId);
    const mode: ReminderMode = body.mode ?? (body.everySeconds || body.cron ? 'repeat' : 'once');
    let targetAt = body.targetAt;
    if (!targetAt && body.delaySeconds !== undefined) {
      if (!Number.isFinite(body.delaySeconds) || body.delaySeconds <= 0) invalidValue('delaySeconds must be positive', 'delaySeconds');
      targetAt = new Date(Date.now() + body.delaySeconds * 1000).toISOString();
    }
    if (mode === 'once' && (!targetAt || !Number.isFinite(Date.parse(targetAt)))) invalidValue('once reminders require delaySeconds or an absolute targetAt', 'targetAt');
    if (mode === 'repeat' && !(Number.isFinite(body.everySeconds) && (body.everySeconds ?? 0) > 0)) invalidValue('repeat reminders require explicit everySeconds', 'everySeconds');
    if (mode === 'repeat' && !targetAt) targetAt = new Date(Date.now() + Number(body.everySeconds) * 1000).toISOString();
    if (body.maxRuns !== undefined && (!Number.isSafeInteger(body.maxRuns) || body.maxRuns <= 0)) invalidValue('maxRuns must be a positive integer', 'maxRuns');
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const reminder: ReminderRecord = {
      id, agentId: body.agentId.trim(), name: body.name ?? `companion-reminder-${id.slice(0, 8)}`,
      prompt: [
        `type=reminder id=${id} target=${body.agentId.trim()} event=${mode === 'once' ? 'scheduled-once' : 'scheduled-repeat'} criterion=${mode === 'once' ? `targetAt=${targetAt}` : `everySeconds=${body.everySeconds}`} triggeredAt=pending`,
        body.message,
        body.context ? `Structured context: ${json(body.context)}` : '',
        `Cancel this reminder with: ${this.cancelCommand(id)}`,
      ].filter(Boolean).join('\n'),
      cron: body.cron ?? (body.everySeconds ? `every ${body.everySeconds}s` : ''), expiresIn: '', status: 'active', createdAt,
      mode, schedulingKind: mode, ...(targetAt ? { targetAt, nextRunAt: targetAt } : {}), ...(body.everySeconds ? { everySeconds: body.everySeconds } : {}),
      ...(body.maxRuns !== undefined ? { maxRuns: body.maxRuns } : {}), runsCompleted: 0,
      delivery: body.delivery ?? (body.urgency === 'urgent' ? 'interrupt' : 'on-idle'),
      ...(body.kind ? { kind: body.kind } : {}), ...(body.eventType ? { eventType: body.eventType } : {}),
      ...(body.criterion ? { criterion: body.criterion } : {}), ...(body.subjectChildId ? { subjectChildId: body.subjectChildId } : {}),
      ...(body.watchKind ? { watchKind: body.watchKind } : {}),
    };
    await this.store.addReminder(reminder);
    await this.reconcileReminders();
    return this.store.findReminder(id)!;
  }

  listReminders(agentId?: string): ReminderRecord[] {
    return this.store.getReminders().filter((reminder) => !agentId || reminder.agentId === agentId).map((reminder) => this.withSchedulingKind(reminder));
  }

  getReminder(id: string): ReminderRecord {
    const reminder = this.store.findReminder(id);
    if (!reminder) throw new CompanionError('not_found', 'reminder not found');
    return this.withSchedulingKind(reminder);
  }

  private withSchedulingKind(reminder: ReminderRecord): ReminderRecord {
    if (reminder.schedulingKind) return reminder;
    if (reminder.mode === 'once' || reminder.mode === 'repeat') return { ...reminder, schedulingKind: reminder.mode };
    if (reminder.kind === 'child-watch' || reminder.kind === 'watchdog' || reminder.kind === 'heartbeat-recovery') return { ...reminder, schedulingKind: 'in-process' };
    if (reminder.daemonId || reminder.cron) return { ...reminder, schedulingKind: 'cron' };
    return reminder;
  }

  private async createLegacyReminder(body: { agentId: string; delaySeconds: number; message: string; context?: object; ackRequired?: boolean; subjectChildId?: string; kind?: ReminderKind; watchKind?: 'child'; name?: string; maxRuns?: number; eventType?: string; criterion?: string }): Promise<ReminderRecord> {
    await this.store.addManager(body.agentId);
    if (!Number.isFinite(body.delaySeconds) || body.delaySeconds <= 0) invalidValue('delaySeconds must be positive', 'delaySeconds');
    if (body.maxRuns !== undefined && (!Number.isSafeInteger(body.maxRuns) || body.maxRuns <= 0)) invalidValue('maxRuns must be a positive integer', 'maxRuns');
    const localId = randomUUID();
    const cron = cronForDelay(body.delaySeconds);
    const expiresIn = ttlForDelay(body.delaySeconds);
    const ack = `curl -X DELETE ${this.endpointBase()}/reminders/${localId} -H 'content-type: application/json' -d '{"reason":"acknowledged"}'`;
    const reminderBody = [
      `type=reminder id=${localId} target=${body.agentId} event=${body.kind ?? 'generic'} criterion=wall-clock-delay:${body.delaySeconds}s triggeredAt=${new Date().toISOString()}`,
      body.message, body.context ? `Structured context: ${json(body.context)}` : 'Structured context: {}',
      body.maxRuns && body.maxRuns > 1 ? `This reminder repeats up to ${body.maxRuns} times; the next run follows its cron schedule.` : body.maxRuns === undefined ? 'This reminder repeats on its cron schedule; the next run is reported by the companion. Cancel it before the next run if no longer needed.' : '',
      body.ackRequired === false ? '' : 'Do not drop this reminder without an explicit acknowledgement.',
    ].filter(Boolean).join('\n');
    const prompt = this.deliveryPrompt(body.agentId, [{
      id: localId, from: 'paseo-reminder', at: new Date().toISOString(), urgency: 'normal', mode: 'ack',
      kind: body.kind === 'compact-wake' ? 'compact-wake' : body.kind === 'watchdog' || body.kind === 'heartbeat-recovery' ? 'watchdog' : 'reminder',
      body: reminderBody, actionCommand: ack,
    }]);
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
      schedulingKind: 'cron',
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
    if (!reminder) throw new CompanionError('not_found', 'reminder not found');
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
    return `curl -X DELETE ${this.endpointBase()}/reminders/${id} -H 'content-type: application/json' -d '{"reason":"processed"}'`;
  }

  /** context-percent's threshold is never pre-converted to tokens at registration time: max
   * varies per agent (1000000 for claude [1m], 200000 for claude, 258400 for gpt-5.6-terra
   * observed live) and may not even be known yet for a brand-new agent. Baking a percent into
   * a token count up front would make a threshold registered against the wrong assumed max
   * permanently unreachable for lanes with a smaller real max, with no error anywhere. */
  /**
   * Resolves a context-percent threshold to an absolute token count AT REGISTRATION TIME.
   * Owner's call (overriding an earlier "normalize at evaluation time" draft): whoever is
   * registering this already has the agentId, and connecting to that agent already implies
   * knowing its max -- there is no meaningful "register now, learn the max later" case to
   * design around.
   *
   * Both input forms are accepted and normalized to the same stored shape (thresholdPercent
   * AND thresholdTokens both end up set on the record); every later comparison reads only
   * thresholdTokens.
   *
   * If this agent's max cannot currently be read (only 20/68 agents carry contextWindow
   * fields in a live listAll() -- an agent that has never run a turn has none), this throws
   * rather than guessing a default max. Guessing would silently produce an unreachable
   * threshold for a smaller-window lane (e.g. registering 70% against an assumed 1,000,000
   * max computes 700,000 tokens -- unreachable for a gpt-5.6-terra lane capped at 258,400 --
   * and the subscription would just never fire, with no error anywhere).
   */
  private async resolveContextThreshold(agentId: string, input: { thresholdPercent?: number; thresholdTokens?: number }): Promise<{ thresholdPercent: number; thresholdTokens: number }> {
    const hasPercent = input.thresholdPercent !== undefined;
    const hasTokens = input.thresholdTokens !== undefined;
    if (hasPercent === hasTokens) invalidValue('exactly one of thresholdPercent or thresholdTokens is required for metric=context-percent', hasPercent ? 'thresholdTokens' : 'thresholdPercent');
    if (hasPercent && (!Number.isFinite(input.thresholdPercent) || (input.thresholdPercent as number) <= 0 || (input.thresholdPercent as number) > 1)) invalidValue('thresholdPercent must be a 0..1 fraction', 'thresholdPercent');
    if (hasTokens && (!Number.isFinite(input.thresholdTokens) || (input.thresholdTokens as number) <= 0)) invalidValue('thresholdTokens must be positive', 'thresholdTokens');
    const observed = this.contextUsageObserver ? await this.contextUsageObserver.observe(agentId) : 'unknown';
    if (observed === 'unknown') invalidValue(`cannot resolve a context-percent threshold for agent=${agentId}: its context-window max is not readable yet (it may not have run a turn since the coordinator can observe usage). Wait for it to run once, then register.`, hasPercent ? 'thresholdPercent' : 'thresholdTokens');
    if (hasPercent) return { thresholdPercent: input.thresholdPercent as number, thresholdTokens: Math.round((input.thresholdPercent as number) * observed.limitTokens) };
    return { thresholdPercent: (input.thresholdTokens as number) / observed.limitTokens, thresholdTokens: input.thresholdTokens as number };
  }

  async createIdleReminder(body: { agentId: string; thresholdSeconds?: number; thresholdPercent?: number; thresholdTokens?: number; message: string; once?: boolean; metric?: 'idle-seconds' | 'context-percent'; comparator?: 'gte' | 'lte' }): Promise<IdleReminderRecord> {
    await this.store.addManager(body.agentId);
    rejectUnknownFields(body as Record<string, unknown>, ['agentId', 'message', 'thresholdSeconds', 'thresholdPercent', 'thresholdTokens', 'once', 'metric', 'comparator']);
    const metric = body.metric ?? 'idle-seconds';
    if (metric !== 'idle-seconds' && metric !== 'context-percent') invalidValue('metric must be idle-seconds or context-percent', 'metric');
    if (!body.message?.trim()) missingField('message');
    const comparator = body.comparator ?? 'gte';
    if (comparator !== 'gte' && comparator !== 'lte') invalidValue('comparator must be gte or lte', 'comparator');
    let record: IdleReminderRecord;
    if (metric === 'context-percent') {
      if (body.thresholdSeconds !== undefined) invalidValue('thresholdSeconds is only valid for metric=idle-seconds; use thresholdPercent or thresholdTokens', 'thresholdSeconds');
      const resolved = await this.resolveContextThreshold(body.agentId, body);
      record = {
        id: randomUUID(), agentId: body.agentId, message: body.message,
        thresholdPercent: resolved.thresholdPercent, thresholdTokens: resolved.thresholdTokens,
        once: body.once === true, status: 'active', createdAt: new Date().toISOString(), metric, comparator,
      };
    } else {
      if (body.thresholdPercent !== undefined || body.thresholdTokens !== undefined) invalidValue('thresholdPercent/thresholdTokens are only valid for metric=context-percent; use thresholdSeconds', body.thresholdPercent !== undefined ? 'thresholdPercent' : 'thresholdTokens');
      if (!Number.isFinite(body.thresholdSeconds) || (body.thresholdSeconds as number) <= 0) invalidValue('thresholdSeconds must be positive', 'thresholdSeconds');
      record = {
        id: randomUUID(), agentId: body.agentId, message: body.message, thresholdSeconds: body.thresholdSeconds,
        once: body.once === true, status: 'active', createdAt: new Date().toISOString(), metric, comparator,
      };
    }
    await this.store.addIdleReminder(record);
    return record;
  }

  private async observeAgentIdle(agentId: string): Promise<{ status: string; updatedAt: string; available: boolean; mode: string; pendingPermissionsCount: number }> {
    const inspected = await this.inspectWithRetry(agentId, agentId);
    const status = lowerStatus(inspected.Status ?? inspected.status);
    const updatedAt = String(inspected.UpdatedAt ?? inspected.updatedAt ?? '');
    const mode = lowerStatus(inspected.Mode ?? inspected.mode);
    const pendingPermissions = inspected.PendingPermissions ?? inspected.pendingPermissions;
    const pendingPermissionsCount = Array.isArray(pendingPermissions) ? pendingPermissions.length : 0;
    return { status, updatedAt, available: ['idle', 'waiting'].includes(status) && Boolean(updatedAt), mode, pendingPermissionsCount };
  }

  private async observeIdleReminder(reminder: IdleReminderRecord, now = Date.now()): Promise<IdleReminderRecord> {
    if (reminder.status !== 'active') return reminder;
    if ((reminder.metric ?? 'idle-seconds') === 'context-percent') return this.observeContextPercentReminder(reminder, now);
    let status = '';
    let updated = '';
    try {
      const observed = await this.observeAgentIdle(reminder.agentId);
      status = observed.status;
      updated = observed.updatedAt;
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
    if (!Number.isFinite(since) || now - since < (current.thresholdSeconds ?? 0) * 1000) return current;
    const body = [
      `type=idle-reminder id=${current.id} target=${current.agentId} event=manager-idle criterion=status=idle and updatedAt unchanged for ${current.thresholdSeconds}s triggeredAt=${new Date(now).toISOString()}`,
      current.message,
      current.once ? 'This reminder is one-shot and will self-delete after delivery.' : `This reminder repeats; after this delivery it will begin a new ${current.thresholdSeconds}s idle window.`,
    ].join('\n');
    const actionCommand = `curl -X DELETE ${this.endpointBase()}/idle-reminders/${current.id} -H 'content-type: application/json' -d '{"reason":"processed"}'`;
    await this.postMessage({ to: current.agentId, from: 'companion', body, delivery: 'interrupt', mode: 'notify', promptKind: 'reminder', actionCommand });
    if (current.once) {
      await this.store.updateIdleReminder(current.id, { status: 'deleted', idleSince: undefined, lastTriggeredAt: new Date(now).toISOString() });
    } else {
      await this.store.updateIdleReminder(current.id, { idleSince: undefined, lastTriggeredAt: new Date(now).toISOString() });
    }
    return this.store.findIdleReminder(current.id)!;
  }

  /** thresholdTokens is resolved once at registration time (resolveContextThreshold) and
   * always stored on the record; comparison always reads it directly, in token space. The
   * observed.limitTokens fallback only covers a hypothetical pre-migration record that
   * predates this field. */
  private effectiveThresholdTokens(reminder: IdleReminderRecord, observed: ContextUsage): number {
    return reminder.thresholdTokens ?? Math.round((reminder.thresholdPercent ?? 0) * observed.limitTokens);
  }

  private async observeContextPercentReminder(reminder: IdleReminderRecord, now = Date.now()): Promise<IdleReminderRecord> {
    if (!this.contextUsageObserver) return reminder;
    const observed = await this.contextUsageObserver.observe(reminder.agentId);
    // fail-safe: an unobserved agent must never be treated as "below threshold" or "above
    // threshold" -- it is simply not evaluated this tick. Compaction is not reversible.
    if (observed === 'unknown') return reminder;
    const comparator = reminder.comparator ?? 'gte';
    const thresholdTokens = this.effectiveThresholdTokens(reminder, observed);
    const crossed = comparator === 'lte' ? observed.usedTokens <= thresholdTokens : observed.usedTokens >= thresholdTokens;
    if (!crossed) {
      if (reminder.crossedCount || reminder.lastObservedValue !== observed.usedTokens) {
        await this.store.updateIdleReminder(reminder.id, { crossedCount: 0, lastObservedValue: observed.usedTokens, ...(reminder.compactWake ? { compactWake: { ...reminder.compactWake, crossedAt: undefined } } : {}) });
      }
      return this.store.findIdleReminder(reminder.id) ?? reminder;
    }
    // Require two consecutive crossing observations before acting; kills single-point
    // read noise/flicker the way the watchdog dual-source fix does (ORACLE-1 step 2 gate②).
    const crossedCount = (reminder.crossedCount ?? 0) + 1;
    const confirmed = await this.store.updateIdleReminder(reminder.id, { crossedCount, lastObservedValue: observed.usedTokens }) ?? reminder;
    if (crossedCount < 2) return confirmed;
    if (confirmed.compactWake) return this.evaluateCompactTrigger(confirmed, observed, now);
    const body = [
      `type=idle-reminder id=${confirmed.id} target=${confirmed.agentId} event=context-percent-crossed criterion=contextWindowUsedTokens ${comparator} ${thresholdTokens} (registered as ${confirmed.thresholdPercent !== undefined ? `${(confirmed.thresholdPercent * 100).toFixed(1)}%` : `${confirmed.thresholdTokens} tokens`}) confirmed over 2 consecutive observations triggeredAt=${new Date(now).toISOString()}`,
      `observed: used=${observed.usedTokens} limit=${observed.limitTokens} percent=${(observed.percent * 100).toFixed(1)}% source=${observed.source}`,
      confirmed.message,
      confirmed.once ? 'This reminder is one-shot and will self-delete after delivery.' : 'This reminder repeats; it re-arms once the value crosses back and forth again.',
    ].join('\n');
    const actionCommand = `curl -X DELETE ${this.endpointBase()}/idle-reminders/${confirmed.id} -H 'content-type: application/json' -d '{"reason":"processed"}'`;
    await this.postMessage({ to: confirmed.agentId, from: 'companion', body, delivery: 'on-idle', mode: 'notify', promptKind: 'reminder', actionCommand });
    if (confirmed.once) {
      await this.store.updateIdleReminder(confirmed.id, { status: 'deleted', crossedCount: 0, lastTriggeredAt: new Date(now).toISOString() });
    } else {
      await this.store.updateIdleReminder(confirmed.id, { crossedCount: 0, lastTriggeredAt: new Date(now).toISOString() });
    }
    return this.store.findIdleReminder(confirmed.id)!;
  }

  /** compact-wake subscriptions gated on a context-percent trigger (ORACLE-1 §3.6 Phase 1/2, D-10/D-11). */
  private async evaluateCompactTrigger(reminder: IdleReminderRecord, observed: ContextUsage, now: number): Promise<IdleReminderRecord> {
    const cw = reminder.compactWake!;
    if (!cw.crossedAt) {
      // Start the delaySeconds grace/veto window now; nothing is sent yet this tick.
      const updated = await this.store.updateIdleReminder(reminder.id, { compactWake: { ...cw, crossedAt: new Date(now).toISOString() } });
      return updated ?? reminder;
    }
    const crossedAtMs = Date.parse(cw.crossedAt);
    if (!Number.isFinite(crossedAtMs) || now - crossedAtMs < cw.delaySeconds * 1000) return reminder;
    // The compact-wake registration is the consent token (D-10); consume it synchronously,
    // before kicking off the (possibly long-running) compact flow in the background, so the
    // next reconcile tick cannot re-fire this subscription while one run is still in flight.
    await this.store.updateIdleReminder(reminder.id, { status: 'deleted', crossedCount: 0 });
    if (cw.mode === 'auto') {
      // Fire-and-forget: waiting for idle-stability can take minutes (worst case 15), and
      // this is called from inside reconcileOnce()/reconcileFast() -- awaiting it here would
      // block ALL other reconciliation (watchdog, messages, other agents' reminders) for that
      // entire window. Same pattern as runCompactWake()/the legacy observeCompact().
      const controller = new AbortController();
      this.observers.add(controller);
      void this.runAutoCompact(reminder, observed, controller.signal).finally(() => this.observers.delete(controller));
    } else {
      await this.notifyCompactTrigger(reminder, observed, now); // fast: a single postMessage call, safe to await
    }
    return this.store.findIdleReminder(reminder.id)!;
  }

  private async notifyCompactTrigger(reminder: IdleReminderRecord, observed: ContextUsage, now: number): Promise<void> {
    const cw = reminder.compactWake!;
    const body = [
      `type=compact-wake id=${reminder.id} target=${reminder.agentId} event=compact-threshold-crossed criterion=contextWindowUsedTokens ${reminder.comparator ?? 'gte'} ${this.effectiveThresholdTokens(reminder, observed)} (registered as ${reminder.thresholdPercent !== undefined ? `${(reminder.thresholdPercent * 100).toFixed(1)}%` : `${reminder.thresholdTokens} tokens`}) confirmed over 2 consecutive observations, mode=notify triggeredAt=${new Date(now).toISOString()}`,
      `observed: used=${observed.usedTokens} limit=${observed.limitTokens} percent=${(observed.percent * 100).toFixed(1)}% source=${observed.source}`,
      `Run this yourself when convenient: /compact ${cw.compact}`,
      cw.wake ? `After compacting, resume with: ${cw.wake}` : 'No wake steps were registered with this subscription; nothing will resume you after compacting.',
      `Unsubscribe: curl -X DELETE ${this.endpointBase()}/idle-reminders/${reminder.id} -H 'content-type: application/json' -d '{"reason":"processed"}'`,
    ].join('\n');
    await this.postMessage({ to: reminder.agentId, from: 'companion', body, delivery: 'on-idle', mode: 'notify', promptKind: 'compact-wake' });
  }

  private async waitForIdleStable(agentId: string, deadlineMs: number, signal: AbortSignal): Promise<boolean> {
    let stableSince: number | undefined;
    let previousUpdated: string | undefined;
    while (Date.now() < deadlineMs && !signal.aborted) {
      try {
        const inspect = asRecord((await this.cli.run(['inspect', agentId, '--json'], { agentId, signal, timeoutMs: 5_000 })).value);
        const status = lowerStatus(inspect.Status ?? inspect.status);
        const updated = String(inspect.UpdatedAt ?? inspect.updatedAt ?? '');
        const now = Date.now();
        if (status === 'idle' && updated === previousUpdated) stableSince ??= now;
        else stableSince = undefined;
        previousUpdated = updated;
        if (stableSince && now - stableSince >= 60_000) return true;
      } catch { /* continue until deadline */ }
      await sleep(5_000, signal);
    }
    return false;
  }

  private async runAutoCompact(reminder: IdleReminderRecord, preUsage: ContextUsage, signal: AbortSignal): Promise<void> {
    const cw = reminder.compactWake!;
    const agentId = reminder.agentId;
    // ORACLE-1 3.4-5: rate limit, the second line of defense (after 3.4-6's post-compact
    // verification) against any compaction loop this design did not anticipate.
    const lastAt = this.lastAutoCompactAt.get(agentId);
    if (lastAt !== undefined && Date.now() - lastAt < 60 * 60 * 1000) {
      console.warn(JSON.stringify({ type: 'auto-compact-deferred', agentId, reminderId: reminder.id, reason: 'rate-limited', minutesSinceLast: Math.round((Date.now() - lastAt) / 60_000) }));
      return;
    }
    // Only ever send /compact to an agent already observed idle; a running agent would be
    // interrupted mid-turn (ORACLE-1 3.3 C1, the single most expensive misfire).
    const idleCheck = await this.observeAgentIdle(agentId).catch(() => undefined);
    if (!idleCheck || idleCheck.status !== 'idle') {
      console.warn(JSON.stringify({ type: 'auto-compact-deferred', agentId, reminderId: reminder.id, reason: 'not idle', observedStatus: idleCheck?.status ?? 'unknown' }));
      return;
    }
    // ORACLE-1 3.4-7 (C5): a status='idle' agent can still be sitting on a plan-mode preview
    // or an unresolved permission prompt -- Status alone does not distinguish "genuinely done"
    // from "waiting on a human". Sending /compact there is C1 in disguise.
    if (idleCheck.mode === 'plan' || idleCheck.pendingPermissionsCount > 0) {
      console.warn(JSON.stringify({ type: 'auto-compact-deferred', agentId, reminderId: reminder.id, reason: 'plan-mode-or-pending-permission', mode: idleCheck.mode, pendingPermissionsCount: idleCheck.pendingPermissionsCount }));
      return;
    }
    this.lastAutoCompactAt.set(agentId, Date.now());
    this.quietUntil.set(agentId, Date.now() + 20 * 60 * 1000);
    try {
      try {
        await this.cli.run(['send', agentId, `/compact ${cw.compact}`], { agentId, signal });
      } catch (error) {
        console.warn(JSON.stringify({ type: 'auto-compact-send-failed', agentId, reminderId: reminder.id, error: error instanceof Error ? error.message : String(error) }));
        return;
      }
      const stable = await this.waitForIdleStable(agentId, Date.now() + 15 * 60 * 1000, signal);
      if (!stable) {
        console.warn(JSON.stringify({ type: 'auto-compact-stabilize-timeout', agentId, reminderId: reminder.id }));
        return;
      }
      const postUsage = this.contextUsageObserver ? await this.contextUsageObserver.observe(agentId) : 'unknown';
      // ORACLE-1 3.4-6: no verified shrink -> fail loud, never silently retry (that is C4, a
      // compaction loop that quietly degrades a summary of a summary each pass).
      const dropped = postUsage !== 'unknown' && postUsage.percent <= preUsage.percent / 2;
      console.log(JSON.stringify({ type: 'auto-compact-verified', agentId, reminderId: reminder.id, prePercent: preUsage.percent, postPercent: postUsage === 'unknown' ? 'unknown' : postUsage.percent, dropped }));
      if (!dropped) {
        const warnBody = `type=compact-wake id=${reminder.id} target=${agentId} event=compact-did-not-shrink criterion="post-compact percent <= half of pre-compact percent" pre=${(preUsage.percent * 100).toFixed(1)}% post=${postUsage === 'unknown' ? 'unknown' : (postUsage.percent * 100).toFixed(1) + '%'}\nAutomatic compaction did not shrink your context window as verified. This subscription is now consumed; investigate before re-registering it.`;
        await this.postMessage({ to: agentId, from: 'companion', body: warnBody, delivery: 'on-idle', mode: 'notify', promptKind: 'compact-wake' });
      }
      if (cw.wake) {
        try { await this.cli.run(['send', agentId, cw.wake], { agentId, signal }); }
        catch (error) { console.warn(JSON.stringify({ type: 'auto-compact-wake-failed', agentId, reminderId: reminder.id, error: error instanceof Error ? error.message : String(error) })); }
      }
    } finally {
      this.quietUntil.delete(agentId);
    }
  }

  /** Read-only GET /context-usage. Missing/unread fields are 'unknown', never 0 (see ContextUsageEntry). */
  async listContextUsage(agentId?: string): Promise<ContextUsageEntry[]> {
    if (!this.contextUsageObserver) return [];
    const entries = await this.contextUsageObserver.listAll();
    return agentId ? entries.filter((entry) => entry.agentId === agentId) : entries;
  }

  async listIdleReminders(agentId?: string): Promise<Array<IdleReminderRecord & { idleForSeconds: number; remainingSeconds: number }>> {
    const records = this.store.getIdleReminders().filter((item) => !agentId || item.agentId === agentId);
    const now = Date.now();
    const output: Array<IdleReminderRecord & { idleForSeconds: number; remainingSeconds: number }> = [];
    for (const record of records) {
      const observed = record.status === 'active' ? await this.observeIdleReminder(record, now) : record;
      if ((observed.metric ?? 'idle-seconds') === 'context-percent') {
        // idle-seconds' idleForSeconds/remainingSeconds concept does not apply here.
        // thresholdPercent/thresholdTokens are both already on the stored record (resolved
        // once, at registration time -- see resolveContextThreshold's comment).
        output.push({ ...observed, idleForSeconds: 0, remainingSeconds: 0 });
        continue;
      }
      const since = observed.idleSince ? Date.parse(observed.idleSince) : NaN;
      const idleForSeconds = Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
      output.push({ ...observed, idleForSeconds, remainingSeconds: Math.max(0, (observed.thresholdSeconds ?? 0) - idleForSeconds) });
    }
    return output;
  }

  async deleteIdleReminder(id: string, reason: string): Promise<{ id: string; status: 'deleted' }> {
    if (!reason?.trim()) missingField('reason');
    const record = this.store.findIdleReminder(id);
    if (!record) throw new CompanionError('not_found', 'idle reminder not found');
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
      id, agentId: managerId, name: id, prompt: '', cron: '', expiresIn: '', status: 'active', schedulingKind: 'in-process', createdAt: new Date().toISOString(),
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
      `snapshot: child=${snapshot.childId} status=${snapshot.status} updatedAt=${snapshot.updatedAt ?? 'unknown'} hasLivePaseoWait=${snapshot.hasLivePaseoWait ?? 'unknown'} hasLiveCompanionWatch=${snapshot.hasLiveCompanionWatch ?? 'unknown'} gitDirty=${snapshot.gitDirty ?? 'unknown'} latestCommit=${snapshot.latestCommit ?? 'unknown'}`,
      detail,
      ephemeral ? 'This health alert is non-acknowledgement based; the alert ID remains cancellable.' : 'Acknowledge this completion alert after review; future matching transitions remain deduplicated by this ID.',
    ].join('\n');
    await this.postMessage({ to: managerId, from: 'companion', body, urgency: ephemeral ? 'urgent' : 'normal', delivery: 'on-idle', mode: 'notify', promptKind: 'watchdog', actionCommand: this.cancelCommand(reminder.id), ...(ephemeral ? { kind: 'heartbeat-recovery' as const } : {}) });
    snapshot.notified = [...notified, eventType];
    return true;
  }

  async watchdogTick(managerId: string, now = Date.now(), staleMs = this.watchdogStaleMs, listed?: ChildrenResult, managerWait?: boolean | 'unknown'): Promise<void> {
    const snapshotResult = listed ?? await this.listChildren(managerId);
    const running = snapshotResult.children.filter((child) => lowerStatus(child.status) === 'running');
    const activeChildren = new Set(snapshotResult.children.map((child) => child.id));
    for (const child of snapshotResult.children) {
      const prior = this.store.getWatchdogSnapshot(managerId, child.id);
      const snapshot: WatchdogSnapshot = { managerId, childId: child.id, status: child.status, updatedAt: child.updatedAt, hasLivePaseoWait: child.hasLivePaseoWait, hasLiveCompanionWatch: child.hasLiveCompanionWatch, gitDirty: child.gitDirty, latestCommit: child.latestCommit, notified: [...(prior?.notified ?? [])] };
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
      // hasLiveWakeupSource is the union of both sources (service.ts unionLiveSources),
      // so in steady state (companion watch retired once a paseo wait is live) a
      // wait-loss transition and "no live wakeup source" are the same underlying
      // event observed through two different checks. Without deduplication both
      // fire on the same tick, and the resulting pair is indistinguishable in the
      // alert stream from an actual double fault. child-wait-lost already reports
      // this gap (with the fallback-armed detail); suppress the redundant
      // child-no-wakeup alert while that report is unresolved so only one alert
      // survives per real coverage-loss event.
      const wakeupMissing = status === 'running' && child.hasLiveWakeupSource === false;
      const waitLossAlreadyReported = (snapshot.notified ?? []).includes('child-wait-lost');
      const noWakeup = wakeupMissing && !waitLossAlreadyReported;
      if (noWakeup) await this.notifyWatchdog(managerId, child.id, 'child-no-wakeup', 'status=running and hasLiveWakeupSource=false', `child=${child.id} running without a live wakeup source, lastUpdatedAt=${child.updatedAt ?? 'unknown'}`, true, snapshot);
      if (!wakeupMissing) snapshot.notified = (snapshot.notified ?? []).filter((item) => item !== 'child-no-wakeup');
      const updatedMs = child.updatedAt ? Date.parse(child.updatedAt) : NaN;
      const stale = status === 'running' && Number.isFinite(updatedMs) && now - updatedMs > staleMs;
      if (stale) await this.notifyWatchdog(managerId, child.id, 'child-stale', `status=running and updatedAt older than ${Math.round(staleMs / 60000)} minutes`, `child=${child.id} running, lastUpdatedAt=${child.updatedAt}`, true, snapshot);
      else snapshot.notified = (snapshot.notified ?? []).filter((item) => item !== 'child-stale');
      await this.store.setWatchdogSnapshot(snapshot);
    }
    const managerSnapshot = this.store.getWatchdogSnapshot(managerId, '__manager__') ?? { managerId, childId: '__manager__', status: '', notified: [] };
    const observedManagerWait = managerWait ?? await this.hasLivePaseoWait(managerId);
    managerSnapshot.hasLivePaseoWait = observedManagerWait;
    // A live wait owned by any currently running child also covers the manager:
    // the child can yield the next turn without requiring a manager wakeup.
    const runningChildWait = running.some((child) => child.hasLivePaseoWait === true);
    const managerNoWakeup = running.length > 0 && snapshotResult.companionKnownWakeupSources.length === 0
      && observedManagerWait === false && !runningChildWait;
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

  /** Persist before handing a coalesced batch to its selected Paseo transport. */
  async postMessage(body: { to: string; from: string; body: string; urgency?: MessageUrgency; immediate?: boolean; delivery?: MessageDelivery; mode?: MessageMode; ackDeadlineAt?: string; ackDeadlineSeconds?: number; replyTo?: string; promptKind?: MessageRecord['promptKind']; actionCommand?: string; kind?: 'heartbeat-recovery'; recoveryManagerId?: string; recoveryCounts?: Record<string, number>; recoveryRunIds?: Record<string, string[]> }): Promise<Omit<MessageRecord, 'delivery'> & {
    schedule: null;
    delivery: { id: string; transport: 'paseo-send' | 'heartbeat'; status: 'accepted' | 'pending'; acceptedAt: string | null; batchIds: string[] } | null;
  }> {
    if (!body.to?.trim()) missingField('to');
    if (!body.from?.trim()) missingField('from');
    if (!body.body?.trim()) missingField('body');
    if (body.urgency !== undefined && body.urgency !== 'normal' && body.urgency !== 'urgent') invalidValue('urgency must be normal or urgent', 'urgency', ['normal', 'urgent']);
    const deliveryMode = body.delivery ?? (body.immediate || body.urgency === 'urgent' ? 'interrupt' : 'on-idle');
    if (deliveryMode !== 'interrupt' && deliveryMode !== 'on-idle') invalidValue('delivery must be interrupt or on-idle', 'delivery', ['interrupt', 'on-idle']);
    const mode = body.mode ?? 'notify';
    if (!['notify', 'ack', 'reply'].includes(mode)) invalidValue('mode must be notify, ack, or reply', 'mode', ['notify', 'ack', 'reply']);
    if (mode === 'reply' && !body.replyTo?.trim()) missingField('replyTo');
    if (body.replyTo && !this.store.getMessages().some((item) => item.id === body.replyTo)) throw new CompanionError('not_found', 'reply parent message not found');
    const message: MessageRecord = {
      id: randomUUID(),
      to: body.to.trim(),
      from: body.from.trim(),
      body: body.body,
      urgency: body.urgency ?? 'normal',
      delivery: deliveryMode, mode,
      status: 'pending',
      createdAt: new Date().toISOString(),
      ...(body.ackDeadlineAt ? { ackDeadlineAt: body.ackDeadlineAt } : body.ackDeadlineSeconds ? { ackDeadlineAt: new Date(Date.now() + body.ackDeadlineSeconds * 1000).toISOString() } : {}),
      ...(body.replyTo ? { replyTo: body.replyTo } : {}),
      ...(body.promptKind ? { promptKind: body.promptKind } : {}),
      ...(body.actionCommand ? { actionCommand: body.actionCommand } : {}),
      ...(body.kind ? { kind: body.kind } : {}),
      ...(body.recoveryManagerId ? { recoveryManagerId: body.recoveryManagerId } : {}),
      ...(body.recoveryCounts ? { recoveryCounts: body.recoveryCounts } : {}),
      ...(body.recoveryRunIds ? { recoveryRunIds: body.recoveryRunIds } : {}),
    };
    // This write deliberately precedes every daemon call.
    await this.store.addMessage(message);
    if (message.replyTo) await this.store.updateMessage(message.replyTo, { status: 'answered', replyMessageId: message.id, answeredAt: message.createdAt });
    await this.ensureMessageDelivery(message.to);
    const audit = this.store.getMessageSchedules().find((item) => item.batchIds.includes(message.id)) ?? null;
    const receipt = audit ? {
      id: audit.id,
      transport: (audit.transport ?? 'paseo-send') as 'paseo-send' | 'heartbeat',
      status: audit.status === 'completed' ? 'accepted' as const : 'pending' as const,
      acceptedAt: audit.status === 'completed' ? audit.lastRunAt ?? null : null,
      batchIds: audit.batchIds,
    } : null;
    if (audit?.status === 'completed') {
      const delivered: MessageRecord = { ...message, status: 'delivered', deliveredAt: audit.lastRunAt };
      const { delivery: _delivery, ...withoutDelivery } = delivered;
      return { ...withoutDelivery, schedule: null, delivery: receipt };
    }
    const { delivery: _delivery, ...withoutDelivery } = message;
    return { ...withoutDelivery, schedule: null, delivery: receipt };
  }

  getMessages(filters?: string | { to?: string; from?: string; status?: string; replyTo?: string }): MessageRecord[] {
    const query = typeof filters === 'string' ? { to: filters } : (filters ?? {});
    return this.store.getMessages().filter((message) =>
      (!query.to || message.to === query.to) && (!query.from || message.from === query.from)
      && (!query.status || message.status === query.status) && (!query.replyTo || message.replyTo === query.replyTo));
  }

  async deleteMessage(id: string, reason: string): Promise<{ id: string; status: 'deleted' | 'acknowledged'; retirementPending: boolean }> {
    if (!reason?.trim()) missingField('reason');
    const message = this.store.getMessages().find((item) => item.id === id);
    if (!message) {
      const retired = this.store.getLedger().some((record) => record.type === 'deferred' && record.target === id
        && (record.verdict === 'message-acknowledged' || record.verdict === 'message-deleted'));
      const autoCleared = this.store.getMessageSchedules().some((schedule) => schedule.status === 'completed' && schedule.batchIds.includes(id));
      if (retired || autoCleared) return { id, status: 'deleted', retirementPending: false };
      throw new CompanionError('not_found', 'message not found');
    }
    if (message.status === 'acknowledged') return { id, status: 'acknowledged', retirementPending: false };
    if ((message.mode ?? 'notify') === 'ack' && ['delivered', 'unacknowledged'].includes(message.status)) {
      await this.store.updateMessage(id, { status: 'acknowledged', acknowledgedAt: new Date().toISOString(), acknowledgementReason: reason });
      await this.store.addLedger({ type: 'deferred', target: id, verdict: 'message-acknowledged', reason });
      await this.store.pruneMessages();
      return { id, status: 'acknowledged', retirementPending: false };
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
    const sorted = this.sortMessages(messages);
    return this.deliveryPrompt(recipient, sorted.map((message) => ({
      id: message.id,
      from: message.from,
      at: message.createdAt,
      urgency: message.urgency,
      mode: message.mode ?? 'notify',
      kind: message.promptKind ?? 'message',
      body: message.body,
      actionCommand: message.actionCommand ?? (message.kind !== 'heartbeat-recovery' && (message.mode ?? 'notify') === 'ack'
        ? `curl -X DELETE ${this.endpointBase()}/messages/${message.id} -H 'content-type: application/json' -d '{"reason":"processed"}'`
        : undefined),
    })));
  }

  private async inspectMessageSchedule(schedule: MessageScheduleRecord): Promise<MessageScheduleInspection> {
    if (!schedule.daemonId) return { state: 'missing', hasRun: false };
    try {
      const inspectValue = this.scheduleObserver
        ? await this.scheduleObserver.scheduleInspect(schedule.daemonId)
        : (await this.cli.run(['schedule', 'inspect', schedule.daemonId, '--json'], { agentId: schedule.recipient, timeoutMs: 5_000 })).value;
      const inspectedEnvelope = unwrapPayload(inspectValue);
      if (inspectedEnvelope.schedule == null && /not found|missing/i.test(errorText(inspectedEnvelope.error))) return { state: 'missing', hasRun: false };
      if (inspectedEnvelope.error && inspectedEnvelope.schedule === undefined) return { state: 'unknown', hasRun: false };
      const inspected = asRecord(inspectedEnvelope.schedule && typeof inspectedEnvelope.schedule === 'object' ? inspectedEnvelope.schedule : inspectedEnvelope);
      if (!Object.keys(inspected).length) return { state: 'unknown', hasRun: false };
      const logsValue = this.scheduleObserver
        ? await this.scheduleObserver.scheduleLogs(schedule.daemonId)
        : (await this.cli.run(['schedule', 'logs', schedule.daemonId, '--json'], { agentId: schedule.recipient, timeoutMs: 5_000 })).value;
      const logsRecord = unwrapPayload(logsValue);
      const rawLogs = Array.isArray(logsValue)
        ? logsValue
        : (logsRecord.logs ?? logsRecord.runs ?? logsRecord.entries ?? logsRecord.data);
      if (!Array.isArray(rawLogs)) return { state: 'unknown', hasRun: false };
      const logs = rawLogs.map(asRecord);
      const latest = logs.reduce<Record<string, any>>((current, candidate) => {
        const currentAt = Date.parse(String(current.endedAt ?? current.ended_at ?? current.startedAt ?? current.started_at ?? current.scheduledFor ?? current.scheduled_for ?? ''));
        const candidateAt = Date.parse(String(candidate.endedAt ?? candidate.ended_at ?? candidate.startedAt ?? candidate.started_at ?? candidate.scheduledFor ?? candidate.scheduled_for ?? ''));
        return Number.isFinite(candidateAt) && (!Number.isFinite(currentAt) || candidateAt >= currentAt) ? candidate : current;
      }, {});
      const hasRun = logs.length > 0;
      const runStatus = lowerStatus(latest.status ?? latest.state ?? latest.outcome ?? latest.result);
      const scheduleStatus = lowerStatus(inspected.status ?? inspected.Status ?? inspected.state ?? inspected.State);
      // A terminal run log is authoritative over the wrapper schedule status:
      // Paseo may report a completed schedule after a busy failure.
      if (runStatus) {
        if (/running|in.?progress|started/.test(runStatus)) return { state: 'running', hasRun };
        if (/fail|error|timeout|busy/.test(runStatus)) return { state: 'failed', hasRun };
        if (/success|succeed|complete|ok/.test(runStatus)) {
          const endedAt = String(latest.endedAt ?? latest.ended_at ?? '') || undefined;
          const lastRunAt = String(latest.lastRunAt ?? latest.last_run_at ?? inspected.lastRunAt ?? inspected.last_run_at ?? '') || undefined;
          return { state: 'success', hasRun, ...(endedAt ? { endedAt } : {}), ...((endedAt ?? lastRunAt) ? { lastRunAt: endedAt ?? lastRunAt } : {}) };
        }
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

  /** Retire pre-redesign non-heartbeat schedules that were left in flight. */
  private async migrateLegacyMessageSchedules(): Promise<void> {
    for (const schedule of this.store.getMessageSchedules()) {
      if (schedule.transport !== undefined || !['pending', 'active', 'running'].includes(schedule.status)) continue;
      await this.migrateLegacyMessageSchedule(schedule);
    }
  }

  private async reconcileHeartbeatMessageSchedules(): Promise<void> {
    for (const schedule of this.store.getMessageSchedules().filter((item) => item.transport === 'heartbeat' && ['active', 'running'].includes(item.status))) {
      const observed = await this.inspectMessageSchedule(schedule);
      if (observed.state === 'success') {
        const deliveredAt = observed.lastRunAt ?? new Date().toISOString();
        await this.store.updateMessageSchedule(schedule.id, { status: 'completed', lastRunAt: deliveredAt });
        try { await this.finalizeAcceptedMessageSchedule({ ...schedule, status: 'completed', lastRunAt: deliveredAt }); } catch { /* retry local cleanup later */ }
        try {
          await this.cli.run(['heartbeat', 'delete', schedule.daemonId!, '--json'], { agentId: schedule.recipient, timeoutMs: 5_000 });
          await this.store.updateMessageSchedule(schedule.id, { daemonId: undefined });
        } catch { /* delivered state is authoritative; retry retirement next tick */ }
      } else if (observed.state === 'missing') {
        await this.store.updateMessageSchedule(schedule.id, { status: 'failed' });
        console.warn(JSON.stringify({ type: 'message-delivery-terminal', recipient: schedule.recipient, generation: schedule.generation, batchIds: schedule.batchIds, transport: 'heartbeat', reason: observed.state }));
      } else {
        // 'unknown' and 'live' are not terminal observations, but they must not be an
        // absorbing state either: an unresolvable schedule otherwise blocks re-delivery
        // (ensureMessageDeliveryOnce treats 'active' as accepted) forever once the
        // underlying heartbeat itself expires ('--expires-in 30m').
        const createdAtMs = Date.parse(schedule.createdAt);
        const ageMs = Number.isFinite(createdAtMs) ? Date.now() - createdAtMs : undefined;
        if (ageMs !== undefined && ageMs > MESSAGE_SCHEDULE_ABSORPTION_TIMEOUT_MS) {
          await this.store.updateMessageSchedule(schedule.id, { status: 'failed' });
          console.warn(JSON.stringify({ type: 'message-delivery-terminal', recipient: schedule.recipient, generation: schedule.generation, batchIds: schedule.batchIds, transport: 'heartbeat', reason: 'absorption-timeout', observedState: observed.state, ageMs }));
        }
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
        const mode = message.mode ?? 'notify';
        if (mode === 'notify') await this.store.removeMessages([message.id]);
        else await this.store.updateMessage(message.id, { status: 'delivered', deliveredAt });
        if (message.replyTo) {
          await this.store.updateMessage(message.replyTo, { status: 'answered', replyMessageId: message.id, answeredAt: deliveredAt });
        }
      }
    }
    for (const reminder of this.store.getReminders().filter((item) => item.deliveryMessageId && schedule.batchIds.includes(item.deliveryMessageId))) {
      await this.store.updateReminder(reminder.id, { lastDeliveredAt: deliveredAt, deliveryStatus: 'delivered' });
    }
  }

  private async retireCompletedHeartbeatSchedules(): Promise<void> {
    for (const schedule of this.store.getMessageSchedules().filter((item) => item.transport === 'heartbeat' && item.status === 'completed' && item.daemonId)) {
      try {
        await this.cli.run(['heartbeat', 'delete', schedule.daemonId!, '--json'], { agentId: schedule.recipient, timeoutMs: 5_000 });
        await this.store.updateMessageSchedule(schedule.id, { daemonId: undefined });
      } catch { /* retry before the next cron tick */ }
    }
  }

  private async createMessageSchedule(recipient: string, batch: MessageRecord[], transport: 'heartbeat' | 'paseo-send'): Promise<MessageScheduleRecord | undefined> {
    const generation = randomUUID();
    const local: MessageScheduleRecord = {
      id: randomUUID(),
      recipient,
      generation,
      batchIds: batch.map((message) => message.id),
      prompt: this.messagePrompt(recipient, batch),
      status: 'pending',
      transport,
      ...(transport === 'heartbeat' ? { cron: '* * * * *' } : {}),
      createdAt: new Date().toISOString(),
    };
    await this.store.addMessageSchedule(local);
    if (transport === 'heartbeat') {
      try {
        const value = asRecord((await this.cli.run([
          'heartbeat', 'create', local.prompt, '--cron', local.cron!, '--expires-in', '30m',
          '--name', `paseo-reminder-message-${generation.slice(0, 8)}`, '--timezone', 'UTC', '--json',
        ], { agentId: recipient })).value);
        const daemonId = String(value.id ?? value.heartbeatId ?? value.scheduleId ?? '');
        if (!daemonId) throw new Error('heartbeat create returned no id');
        await this.store.updateMessageSchedule(local.id, { daemonId, status: 'active', lastRunAt: value.lastRunAt });
        console.log(JSON.stringify({ type: 'message-delivery-armed', recipient, generation, batchIds: local.batchIds, transport: 'heartbeat', daemonId }));
        return this.store.getMessageSchedules().find((item) => item.id === local.id);
      } catch (error) {
        await this.store.updateMessageSchedule(local.id, { status: 'failed' });
        console.warn(JSON.stringify({ type: 'message-delivery-failed', recipient, generation, batchIds: local.batchIds, transport: 'heartbeat', error: error instanceof Error ? error.message : String(error) }));
        return undefined;
      }
    }
    let acceptedAt: string;
    try {
      const senderAgentId = batch[0]?.from;
      const value = unwrapPayload((await this.cli.run(['send', '--no-wait', '--json', recipient, local.prompt], { agentId: senderAgentId })).value);
      const status = lowerStatus(value.status);
      if (!['sent', 'accepted'].includes(status)) throw new Error(`paseo send did not confirm sent status (status=${String(value.status)})`);
      acceptedAt = new Date().toISOString();
      // Mark the local record terminal before receipt cleanup.  If local
      // cleanup fails after acceptance, reconcile can finish it without ever
      // issuing a duplicate send.
      await this.store.updateMessageSchedule(local.id, { status: 'completed', lastRunAt: acceptedAt, transport: 'paseo-send' });
    } catch (error) {
      await this.store.updateMessageSchedule(local.id, { status: 'failed' });
      console.warn(JSON.stringify({ type: 'message-delivery-failed', recipient, generation, batchIds: local.batchIds, transport: 'paseo-send', error: error instanceof Error ? error.message : String(error) }));
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
    // A coordinator-driven compact is in flight for this recipient: hold
    // delivery (queued, not dropped -- messages stay 'pending' in the store
    // and the next reconcile after the window closes will pick them back up)
    // so an unrelated reminder/message cannot interrupt the compact turn
    // (ORACLE-1 3.2/UPSTREAM "Self-compact is not atomic with respect to
    // reminder delivery").
    if ((this.quietUntil.get(recipient) ?? 0) > Date.now()) return;
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
    // A failed terminal run did not hand the batch to the recipient. Keep the
    // pending messages eligible for the next delivery generation; only live,
    // in-flight, or successful generations block duplicate delivery.
    const accepted = new Set(this.store.getMessageSchedules().filter((item) => item.recipient === recipient && ['active', 'running', 'completed'].includes(item.status)).flatMap((item) => item.batchIds));
    const pending = queued.filter((message) => !accepted.has(message.id));
    if (!pending.length) return;
    const interrupt = pending.filter((message) => (message.delivery ?? (message.urgency === 'urgent' ? 'interrupt' : 'on-idle')) === 'interrupt');
    if (interrupt.length) await this.createMessageSchedule(recipient, this.sortMessages(interrupt), 'paseo-send');
    const idle = pending.filter((message) => !interrupt.includes(message));
    if (!idle.length) return;
    await this.createMessageSchedule(recipient, this.sortMessages(idle), 'heartbeat');
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
    const now = Date.now();
    for (const message of this.store.getMessages()) {
      if (message.mode !== 'ack' || message.status !== 'delivered' || !message.ackDeadlineAt) continue;
      if (Date.parse(message.ackDeadlineAt) <= now) await this.store.updateMessage(message.id, { status: 'unacknowledged', unacknowledgedAt: message.unacknowledgedAt ?? new Date(now).toISOString() });
    }
    await this.reconcileHeartbeatMessageSchedules();
    await this.retireCompletedHeartbeatSchedules();
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
    await this.store.pruneMessages();
  }

  private async reconcileFast(): Promise<void> {
    await this.reconcileMessages();
    for (const reminder of this.store.getReminders()) {
      if ((reminder.status === 'pending' || reminder.status === 'active') &&
          (reminder.mode === 'once' || reminder.mode === 'repeat' || reminder.targetAt || reminder.everySeconds)) {
        await this.reconcileLocalReminder(reminder);
      }
    }
    await this.reconcileIdleReminders();
  }

  /**
   * D-10 (Owner 2026-08-19): `compact` is required and is what the coordinator actually
   * sends (`"/compact " + compact`); `wake` is optional and, if present, is what gets sent
   * once the compaction turn settles back to idle. No `wake` means no wake -- calling this
   * endpoint is now itself the trigger, not a request to arm a watcher for a compact the
   * caller is about to run out of band (that was the pre-D-10 contract; ORACLE-1 §3.4-3's
   * "resumeSteps as a consent token" design does not apply here since `wake` is optional).
   *
   * D-11: `delaySeconds` (default 10) is the grace window between "conditions satisfied"
   * and the coordinator actually sending `/compact`; `DELETE /reminders/:id` during that
   * window vetoes it. Because the default is short, this window is NOT the primary veto
   * mechanism for the `trigger`-gated path below -- ORACLE-1 §3.5's other two layers
   * (event-triggered DELETE, post-notify unsubscribe) still apply.
   *
   * An optional `trigger` (context-percent metric + threshold) turns this into a standing
   * subscription instead of an immediate action: it is stored as an IdleReminderRecord with
   * `metric:'context-percent'` and a `compactWake` payload, and evaluated by the same
   * reconcileIdleReminders() loop idle-reminders already use (ORACLE-1 §2.1: reuse the
   * existing threshold-subscription concept, do not add a fifth one). `mode` (D-7, default
   * 'notify') controls whether the coordinator sends `/compact` itself once the trigger and
   * delay are satisfied, or only notifies the agent with the command text to run themselves.
   */
  async compactWake(body: { agentId: string; compact: string; wake?: string; delaySeconds?: number; mode?: 'notify' | 'auto'; trigger?: { metric: 'context-percent'; thresholdPercent?: number; thresholdTokens?: number; comparator?: 'gte' | 'lte' } }): Promise<unknown> {
    await this.store.addManager(body.agentId);
    rejectUnknownFields(body as Record<string, unknown>, ['agentId', 'compact', 'wake', 'delaySeconds', 'mode', 'trigger']);
    if (!body.compact?.trim()) missingField('compact');
    const delaySeconds = Number.isFinite(body.delaySeconds) && (body.delaySeconds as number) >= 0 ? (body.delaySeconds as number) : 10;
    const mode = body.mode === 'auto' ? 'auto' : 'notify';
    if (body.trigger) {
      rejectUnknownFields(body.trigger as unknown as Record<string, unknown>, ['metric', 'thresholdPercent', 'thresholdTokens', 'comparator']);
      if (body.trigger.metric !== 'context-percent') invalidValue('trigger.metric must be context-percent', 'trigger.metric');
      const resolved = await this.resolveContextThreshold(body.agentId, body.trigger);
      const comparator = body.trigger.comparator ?? 'gte';
      const record: IdleReminderRecord = {
        id: randomUUID(), agentId: body.agentId,
        message: `coordinator-driven compact at context-percent ${(resolved.thresholdPercent * 100).toFixed(1)}% (${resolved.thresholdTokens} tokens)`,
        thresholdPercent: resolved.thresholdPercent, thresholdTokens: resolved.thresholdTokens,
        once: true, status: 'active', createdAt: new Date().toISOString(),
        metric: 'context-percent', comparator,
        compactWake: { compact: body.compact, wake: body.wake, mode, delaySeconds },
      };
      await this.store.addIdleReminder(record);
      return { id: record.id, status: 'active', mode, delaySeconds, compact: body.compact, wake: body.wake, trigger: { metric: 'context-percent', comparator, thresholdPercent: resolved.thresholdPercent, thresholdTokens: resolved.thresholdTokens } };
    }
    // No trigger: the call itself is the trigger. Grace window is an in-process timer, not a
    // daemon heartbeat -- honest limitation: it does not survive a coordinator restart within
    // the window. Acceptable for the 10s default; a caller who sets a large delaySeconds as a
    // real veto window should be aware a restart during it silently drops the compact.
    const localId = randomUUID();
    // Built eagerly (even though it is only sent once idle-stable after the compact) so a
    // human inspecting GET /reminders can see exactly what will wake the agent, and so the
    // eventual send reuses one fixed rendering rather than silently drifting.
    const wakePrompt = body.wake
      ? this.deliveryPrompt(body.agentId, [{ id: localId, from: 'paseo-reminder', at: new Date().toISOString(), urgency: 'normal', mode: 'ack', kind: 'compact-wake', body: `type=compact-wake id=${localId} target=${body.agentId} event=compact-recovery criterion=status=idle and updatedAt unchanged for 60s after coordinator-issued /compact\n${body.wake}`, actionCommand: this.cancelCommand(localId) }])
      : '';
    const pending: ReminderRecord = {
      id: localId, agentId: body.agentId, name: `compact-wake-${localId.slice(0, 8)}`, prompt: wakePrompt,
      cron: '', expiresIn: `${Math.max(1, Math.ceil((delaySeconds + 900) / 60))}m`,
      status: 'pending', schedulingKind: 'cron', kind: 'compact-wake', createdAt: new Date().toISOString(),
    };
    await this.store.addReminder(pending);
    const controller = new AbortController();
    this.observers.add(controller);
    void this.runCompactWake(body.agentId, body.compact, body.wake, delaySeconds, localId, controller.signal).finally(() => this.observers.delete(controller));
    return { id: localId, status: 'pending', delaySeconds, mode: 'immediate', compact: body.compact, wake: body.wake, willWake: Boolean(body.wake) };
  }

  private async runCompactWake(agentId: string, compact: string, wake: string | undefined, delaySeconds: number, localId: string, signal: AbortSignal): Promise<void> {
    // Poll in short increments rather than one long sleep so a DELETE veto during the grace
    // window is observed promptly instead of only after the full delaySeconds has elapsed.
    const graceDeadline = Date.now() + delaySeconds * 1000;
    while (Date.now() < graceDeadline) {
      if (signal.aborted || this.store.findReminder(localId)?.status === 'deleted') return;
      await sleep(Math.min(1_000, Math.max(0, graceDeadline - Date.now())), signal).catch(() => {});
    }
    if (signal.aborted) return;
    if (this.store.findReminder(localId)?.status === 'deleted') return; // vetoed via DELETE /reminders/:id
    await this.store.updateReminder(localId, { status: 'active' });
    this.quietUntil.set(agentId, Date.now() + 20 * 60 * 1000);
    try {
      try {
        await this.cli.run(['send', agentId, `/compact ${compact}`], { agentId, signal });
      } catch (error) {
        await this.store.updateReminder(localId, { status: 'dead' });
        console.warn(JSON.stringify({ type: 'compact-send-failed', agentId, localId, error: error instanceof Error ? error.message : String(error) }));
        return;
      }
      if (!wake) { await this.store.updateReminder(localId, { status: 'deleted' }); return; }
      const stable = await this.waitForIdleStable(agentId, Date.now() + 15 * 60 * 1000, signal);
      if (!stable) {
        console.warn(JSON.stringify({ type: 'compact-wake-stabilize-timeout', agentId, localId }));
        await this.store.updateReminder(localId, { status: 'dead' });
        return;
      }
      const armed = this.store.findReminder(localId);
      if (!armed || armed.status === 'deleted') return;
      try { await this.cli.run(['send', agentId, armed.prompt], { agentId, signal }); }
      catch (error) { console.warn(JSON.stringify({ type: 'compact-wake-send-failed', agentId, localId, error: error instanceof Error ? error.message : String(error) })); }
      await this.store.updateReminder(localId, { status: 'deleted' });
    } finally {
      this.quietUntil.delete(agentId);
    }
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
    if (!['park', 'known-red', 'deferred'].includes(body.type)) invalidValue('type must be park, known-red, or deferred', 'type', ['park', 'known-red', 'deferred']);
    if (!body.verdict?.trim()) missingField('verdict');
    if (!body.reason?.trim()) missingField('reason');
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
    if (!record || record.revokedAt) throw new CompanionError('not_found', 'ledger record not found');
    await this.store.revokeLedger(record, reason);
    if (record.type === 'park' && !this.store.getLedger().some((item) => item.type === 'park' && item.target === record.target && !item.revokedAt)) {
      try { await this.cli.run(['agent', 'update', record.target, '--label', 'parked=false', '--json']); } catch { /* best effort */ }
    }
    return { ...record, status: 'revoked' };
  }

  async createCorrection(body: {
    managerId: string;
    auditorId: string;
    findings?: unknown[];
    finding?: unknown;
  }): Promise<CorrectionInstance> {
    if (!body.managerId?.trim()) missingField('managerId');
    if (!body.auditorId?.trim()) missingField('auditorId');
    const rawFindings = Array.isArray(body.findings) ? body.findings : body.finding === undefined ? [] : [body.finding];
    if (rawFindings.length === 0) invalidValue('findings must contain at least one finding', 'findings');
    const findings: CorrectionFinding[] = rawFindings.map((raw, index) => {
      const input = typeof raw === 'string' ? { text: raw } : (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {});
      const id = String(input.id ?? input.findingId ?? `finding-${index + 1}-${randomUUID().slice(0, 8)}`);
      const text = String(input.text ?? input.finding ?? '').trim();
      if (!text) invalidValue('each finding requires text', 'findings');
      return { id, text, resolution: null };
    });
    const instance: CorrectionInstance = {
      id: randomUUID(),
      managerId: body.managerId.trim(),
      auditorId: body.auditorId.trim(),
      createdAt: new Date().toISOString(),
      status: 'open',
      findings,
      closedAt: null,
    };
    await this.store.addManager(instance.managerId);
    return this.store.addCorrection(instance);
  }

  listCorrections(managerId?: string, status?: string): CorrectionInstance[] {
    return this.store.getCorrections().filter((item) => (!managerId || item.managerId === managerId) && (!status || item.status === status));
  }

  async resolveCorrection(id: string, body: { findingId?: string; verdict?: string; note?: string }): Promise<CorrectionInstance> {
    const instance = this.store.findCorrection(id);
    if (!instance) throw new CompanionError('not_found', 'correction instance not found');
    const findingId = body.findingId;
    if (!findingId) {
      missingField('findingId');
    }
    const resolutionValue = String(body.verdict ?? '').toUpperCase();
    if (resolutionValue !== 'ACCEPT' && resolutionValue !== 'REFUSE') invalidValue('resolution must be ACCEPT or REFUSE', 'resolution', ['ACCEPT', 'REFUSE']);
    const note = typeof body.note === 'string' ? body.note.trim() : undefined;
    if (resolutionValue === 'REFUSE' && !note) missingField('note');
    const resolved = await this.store.resolveCorrection(id, findingId, resolutionValue as CorrectionResolution, note);
    if (!resolved) throw new CompanionError('not_found', 'correction finding not found');
    return resolved;
  }

  getCorrectionGate(managerId: string): { blocked: boolean; openInstances: CorrectionInstance[]; reason: string } {
    const openInstances = this.listCorrections(managerId, 'open').filter((item) => item.findings.some((finding) => finding.resolution === null));
    const blocked = openInstances.length > 0;
    if (!blocked) return { blocked: false, openInstances: [], reason: 'correction gate clear' };
    const base = this.endpointBase();
    const details = openInstances.map((instance) => {
      const findings = instance.findings.filter((finding) => finding.resolution === null).map((finding) => {
        const body = JSON.stringify({ findingId: finding.id, verdict: 'ACCEPT' });
        return `${finding.id}: ${finding.text} (resolve: curl -sS -X POST ${base}/corrections/${instance.id}/resolve -H 'content-type: application/json' -d '${body}')`;
      });
      return `instance ${instance.id}; unresolved finding(s): ${findings.join('; ')}`;
    }).join(' | ');
    return { blocked: true, openInstances, reason: `correction gate blocked: ${details}` };
  }

  getGate(managerId: string): ReturnType<CompanionService['getCorrectionGate']> { return this.getCorrectionGate(managerId); }

  async reconcileReminders(): Promise<void> {
    if (this.heartbeatReconcileInFlight) return this.heartbeatReconcileInFlight;
    const operation = this.reconcileRemindersOnce();
    this.heartbeatReconcileInFlight = operation;
    try { await operation; } finally { this.heartbeatReconcileInFlight = undefined; }
  }

  private async reconcileRemindersOnce(): Promise<void> {
    for (const reminder of this.store.getReminders()) {
      if (reminder.status !== 'pending' && reminder.status !== 'active') continue;
      if (reminder.mode === 'once' || reminder.mode === 'repeat' || reminder.targetAt || reminder.everySeconds) {
        await this.reconcileLocalReminder(reminder);
        continue;
      }
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
    await this.store.pruneReminders();
  }

  private async reconcileLocalReminder(reminder: ReminderRecord, now = Date.now()): Promise<void> {
    const dueAt = Date.parse(reminder.nextRunAt ?? reminder.targetAt ?? '');
    if (!Number.isFinite(dueAt) || dueAt > now) return;
    const priorDelivery = reminder.deliveryMessageId ? this.store.getMessages().find((message) => message.id === reminder.deliveryMessageId) : undefined;
    if (priorDelivery) return;
    const firedAt = new Date(now).toISOString();
    const deliveryPrompt = reminder.prompt.replace('triggeredAt=pending', `triggeredAt=${firedAt}`);
    const actionCommand = this.cancelCommand(reminder.id);
    const body = deliveryPrompt.replace(/\nCancel this reminder with: .*$/, '');
    const sent = await this.postMessage({ to: reminder.agentId, from: 'companion', body, delivery: reminder.delivery ?? 'on-idle', mode: 'notify', promptKind: 'reminder', actionCommand });
    const runsCompleted = (reminder.runsCompleted ?? 0) + 1;
    await this.store.updateReminder(reminder.id, { deliveryMessageId: sent.id, deliveryStatus: 'pending', prompt: deliveryPrompt, lastFiredAt: firedAt, lastRunAt: firedAt });
    if (reminder.mode === 'repeat' || reminder.everySeconds) {
      const seconds = reminder.everySeconds ?? 0;
      if (reminder.maxRuns !== undefined && runsCompleted >= reminder.maxRuns) await this.store.updateReminder(reminder.id, { status: 'deleted', alive: false, runsCompleted, lastRunAt: new Date(now).toISOString() });
      else if (seconds > 0) await this.store.updateReminder(reminder.id, { nextRunAt: new Date(now + seconds * 1000).toISOString(), runsCompleted });
      else await this.store.updateReminder(reminder.id, { lastRunAt: new Date(now).toISOString() });
    } else {
      await this.store.updateReminder(reminder.id, { status: 'deleted', alive: false, runsCompleted, lastRunAt: new Date(now).toISOString() });
    }
  }

  private async managerIsIdle(managerId: string): Promise<boolean> {
    try {
      const inspected = await this.inspectWithRetry(managerId, managerId);
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
    ].join('\n');
    const recoveryReminderId = deterministicName('companion-recovery', managerId);
    const recoveryReminder = this.store.findReminder(recoveryReminderId);
    if (recoveryReminder?.status === 'deleted') return;
    if (!recoveryReminder) await this.store.addReminder({
      id: recoveryReminderId, agentId: managerId, name: recoveryReminderId, prompt: body, cron: '', expiresIn: '', status: 'active', schedulingKind: 'in-process',
      kind: 'heartbeat-recovery', eventType: 'missed-heartbeat', criterion: 'failed heartbeat runs while manager busy', createdAt: new Date().toISOString(),
    });
    const existing = this.store.getMessages().find((message) => message.status === 'pending' && message.kind === 'heartbeat-recovery' && message.recoveryManagerId === managerId);
    if (existing) {
      // A delivery generation is an immutable snapshot. New observations wait
      // for its success and become the next generation rather than rewriting
      // a prompt that may already be in flight.
      return;
    }
    await this.postMessage({ to: managerId, from: 'companion', body, urgency: 'urgent', promptKind: 'watchdog', actionCommand: this.cancelCommand(recoveryReminderId), kind: 'heartbeat-recovery', recoveryManagerId: managerId, recoveryCounts: counts, recoveryRunIds: runIds });
  }

  async listHeartbeats(includeDead = false): Promise<Array<Record<string, unknown>>> {
    await this.reconcileReminders();
    const now = Date.now();
    const rows = this.store.getReminders().filter((reminder) => reminder.status !== 'deleted' && (includeDead || reminder.status !== 'dead')).map((reminder) => {
      const expired = reminderExpired(reminder, now);
      return ({
      id: reminder.daemonId ?? reminder.id,
      cron: reminder.cron,
      last_fired_at: reminder.lastFiredAt ?? null,
      last_delivered_at: reminder.lastDeliveredAt ?? null,
      missed_fires: reminder.missedFires ?? 0,
      next_run: reminder.nextRunAt ?? null,
      alive: expired || reminder.status === 'dead' ? false : (reminder.alive ?? (reminder.status === 'active')),
      _createdAt: reminder.createdAt,
      });
    });
    const byId = new Map<string, Record<string, unknown>>();
    const rank = (row: Record<string, unknown>): [number, number] => [
      row.alive === true ? 1 : 0,
      Number.isFinite(Date.parse(String(row._createdAt ?? ''))) ? Date.parse(String(row._createdAt)) : -Infinity,
    ];
    for (const row of rows) {
      const prior = byId.get(String(row.id));
      const [alive, created] = rank(row);
      const [priorAlive, priorCreated] = prior ? rank(prior) : [-1, -Infinity];
      if (!prior || alive > priorAlive || (alive === priorAlive && created > priorCreated)) byId.set(String(row.id), row);
    }
    return [...byId.values()].map(({ _createdAt: _ignored, ...row }) => row);
  }

  private resolveHeartbeat(id: string): ReminderRecord | undefined {
    const exact = this.store.getReminders().find((reminder) => reminder.id === id || reminder.daemonId === id);
    if (exact) return exact;
    if (id.length < 8) return undefined;
    const matches = this.store.getReminders().filter((reminder) => reminder.id.startsWith(id) || Boolean(reminder.daemonId?.startsWith(id)));
    if (matches.length > 1) throw new CompanionError('ambiguous_id', 'heartbeat id ambiguous');
    return matches[0];
  }

  async deleteHeartbeat(id: string, reason: string): Promise<unknown> {
    if (!reason?.trim()) missingField('reason');
    const reminder = this.resolveHeartbeat(id);
    if (!reminder) throw new CompanionError('not_found', 'heartbeat not found');
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
      await this.store.updateReminder(id, { status: 'active', alive: true, daemonId: undefined, prompt, cron: '*/5 * * * *', expiresIn: '', schedulingKind: 'in-process' });
      return this.store.findReminder(id)!;
    }
    const record: ReminderRecord = {
      id, agentId: managerId, subjectChildId: childId, kind: 'child-watch', watchKind: 'child',
      name: id, prompt, cron: '*/5 * * * *', expiresIn: '', status: 'active', alive: true, schedulingKind: 'in-process',
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
    if (!managerId?.trim()) missingField('agentId');
    if (!childId?.trim()) missingField('childId');
    if (!reason?.trim()) missingField('reason');
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
    if (!managerId?.trim()) missingField('agentId');
    if (!childId?.trim()) missingField('childId');
    if (this.store.isChildWatchOptOutStateCorrupt()) throw new CompanionError('state_corrupt', 'child-watch opt-out state corrupt');
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
      } catch (error) {
        console.warn(JSON.stringify({ type: 'reconcile-manager-failed', managerId, error: error instanceof Error ? error.message : String(error) }));
      }
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
