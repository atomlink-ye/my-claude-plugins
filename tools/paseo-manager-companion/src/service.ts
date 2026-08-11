import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PaseoCli, asRecord } from './cli.js';
import { Store } from './store.js';
import type { AgentInfo, ChildrenResult, FailedCandidate, LedgerType, MessageRecord, MessageScheduleRecord, MessageUrgency, ReminderKind, ReminderRecord } from './types.js';

const REMINDER_TTL = '30m';
const REMINDER_MAX_TTL_SECONDS = 2 * 60 * 60;
type MessageScheduleInspection = {
  state: 'live' | 'running' | 'success' | 'failed' | 'missing' | 'unknown';
  hasRun: boolean;
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

export class CompanionService {
  readonly cli: PaseoCli;
  readonly store: Store;
  readonly startedAt = new Date().toISOString();
  private reconcileTimer?: NodeJS.Timeout;
  private messageReconcileTimer?: NodeJS.Timeout;
  private lastReconcileAt?: string;
  private port = Number(process.env.PORT || 0);
  private observers = new Set<AbortController>();
  private childWatchInFlight = new Map<string, Promise<ReminderRecord | undefined>>();
  private messageInFlight = new Map<string, Promise<void>>();

  constructor(cli = new PaseoCli(), store = new Store()) { this.cli = cli; this.store = store; }
  async init(): Promise<void> {
    await this.store.init();
    await this.reconcileReminders();
    await this.reconcileMessages();
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
  }
  setPort(port: number): void { this.port = port; }
  health(): Record<string, unknown> {
    return { status: 'ok', uptimeSeconds: Math.floor((Date.now() - Date.parse(this.startedAt)) / 1000), startedAt: this.startedAt, lastReconcileAt: this.lastReconcileAt ?? null };
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
          const inspected = await this.inspectWithRetry(id);
          const parent = inspected.ParentAgentId ?? inspected.parentAgentId;
          if (String(parent ?? '') !== agentId) continue;
          const status = String(inspected.Status ?? inspected.status ?? c.status ?? 'unknown');
          const childId = String(inspected.Id ?? inspected.id ?? id);
          const child: AgentInfo = {
            id: childId,
            status,
            updatedAt: inspected.UpdatedAt ?? inspected.updatedAt,
            cwd: inspected.Cwd ?? inspected.cwd ?? c.cwd,
            worktree: inspected.Worktree ?? inspected.worktree,
            parked: this.store.getLedger().some((r) => r.type === 'park' && r.target === childId && !r.revokedAt),
            hasLiveWakeupSource: await this.hasLiveWakeup(childId),
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
      if (!childWatch && reminder.agentId === agentId && reminder.status === 'active' && await this.probeReminder(reminder)) selfWakeupSources.push(reminder);
    }
    return { children, selfWakeupSources, partial: failedCandidates.length > 0, failedCandidates };
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

  private async hasLiveWakeup(agentId: string): Promise<boolean> {
    for (const reminder of this.store.getReminders()) {
      // Child watches are delivered to their manager, so subjectChildId is the
      // wakeup identity for this query while agentId remains the delivery identity.
      const matches = reminder.agentId === agentId || reminder.subjectChildId === agentId;
      if (matches && reminder.status === 'active' && await this.probeReminder(reminder)) return true;
    }
    return false;
  }
  private async probeReminder(reminder: ReminderRecord): Promise<boolean> {
    if (!reminder.daemonId) return false;
    try {
      const value = asRecord((await this.cli.run(['heartbeat', 'update', reminder.daemonId, '--cron', reminder.cron, '--json'], { agentId: reminder.agentId, timeoutMs: 5_000 })).value);
      const live = !['deleted', 'expired', 'completed', 'failed', 'dead'].includes(lowerStatus(value.status));
      await this.store.updateReminder(reminder.id, { nextRunAt: value.nextRunAt, lastRunAt: value.lastRunAt, status: live ? 'active' : 'dead' });
      return live;
    } catch {
      await this.store.updateReminder(reminder.id, { status: 'dead' });
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

  async createReminder(body: { agentId: string; delaySeconds: number; message: string; context?: object; ackRequired?: boolean; subjectChildId?: string; kind?: ReminderKind; watchKind?: 'child' }): Promise<ReminderRecord> {
    await this.store.addManager(body.agentId);
    if (!Number.isFinite(body.delaySeconds) || body.delaySeconds <= 0) throw new Error('delaySeconds must be positive');
    const localId = randomUUID();
    const cron = cronForDelay(body.delaySeconds);
    const expiresIn = ttlForDelay(body.delaySeconds);
    const ack = `curl -X DELETE http://127.0.0.1:${this.port || '<port>'}/reminders/${localId} -H 'content-type: application/json' -d '{"reason":"acknowledged"}'`;
    const prompt = [body.message, body.context ? `Structured context: ${json(body.context)}` : 'Structured context: {}', `Acknowledge this reminder with: ${ack}`, body.ackRequired === false ? '' : 'Do not drop this reminder without an explicit acknowledgement.'].filter(Boolean).join('\n');
    const pending: ReminderRecord = {
      id: localId,
      agentId: body.agentId,
      name: `companion-reminder-${localId.slice(0, 8)}`,
      prompt,
      cron,
      expiresIn,
      status: 'pending',
      createdAt: new Date().toISOString(),
      ...(body.subjectChildId ? { subjectChildId: body.subjectChildId } : {}),
      ...(body.kind ? { kind: body.kind } : {}),
      ...(body.watchKind ? { watchKind: body.watchKind } : {}),
    };
    await this.store.addReminder(pending);
    try {
      const value = asRecord((await this.cli.run(['heartbeat', 'create', prompt, '--cron', cron, '--expires-in', expiresIn, '--name', pending.name, '--timezone', 'UTC', '--json'], { agentId: body.agentId })).value);
      await this.store.updateReminder(localId, { daemonId: String(value.id ?? value.heartbeatId ?? ''), status: 'active', nextRunAt: value.nextRunAt, lastRunAt: value.lastRunAt });
      return this.store.findReminder(localId)!;
    } catch (error) {
      await this.store.updateReminder(localId, { status: 'dead' });
      throw error;
    }
  }

  async deleteReminder(id: string, reason: string): Promise<unknown> {
    const reminder = this.store.findReminder(id);
    if (!reminder) throw new Error('reminder not found');
    if (!reminder.daemonId) { await this.store.updateReminder(reminder.id, { status: 'deleted' }); return { id: reminder.id, status: 'deleted' }; }
    const result = await this.cli.run(['heartbeat', 'delete', reminder.daemonId, '--json'], { agentId: reminder.agentId });
    await this.store.updateReminder(reminder.id, { status: 'deleted' });
    await this.store.addLedger({ type: 'deferred', target: reminder.agentId, verdict: 'reminder-deleted', reason });
    return result.value;
  }

  /**
   * Persist a message before touching Paseo, then make the recipient's queue
   * have one coalesced, one-shot delivery schedule. The queue remains durable
   * if the daemon is unavailable or a recipient is busy.
   */
  async postMessage(body: { to: string; from: string; body: string; urgency?: MessageUrgency }): Promise<MessageRecord & { schedule: MessageScheduleRecord | null }> {
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
    };
    // This write deliberately precedes every daemon call.
    await this.store.addMessage(message);
    await this.ensureMessageDelivery(message.to);
    const schedule = this.store.getMessageSchedules().find((item) => item.recipient === message.to && item.status === 'active') ?? null;
    return { ...message, schedule };
  }

  getMessages(to?: string): MessageRecord[] {
    return this.store.getMessages().filter((message) => !to || message.to === to);
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
    const lines = [
      `Deliver the queued messages below to ${recipient}. Do not send a response through the companion; process each message exactly once.`,
    ];
    for (const [sender, senderMessages] of grouped) {
      lines.push(`From: ${sender}`);
      for (const message of senderMessages) lines.push(`- [${message.createdAt}] (${message.urgency}) ${message.body}`);
    }
    return lines.join('\n');
  }

  private async inspectMessageSchedule(schedule: MessageScheduleRecord): Promise<MessageScheduleInspection> {
    if (!schedule.daemonId) return { state: 'missing', hasRun: false };
    try {
      const inspected = asRecord((await this.cli.run(['schedule', 'inspect', schedule.daemonId, '--json'], { agentId: schedule.recipient, timeoutMs: 5_000 })).value);
      if (!Object.keys(inspected).length) return { state: 'unknown', hasRun: false };
      const logsValue = (await this.cli.run(['schedule', 'logs', schedule.daemonId, '--json'], { agentId: schedule.recipient, timeoutMs: 5_000 })).value;
      const logsRecord = asRecord(logsValue);
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

  private async retireMessageSchedule(schedule: MessageScheduleRecord, status: MessageScheduleRecord['status'] = 'deleted'): Promise<boolean> {
    let removed = true;
    if (schedule.daemonId) {
      try { await this.cli.run(['schedule', 'delete', schedule.daemonId, '--json'], { agentId: schedule.recipient, timeoutMs: 5_000 }); } catch { removed = false; }
    }
    // Terminal schedules are no longer live even if the daemon's delete call
    // is unavailable. An active duplicate stays active locally until deletion
    // succeeds, preventing a replacement from creating another live delivery.
    if (removed || status !== 'deleted') await this.store.updateMessageSchedule(schedule.id, { status });
    return removed;
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
      createdAt: new Date().toISOString(),
    };
    await this.store.addMessageSchedule(local);
    try {
      const value = asRecord((await this.cli.run([
        'heartbeat', 'create', local.prompt,
        '--cron', '* * * * *', '--expires-in', '30m', '--max-runs', '1',
        '--name', `companion-message-${generation.slice(0, 8)}`,
        '--timezone', 'UTC', '--json',
      ], { agentId: recipient })).value);
      await this.store.updateMessageSchedule(local.id, {
        daemonId: String(value.id ?? value.scheduleId ?? value.heartbeatId ?? ''),
        status: 'active',
        lastRunAt: value.lastRunAt,
      });
      return this.store.getMessageSchedules().find((item) => item.id === local.id);
    } catch {
      await this.store.updateMessageSchedule(local.id, { status: 'failed' });
      return undefined;
    }
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
    const schedules = this.store.getMessageSchedules().filter((schedule) => schedule.recipient === recipient && ['pending', 'active', 'running'].includes(schedule.status));
    const liveCandidates: Array<{ schedule: MessageScheduleRecord; inspection: MessageScheduleInspection }> = [];
    let running: MessageScheduleRecord | undefined;
    let uncertain = false;
    for (const schedule of schedules) {
      const state = await this.inspectMessageSchedule(schedule);
      if (state.state === 'success') {
        // Only this generation's captured ids are removed. New arrivals stay.
        await this.store.removeMessages(schedule.batchIds);
        await this.retireMessageSchedule(schedule, 'completed');
      } else if (state.state === 'running') {
        await this.store.updateMessageSchedule(schedule.id, { status: 'running' });
        running = running ?? schedule;
      } else if (state.state === 'live') {
        liveCandidates.push({ schedule, inspection: state });
      } else if (state.state === 'unknown') {
        uncertain = true;
      } else if (state.state === 'missing') {
        await this.store.updateMessageSchedule(schedule.id, { status: 'deleted' });
      } else {
        await this.retireMessageSchedule(schedule);
      }
    }
    const live = liveCandidates.sort((a, b) => a.schedule.createdAt.localeCompare(b.schedule.createdAt)).at(-1);
    for (const candidate of liveCandidates) {
      if (candidate === live) continue;
      const removed = await this.retireMessageSchedule(candidate.schedule);
      if (!removed) uncertain = true;
    }
    const queued = this.store.getMessages().filter((message) => message.to === recipient && message.status === 'pending');
    if (!queued.length || running || uncertain) return;
    const sorted = this.sortMessages(queued);
    // Never replace a live generation merely because new arrivals exist. The
    // captured batch must get its turn; remainder messages are armed after the
    // terminal run is observed.
    if (live) {
      // Before the first real run, expand the existing schedule in place. This
      // avoids a second live wakeup while still folding in staggered arrivals.
      if (!live.inspection.hasRun && (live.schedule.batchIds.length !== sorted.length || live.schedule.batchIds.some((id, index) => id !== sorted[index]?.id))) {
        const prompt = this.messagePrompt(recipient, sorted);
        try {
          await this.cli.run(['schedule', 'update', live.schedule.daemonId!, '--prompt', prompt, '--json'], { agentId: recipient, timeoutMs: 5_000 });
          await this.store.updateMessageSchedule(live.schedule.id, { prompt, batchIds: sorted.map((message) => message.id) });
        } catch {
          // Preserve the old generation and durable arrivals; reconcile later.
        }
      }
      return;
    }
    await this.createMessageSchedule(recipient, sorted);
    // A write can complete while heartbeat create is in flight. Rebuild once
    // against the newer queue, retaining every message in durable storage.
  }

  private async reconcileMessages(): Promise<void> {
    const recipients = new Set(this.store.getMessages().filter((message) => message.status === 'pending').map((message) => message.to));
    for (const schedule of this.store.getMessageSchedules()) if (['pending', 'active', 'running'].includes(schedule.status)) recipients.add(schedule.recipient);
    for (const recipient of recipients) {
      try { await this.ensureMessageDelivery(recipient); } catch { /* retry next reconciliation */ }
    }
  }

  async compactWake(body: { agentId: string; resumeSteps: string }): Promise<unknown> {
    await this.store.addManager(body.agentId);
    const cron = '*/5 * * * *';
    const prompt = `${body.resumeSteps}\nThis is a compact recovery reminder; resume all listed steps.\nHealth check: curl -sf http://127.0.0.1:${this.port || '<port>'}/health || echo "COMPANION DOWN"`;
    const localId = randomUUID();
    const name = `compact-wake-${randomUUID().slice(0, 8)}`;
    const pending: ReminderRecord = { id: localId, agentId: body.agentId, name, prompt, cron, expiresIn: '30m', status: 'pending', createdAt: new Date().toISOString() };
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
            await this.cli.run(['send', agentId, resumeSteps], { signal });
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
    if (record.type === 'park') { try { await this.cli.run(['agent', 'update', record.target, '--label', 'parked=false', '--json']); } catch { /* best effort */ } }
    return { ...record, status: 'revoked' };
  }

  async reconcileReminders(): Promise<void> {
    for (const reminder of this.store.getReminders()) {
      if (reminder.status !== 'pending' && reminder.status !== 'active') continue;
      if (reminder.daemonId) await this.probeReminder(reminder);
      else if (reminder.status === 'pending') await this.store.updateReminder(reminder.id, { status: 'dead' });
    }
  }

  private isChildWatch(reminder: ReminderRecord, managerId: string, childId: string): boolean {
    return reminder.agentId === managerId && reminder.subjectChildId === childId && (reminder.kind === 'child-watch' || reminder.watchKind === 'child');
  }

  private async retireChildWatch(reminder: ReminderRecord): Promise<void> {
    if (reminder.daemonId) {
      try { await this.cli.run(['heartbeat', 'delete', reminder.daemonId, '--json'], { agentId: reminder.agentId }); } catch { /* best effort; local state still prevents a storm */ }
    }
    await this.store.updateReminder(reminder.id, { status: 'deleted' });
  }

  private async ensureChildWatch(managerId: string, childId: string, parked: boolean): Promise<ReminderRecord | undefined> {
    const key = `${managerId}\0${childId}`;
    const existing = this.childWatchInFlight.get(key);
    if (existing) return existing;
    const operation = this.ensureChildWatchOnce(managerId, childId, parked);
    this.childWatchInFlight.set(key, operation);
    try { return await operation; } finally { this.childWatchInFlight.delete(key); }
  }

  private async ensureChildWatchOnce(managerId: string, childId: string, parked: boolean): Promise<ReminderRecord | undefined> {
    const records = this.store.getReminders().filter((reminder) => this.isChildWatch(reminder, managerId, childId));
    if (parked) {
      for (const reminder of records) if (reminder.status === 'pending' || reminder.status === 'active') await this.retireChildWatch(reminder);
      return undefined;
    }
    let live: ReminderRecord | undefined;
    for (const reminder of records) {
      if (reminder.status !== 'pending' && reminder.status !== 'active') continue;
      if (reminder.status === 'active' && await this.probeReminder(reminder)) {
        if (!live) live = reminder;
        else await this.retireChildWatch(reminder);
      } else if (reminder.status === 'pending') {
        // A pending record without a daemon cannot be a live watch after a
        // restart; mark it dead and replace it below.
        await this.store.updateReminder(reminder.id, { status: 'dead' });
      }
    }
    if (live) return live;
    return this.createReminder({
      agentId: managerId,
      subjectChildId: childId,
      kind: 'child-watch',
      watchKind: 'child',
      delaySeconds: 300,
      message: `Per-child watch: inspect ${childId} when this reminder fires. Use paseo inspect ${childId} --json, check its current status and worktree, then continue the manager plan. This reminder is intentionally state-independent.`,
      context: { subjectChildId: childId, watchKind: 'child' },
      ackRequired: true,
    });
  }

  async reconcileOnce(): Promise<void> {
    this.lastReconcileAt = new Date().toISOString();
    await this.reconcileReminders();
    await this.reconcileMessages();
    for (const managerId of this.store.getManagers()) {
      try {
        const { children, selfWakeupSources, partial } = await this.listChildren(managerId);
        if (partial) {
          console.warn(JSON.stringify({ type: 'reconcile-partial-children', managerId, at: new Date().toISOString() }));
          continue;
        }
        for (const child of children) await this.ensureChildWatch(managerId, child.id, child.parked);
        if (children.length && children.every((c) => ['idle', 'archived', 'done', 'completed', 'error'].includes(lowerStatus(c.status))) && selfWakeupSources.length === 0) {
          await this.store.addLedger({ type: 'known-red', target: managerId, verdict: 'wakeup-source-missing', reason: '对账循环检测到子agent全部结束但没有活着的唤醒源' });
          await this.createReminder({ agentId: managerId, delaySeconds: 300, message: '巡检：所有子 agent 已结束，但没有活着的唤醒源；请查看 briefing 和台账。', context: { managerId }, ackRequired: true });
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
