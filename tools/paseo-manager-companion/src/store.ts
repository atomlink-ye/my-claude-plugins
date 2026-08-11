import { mkdir, readFile, appendFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LedgerRecord, MessageRecord, MessageScheduleRecord, ReminderRecord } from './types.js';

export class Store {
  readonly dir: string;
  private reminders: ReminderRecord[] = [];
  private ledger: LedgerRecord[] = [];
  private messages: MessageRecord[] = [];
  private messageSchedules: MessageScheduleRecord[] = [];
  private recoveryReceipts: Record<string, Record<string, { missedFires: number; missedRunIds: string[] }>> = {};
  private childWatchOptOuts: Record<string, { reason: string; updatedAt: string }> = {};
  private childWatchOptOutsCorrupt = false;
  private saveLocks = new Map<string, Promise<void>>();
  private managers = new Set<string>();

  constructor(dir = process.env.PASEO_COMPANION_DATA || path.join(process.cwd(), '.paseo-manager-companion')) {
    this.dir = dir;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.reminders = await this.load<ReminderRecord[]>('reminders.json', []);
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
