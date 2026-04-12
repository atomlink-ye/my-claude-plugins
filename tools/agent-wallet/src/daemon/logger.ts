import Database from 'better-sqlite3';

import type { ActivityEvent, ActivityLogEntry } from '../types/index.js';

interface ActivityLogRow {
  id: number | bigint;
  event: ActivityEvent;
  request_id: string | null;
  data: string | null;
  timestamp: number;
}

export class Logger {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY,
        event TEXT NOT NULL,
        request_id TEXT,
        data TEXT,
        timestamp INTEGER NOT NULL
      )
    `);
  }

  log(event: ActivityEvent, requestId?: string, data?: string): ActivityLogEntry {
    const timestamp = Date.now();
    const result = this.db
      .prepare(
        'INSERT INTO activity_log (event, request_id, data, timestamp) VALUES (?, ?, ?, ?)',
      )
      .run(event, requestId ?? null, data ?? null, timestamp);

    return {
      id: Number(result.lastInsertRowid),
      event,
      requestId,
      data,
      timestamp,
    };
  }

  getAll(): ActivityLogEntry[] {
    const rows = this.db
      .prepare('SELECT id, event, request_id, data, timestamp FROM activity_log ORDER BY id ASC')
      .all() as ActivityLogRow[];

    return rows.map((row) => this.mapRow(row));
  }

  getByRequestId(requestId: string): ActivityLogEntry[] {
    const rows = this.db
      .prepare(
        'SELECT id, event, request_id, data, timestamp FROM activity_log WHERE request_id = ? ORDER BY id ASC',
      )
      .all(requestId) as ActivityLogRow[];

    return rows.map((row) => this.mapRow(row));
  }

  close(): void {
    this.db.close();
  }

  private mapRow(row: ActivityLogRow): ActivityLogEntry {
    return {
      id: Number(row.id),
      event: row.event,
      requestId: row.request_id ?? undefined,
      data: row.data ?? undefined,
      timestamp: row.timestamp,
    };
  }
}
