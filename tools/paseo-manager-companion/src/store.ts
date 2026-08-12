import { mkdir, readFile, appendFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IdleReminderRecord, LedgerRecord, MessageRecord, MessageScheduleRecord, ReminderRecord, TrackedChildRecord, TrackedChildSource, WakeupSourceRecord, WatchdogSnapshot } from './types.js';

export class Store {
  readonly dir: string;
  private reminders: ReminderRecord[] = [];
  private idleReminders: IdleReminderRecord[] = [];
  private watchdogSnapshots: Record<string, WatchdogSnapshot> = {};
  private ledger: LedgerRecord[] = [];
  private messages: MessageRecord[] = [];
  private messageSchedules: MessageScheduleRecord[] = [];
  private recoveryReceipts: Record<string, Record<string, { missedFires: number; missedRunIds: string[] }>> = {};
  private childWatchOptOuts: Record<string, { reason: string; updatedAt: string }> = {};
  private trackedChildren: Record<string, TrackedChildRecord> = {};
  private wakeupSources: Record<string, WakeupSourceRecord> = {};
  private childWatchOptOutsCorrupt = false;
  private saveLocks = new Map<string, Promise<void>>();
  private managers = new Set<string>();

  constructor(dir = process.env.PASEO_COMPANION_DATA || path.join(process.cwd(), '.paseo-manager-companion')) {
    this.dir = dir;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.reminders = await this.load<ReminderRecord[]>('reminders.json', []);
    this.idleReminders = await this.loadDurable<IdleReminderRecord[]>('idle-reminders.json', []);
    this.watchdogSnapshots = await this.loadDurable<Record<string, WatchdogSnapshot>>('watchdog-snapshots.json', {});
    this.ledger = await this.load<LedgerRecord[]>('ledger.json', []);
    this.messages = await this.loadDurable<MessageRecord[]>('messages.json', []);
    this.messageSchedules = await this.loadDurable<MessageScheduleRecord[]>('message-schedules.json', []);
    const receipts = await this.loadDurable<Record<string, any> | string[]>('recovery-receipts.json', {});
    this.recoveryReceipts = Array.isArray(receipts) ? Object.fromEntries(receipts.map((id) => [id, {}])) : receipts as any;
    const managerList = await this.load<string[]>('managers.json', []);
    this.managers = new Set(managerList);
    try {
      const optOuts = await this.loadDurable<Record<string, { reason?: string; updatedAt?: string }>>('child-watch-opt-outs.json', {});
      if (!optOuts || Array.isArray(optOuts) || typeof optOuts !== 'object') throw new Error('invalid opt-outs');
      this.childWatchOptOuts = Object.fromEntries(Object.entries(optOuts).map(([key, value]) => [key, {
        reason: String(value?.reason ?? 'unspecified'), updatedAt: String(value?.updatedAt ?? new Date(0).toISOString()),
      }]));
    } catch {
      // Fail closed: a malformed intent file must never cause a watch to be
      // silently recreated.  Keep the service available for explicit recovery.
      this.childWatchOptOutsCorrupt = true;
      this.childWatchOptOuts = {};
    }
    const tracked = await this.loadDurable<Record<string, TrackedChildRecord>>('tracked-children.json', {});
    if (tracked && typeof tracked === 'object' && !Array.isArray(tracked)) this.trackedChildren = tracked;
    const wakeupSources = await this.loadDurable<Record<string, WakeupSourceRecord>>('wakeup-sources.json', {});
    if (wakeupSources && typeof wakeupSources === 'object' && !Array.isArray(wakeupSources)) this.wakeupSources = wakeupSources;
    // Preserve upgrade state: any currently live/pending child-watch pair is
    // considered tracked, but does not clear an explicit opt-out.
    let migrated = false;
    for (const reminder of this.reminders) {
      if (!reminder.subjectChildId || (reminder.kind !== 'child-watch' && reminder.watchKind !== 'child')) continue;
      if (reminder.status !== 'active' && reminder.status !== 'pending') continue;
      const key = this.childWatchKey(reminder.agentId, reminder.subjectChildId);
      if (this.childWatchOptOuts[key] || this.trackedChildren[key]) continue;
      this.trackedChildren[key] = { managerId: reminder.agentId, childId: reminder.subjectChildId, source: 'migrated', addedAt: new Date().toISOString() };
      migrated = true;
    }
    if (migrated) await this.save('tracked-children.json', this.trackedChildren);
    await this.pruneMessageSchedules();
  }

  private async load<T>(file: string, fallback: T): Promise<T> {
    try { return JSON.parse(await readFile(path.join(this.dir, file), 'utf8')) as T; } catch { return fallback; }
  }
  private async save(file: string, value: unknown): Promise<void> {
    const previous = this.saveLocks.get(file) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      const temporary = path.join(this.dir, `.${file}.${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
      await rename(temporary, path.join(this.dir, file));
    });
    this.saveLocks.set(file, write);
    await write;
  }
  private async loadDurable<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(path.join(this.dir, file), 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw new Error(`corrupt durable companion state: ${file}`);
    }
  }
  async addManager(id: string | undefined): Promise<void> {
    if (!id) return;
    this.managers.add(id);
    await this.save('managers.json', [...this.managers]);
  }
  getManagers(): string[] { return [...this.managers]; }

  private childWatchKey(managerId: string, childId: string): string { return `${managerId}\0${childId}`; }
  isChildWatchOptedOut(managerId: string, childId: string): boolean {
    return this.childWatchOptOutsCorrupt || Boolean(this.childWatchOptOuts[this.childWatchKey(managerId, childId)]);
  }
  getChildWatchOptOuts(): Record<string, { reason: string; updatedAt: string }> { return { ...this.childWatchOptOuts }; }
  isChildWatchOptOutStateCorrupt(): boolean { return this.childWatchOptOutsCorrupt; }
  async optOutChildWatch(managerId: string, childId: string, reason: string): Promise<void> {
    if (this.childWatchOptOutsCorrupt) throw new Error('child-watch opt-out state corrupt');
    this.childWatchOptOuts[this.childWatchKey(managerId, childId)] = { reason, updatedAt: new Date().toISOString() };
    await this.save('child-watch-opt-outs.json', this.childWatchOptOuts);
  }
  async optInChildWatch(managerId: string, childId: string): Promise<void> {
    if (this.childWatchOptOutsCorrupt) throw new Error('child-watch opt-out state corrupt');
    delete this.childWatchOptOuts[this.childWatchKey(managerId, childId)];
    await this.save('child-watch-opt-outs.json', this.childWatchOptOuts);
  }

  getTrackedChildren(managerId?: string): TrackedChildRecord[] {
    return Object.values(this.trackedChildren).filter((item) => !managerId || item.managerId === managerId);
  }
  isTrackedChild(managerId: string, childId: string): boolean {
    return Boolean(this.trackedChildren[this.childWatchKey(managerId, childId)]);
  }
  async trackChild(managerId: string, childId: string, source: TrackedChildSource): Promise<TrackedChildRecord> {
    if (this.childWatchOptOutsCorrupt) throw new Error('child-watch opt-out state corrupt');
    delete this.childWatchOptOuts[this.childWatchKey(managerId, childId)];
    const key = this.childWatchKey(managerId, childId);
    const prior = this.trackedChildren[key];
    const record = prior ?? { managerId, childId, source, addedAt: new Date().toISOString() };
    if (!prior || source === 'explicit') record.source = source;
    this.trackedChildren[key] = record;
    await this.save('tracked-children.json', this.trackedChildren);
    await this.save('child-watch-opt-outs.json', this.childWatchOptOuts);
    return record;
  }
  async untrackChild(managerId: string, childId: string, reason: string): Promise<void> {
    if (this.childWatchOptOutsCorrupt) throw new Error('child-watch opt-out state corrupt');
    delete this.trackedChildren[this.childWatchKey(managerId, childId)];
    await this.save('tracked-children.json', this.trackedChildren);
    await this.optOutChildWatch(managerId, childId, reason);
  }

  getWakeupSources(agentId?: string): WakeupSourceRecord[] {
    return Object.values(this.wakeupSources).filter((item) => !agentId || item.agentId === agentId);
  }
  getWakeupSource(heartbeatId: string): WakeupSourceRecord | undefined { return this.wakeupSources[heartbeatId]; }
  async upsertWakeupSource(record: WakeupSourceRecord): Promise<WakeupSourceRecord> {
    const prior = this.wakeupSources[record.heartbeatId];
    this.wakeupSources[record.heartbeatId] = prior ? { ...prior, ...record, registeredAt: prior.registeredAt } : record;
    await this.save('wakeup-sources.json', this.wakeupSources);
    return this.wakeupSources[record.heartbeatId];
  }
  async removeWakeupSource(heartbeatId: string): Promise<boolean> {
    if (!this.wakeupSources[heartbeatId]) return false;
    delete this.wakeupSources[heartbeatId];
    await this.save('wakeup-sources.json', this.wakeupSources);
    return true;
  }

  getReminders(): ReminderRecord[] { return this.reminders; }
  async addReminder(record: ReminderRecord): Promise<void> { this.reminders.push(record); await this.save('reminders.json', this.reminders); }
  async updateReminder(id: string, patch: Partial<ReminderRecord>): Promise<ReminderRecord | undefined> {
    const item = this.reminders.find((r) => r.id === id || r.daemonId === id);
    if (!item) return undefined;
    Object.assign(item, patch);
    await this.save('reminders.json', this.reminders);
    return item;
  }
  async clearReminderMissed(id: string): Promise<ReminderRecord | undefined> {
    return this.updateReminder(id, { missedFires: 0, missedRunIds: [] });
  }
  findReminder(id: string): ReminderRecord | undefined { return this.reminders.find((r) => r.id === id || r.daemonId === id); }

  getIdleReminders(): IdleReminderRecord[] { return this.idleReminders; }
  async addIdleReminder(record: IdleReminderRecord): Promise<void> {
    this.idleReminders.push(record);
    await this.save('idle-reminders.json', this.idleReminders);
  }
  async updateIdleReminder(id: string, patch: Partial<IdleReminderRecord>): Promise<IdleReminderRecord | undefined> {
    const item = this.idleReminders.find((record) => record.id === id);
    if (!item) return undefined;
    Object.assign(item, patch);
    await this.save('idle-reminders.json', this.idleReminders);
    return item;
  }
  findIdleReminder(id: string): IdleReminderRecord | undefined { return this.idleReminders.find((record) => record.id === id); }

  getWatchdogSnapshot(managerId: string, childId: string): WatchdogSnapshot | undefined {
    return this.watchdogSnapshots[`${managerId}\0${childId}`];
  }
  async setWatchdogSnapshot(snapshot: WatchdogSnapshot): Promise<void> {
    this.watchdogSnapshots[`${snapshot.managerId}\0${snapshot.childId}`] = snapshot;
    await this.save('watchdog-snapshots.json', this.watchdogSnapshots);
  }
  async removeWatchdogSnapshot(managerId: string, childId: string): Promise<void> {
    delete this.watchdogSnapshots[`${managerId}\0${childId}`];
    await this.save('watchdog-snapshots.json', this.watchdogSnapshots);
  }

  getMessages(): MessageRecord[] { return this.messages; }
  async addMessage(record: MessageRecord): Promise<void> { this.messages.push(record); await this.save('messages.json', this.messages); }
  async updateMessage(id: string, patch: Partial<MessageRecord>): Promise<MessageRecord | undefined> {
    const item = this.messages.find((message) => message.id === id);
    if (!item) return undefined;
    Object.assign(item, patch);
    await this.save('messages.json', this.messages);
    return item;
  }
  async removeMessages(ids: Iterable<string>): Promise<void> {
    const remove = new Set(ids);
    this.messages = this.messages.filter((message) => !remove.has(message.id));
    await this.save('messages.json', this.messages);
  }
  async addRecoveryReceipt(id: string, targets: Record<string, { missedFires: number; missedRunIds: string[] }>): Promise<void> {
    if (this.recoveryReceipts[id]) return;
    this.recoveryReceipts[id] = targets;
    await this.save('recovery-receipts.json', this.recoveryReceipts);
  }
  getRecoveryReceipt(id: string): Record<string, { missedFires: number; missedRunIds: string[] }> | undefined { return this.recoveryReceipts[id]; }
  async applyRecoveryReceipt(id: string, covered: Record<string, { missedFires: number; missedRunIds: string[] }>): Promise<void> {
    if (this.recoveryReceipts[id]) return;
    const remaining: Record<string, { missedFires: number; missedRunIds: string[] }> = {};
    for (const [reminderId, target] of Object.entries(covered)) {
      const reminder = this.reminders.find((item) => item.id === reminderId);
      if (!reminder) { remaining[reminderId] = { missedFires: 0, missedRunIds: [] }; continue; }
      const coveredIds = new Set(target.missedRunIds);
      const currentIds = reminder.missedRunIds ?? [];
      const currentRemaining = currentIds.filter((runId) => !coveredIds.has(runId));
      const missedFires = currentIds.length || coveredIds.size
        ? currentRemaining.length
        : Math.max(0, (reminder.missedFires ?? 0) - target.missedFires);
      reminder.missedRunIds = currentRemaining;
      reminder.missedFires = missedFires;
      remaining[reminderId] = { missedFires, missedRunIds: currentRemaining };
    }
    this.recoveryReceipts[id] = remaining;
    await this.save('reminders.json', this.reminders);
    await this.save('recovery-receipts.json', this.recoveryReceipts);
  }

  getMessageSchedules(): MessageScheduleRecord[] { return this.messageSchedules; }
  async addMessageSchedule(record: MessageScheduleRecord): Promise<void> {
    this.messageSchedules.push(record);
    await this.save('message-schedules.json', this.messageSchedules);
  }
  async updateMessageSchedule(id: string, patch: Partial<MessageScheduleRecord>): Promise<MessageScheduleRecord | undefined> {
    const item = this.messageSchedules.find((schedule) => schedule.id === id);
    if (!item) return undefined;
    Object.assign(item, patch);
    await this.save('message-schedules.json', this.messageSchedules);
    return item;
  }
  async pruneMessageSchedules(maxTerminal = 50): Promise<void> {
    const live = new Set<MessageScheduleRecord['status']>(['pending', 'active', 'running']);
    const terminal = this.messageSchedules
      .filter((schedule) => !live.has(schedule.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const keep = new Set(terminal.slice(0, maxTerminal).map((schedule) => schedule.id));
    const next = this.messageSchedules.filter((schedule) => live.has(schedule.status) || keep.has(schedule.id));
    if (next.length === this.messageSchedules.length) return;
    this.messageSchedules = next;
    await this.save('message-schedules.json', this.messageSchedules);
  }

  getLedger(): LedgerRecord[] { return this.ledger; }
  async addLedger(input: Omit<LedgerRecord, 'id' | 'createdAt'>): Promise<LedgerRecord> {
    const record: LedgerRecord = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.ledger.push(record);
    await this.save('ledger.json', this.ledger);
    return record;
  }
  async revokeLedger(record: LedgerRecord, reason: string): Promise<void> {
    if (record.revokedAt) return;
    record.revokedAt = new Date().toISOString();
    record.revokeReason = reason;
    await this.save('ledger.json', this.ledger);
    await appendFile(path.join(this.dir, 'ledger-resolved.jsonl'), JSON.stringify({ ...record, resolutionReason: reason }) + '\n');
  }
}
