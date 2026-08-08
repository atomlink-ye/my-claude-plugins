import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PaseoCli, asRecord } from './cli.js';
import { Store } from './store.js';
import type { AgentInfo, ChildrenResult, FailedCandidate, LedgerType, ReminderRecord } from './types.js';

const REMINDER_TTL = '30m';
const REMINDER_MAX_TTL_SECONDS = 2 * 60 * 60;

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
  private lastReconcileAt?: string;
  private port = Number(process.env.PORT || 0);
  private observers = new Set<AbortController>();

  constructor(cli = new PaseoCli(), store = new Store()) { this.cli = cli; this.store = store; }
  async init(): Promise<void> {
    await this.store.init();
    await this.reconcileReminders();
    this.reconcileTimer = setInterval(() => { void this.reconcileOnce(); }, 180_000);
    this.reconcileTimer.unref();
  }
  close(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
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
      if (reminder.agentId === agentId && reminder.status === 'active' && await this.probeReminder(reminder)) selfWakeupSources.push(reminder);
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
    for (const reminder of this.store.getReminders()) if (reminder.agentId === agentId && reminder.status === 'active' && await this.probeReminder(reminder)) return true;
    return false;
  }
  private async probeReminder(reminder: ReminderRecord): Promise<boolean> {
    if (!reminder.daemonId) return false;
    try {
      const value = asRecord((await this.cli.run(['heartbeat', 'update', reminder.daemonId, '--cron', reminder.cron, '--json'], { agentId: reminder.agentId, timeoutMs: 5_000 })).value);
      await this.store.updateReminder(reminder.id, { nextRunAt: value.nextRunAt, lastRunAt: value.lastRunAt, status: 'active' });
      return !['deleted', 'expired', 'completed', 'failed', 'dead'].includes(lowerStatus(value.status));
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

  async createReminder(body: { agentId: string; delaySeconds: number; message: string; context?: object; ackRequired?: boolean }): Promise<ReminderRecord> {
    await this.store.addManager(body.agentId);
    if (!Number.isFinite(body.delaySeconds) || body.delaySeconds <= 0) throw new Error('delaySeconds must be positive');
    const localId = randomUUID();
    const cron = cronForDelay(body.delaySeconds);
    const expiresIn = ttlForDelay(body.delaySeconds);
    const ack = `curl -X DELETE http://127.0.0.1:${this.port || '<port>'}/reminders/${localId} -H 'content-type: application/json' -d '{"reason":"acknowledged"}'`;
    const prompt = [body.message, body.context ? `Structured context: ${json(body.context)}` : 'Structured context: {}', `Acknowledge this reminder with: ${ack}`, body.ackRequired === false ? '' : 'Do not drop this reminder without an explicit acknowledgement.'].filter(Boolean).join('\n');
    const pending: ReminderRecord = { id: localId, agentId: body.agentId, name: `companion-reminder-${localId.slice(0, 8)}`, prompt, cron, expiresIn, status: 'pending', createdAt: new Date().toISOString() };
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
  async reconcileOnce(): Promise<void> {
    this.lastReconcileAt = new Date().toISOString();
    await this.reconcileReminders();
    for (const managerId of this.store.getManagers()) {
      try {
        const { children, selfWakeupSources, partial } = await this.listChildren(managerId);
        if (partial) {
          console.warn(JSON.stringify({ type: 'reconcile-partial-children', managerId, at: new Date().toISOString() }));
          continue;
        }
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
