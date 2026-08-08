import { mkdir, readFile, appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LedgerRecord, ReminderRecord } from './types.js';

export class Store {
  readonly dir: string;
  private reminders: ReminderRecord[] = [];
  private ledger: LedgerRecord[] = [];
  private managers = new Set<string>();

  constructor(dir = process.env.PASEO_COMPANION_DATA || path.join(process.cwd(), '.paseo-manager-companion')) {
    this.dir = dir;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.reminders = await this.load<ReminderRecord[]>('reminders.json', []);
    this.ledger = await this.load<LedgerRecord[]>('ledger.json', []);
    const managerList = await this.load<string[]>('managers.json', []);
    this.managers = new Set(managerList);
  }

  private async load<T>(file: string, fallback: T): Promise<T> {
    try { return JSON.parse(await readFile(path.join(this.dir, file), 'utf8')) as T; } catch { return fallback; }
  }
  private async save(file: string, value: unknown): Promise<void> {
    await writeFile(path.join(this.dir, file), JSON.stringify(value, null, 2) + '\n');
  }
  async addManager(id: string | undefined): Promise<void> {
    if (!id) return;
    this.managers.add(id);
    await this.save('managers.json', [...this.managers]);
  }
  getManagers(): string[] { return [...this.managers]; }

  getReminders(): ReminderRecord[] { return this.reminders; }
  async addReminder(record: ReminderRecord): Promise<void> { this.reminders.push(record); await this.save('reminders.json', this.reminders); }
  async updateReminder(id: string, patch: Partial<ReminderRecord>): Promise<ReminderRecord | undefined> {
    const item = this.reminders.find((r) => r.id === id || r.daemonId === id);
    if (!item) return undefined;
    Object.assign(item, patch);
    await this.save('reminders.json', this.reminders);
    return item;
  }
  findReminder(id: string): ReminderRecord | undefined { return this.reminders.find((r) => r.id === id || r.daemonId === id); }

  getLedger(): LedgerRecord[] { return this.ledger; }
  async addLedger(input: Omit<LedgerRecord, 'id' | 'createdAt'>): Promise<LedgerRecord> {
    const record: LedgerRecord = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.ledger.push(record);
    await this.save('ledger.json', this.ledger);
    return record;
  }
  async revokeLedger(record: LedgerRecord, reason: string): Promise<void> {
    record.revokedAt = new Date().toISOString();
    record.revokeReason = reason;
    await this.save('ledger.json', this.ledger);
    await appendFile(path.join(this.dir, 'ledger-resolved.jsonl'), JSON.stringify({ ...record, resolutionReason: reason }) + '\n');
  }
}
