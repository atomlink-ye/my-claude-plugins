import { DaemonClient } from '@getpaseo/client';
import WebSocket from 'ws';

export interface ScheduleObserver {
  scheduleList(): Promise<unknown>;
  scheduleInspect(id: string): Promise<unknown>;
  scheduleLogs(id: string): Promise<unknown>;
  close?(): Promise<void> | void;
}

export type ScheduleObserverOptions = {
  host?: string;
  clientId?: string;
  /** Injectable client keeps contract tests independent of a live daemon. */
  client?: Pick<DaemonClient, 'connect' | 'close' | 'scheduleList' | 'scheduleInspect' | 'scheduleLogs'>;
  /** Creates a disposable client for each RPC; useful when close() disposes clients. */
  clientFactory?: () => Pick<DaemonClient, 'connect' | 'close' | 'scheduleList' | 'scheduleInspect' | 'scheduleLogs'>;
  webSocketFactory?: (url: string, options?: { headers?: Record<string, string>; protocols?: string[] }) => any;
};

export function normalizePaseoWsHost(value?: string): string {
  const raw = (value ?? '').trim();
  if (!raw) return 'ws://127.0.0.1:6767/ws';
  let url = raw.includes('://') ? raw : `ws://${raw}`;
  if (url.startsWith('tcp://')) url = `ws://${url.slice('tcp://'.length)}`;
  if (url.startsWith('http://')) url = `ws://${url.slice('http://'.length)}`;
  if (url.startsWith('https://')) url = `wss://${url.slice('https://'.length)}`;
  const parsed = new URL(url);
  if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = '/ws';
  return parsed.toString().replace(/\/$/, '');
}

export class PaseoScheduleObserver implements ScheduleObserver {
  private readonly clientFactory: () => Pick<DaemonClient, 'connect' | 'close' | 'scheduleList' | 'scheduleInspect' | 'scheduleLogs'>;
  constructor(options: ScheduleObserverOptions = {}) {
    if (options.clientFactory) this.clientFactory = options.clientFactory;
    else if (options.client) this.clientFactory = () => options.client!;
    else this.clientFactory = () => new DaemonClient({
        url: normalizePaseoWsHost(options.host ?? process.env.PASEO_HOST ?? process.env.PASEO_COMPANION_PASEO_HOST),
        clientId: options.clientId ?? `paseo-reminder-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
        clientType: 'cli',
        webSocketFactory: options.webSocketFactory ?? ((url, wsOptions) => new WebSocket(url, wsOptions as any)),
        reconnect: { enabled: false },
      });
  }
  private async withConnection<T>(operation: (client: Pick<DaemonClient, 'connect' | 'close' | 'scheduleList' | 'scheduleInspect' | 'scheduleLogs'>) => Promise<T>): Promise<T> {
    const client = this.clientFactory();
    await client.connect();
    try { return await operation(client); } finally { await client.close(); }
  }
  async scheduleList(): Promise<unknown> { return this.withConnection((client) => client.scheduleList()); }
  async scheduleInspect(id: string): Promise<unknown> { return this.withConnection((client) => client.scheduleInspect({ id })); }
  async scheduleLogs(id: string): Promise<unknown> { return this.withConnection((client) => client.scheduleLogs({ id })); }
  async close(): Promise<void> { /* per-RPC clients are closed by withConnection */ }
}
