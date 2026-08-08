import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ActivityEvent, ActivityLogEntry } from '../types/index.js';

/**
 * Pure-JS activity logger — no native dependencies, so it runs on any modern
 * Node version (no ABI coupling, no node-gyp build step).
 *
 * Entries are held in memory. When `dbPath` points at a real file path
 * (anything other than ':memory:' or empty), each entry is additionally
 * appended as a JSON line for durability. Persistence is best-effort: a write
 * failure never throws and the in-memory log keeps working.
 */
export class Logger {
  private readonly entries: ActivityLogEntry[] = [];
  private nextId = 1;
  private readonly filePath: string | undefined;

  constructor(dbPath?: string) {
    this.filePath = dbPath && dbPath !== ':memory:' ? dbPath : undefined;

    if (this.filePath) {
      try {
        mkdirSync(dirname(this.filePath), { recursive: true });
      } catch {
        // best-effort directory creation; fall back to in-memory only
      }
    }
  }

  log(event: ActivityEvent, requestId?: string, data?: string): ActivityLogEntry {
    const entry: ActivityLogEntry = {
      id: this.nextId++,
      event,
      requestId,
      data,
      timestamp: Date.now(),
    };

    this.entries.push(entry);

    if (this.filePath) {
      try {
        appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`);
      } catch {
        // best-effort persistence; ignore write failures
      }
    }

    return { ...entry };
  }

  getAll(): ActivityLogEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  getByRequestId(requestId: string): ActivityLogEntry[] {
    return this.entries
      .filter((entry) => entry.requestId === requestId)
      .map((entry) => ({ ...entry }));
  }

  close(): void {
    // No external resources to release in the in-memory implementation.
  }
}
