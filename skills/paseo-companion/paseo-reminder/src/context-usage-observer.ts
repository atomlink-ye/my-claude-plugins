import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';
import { normalizePaseoWsHost } from './schedule-observer.js';

export interface ContextUsage {
  usedTokens: number;
  limitTokens: number;
  /** used/limit, 0..1. */
  percent: number;
  observedAt: string;
  source: string;
}

/**
 * Reads a running agent's context-window occupancy. Missing data returns
 * 'unknown' rather than 0 -- 0 is a truthy "not yet at threshold" answer and
 * would make an unobserved agent look safe. Callers must never coerce
 * 'unknown' into a number.
 */
export interface ContextUsageObserver {
  observe(agentId: string): Promise<ContextUsage | 'unknown'>;
  close?(): Promise<void> | void;
}

type FetchAgentsClient = Pick<DaemonClient, 'connect' | 'close' | 'fetchAgents'>;

export type ContextUsageObserverOptions = {
  host?: string;
  clientId?: string;
  /** Injectable client keeps contract tests independent of a live daemon. */
  client?: FetchAgentsClient;
  clientFactory?: () => FetchAgentsClient;
  webSocketFactory?: (url: string, options?: { headers?: Record<string, string>; protocols?: string[] }) => any;
};

export class PaseoContextUsageObserver implements ContextUsageObserver {
  private readonly clientFactory: () => FetchAgentsClient;
  private readonly source = 'paseo-daemon';
  constructor(options: ContextUsageObserverOptions = {}) {
    if (options.clientFactory) this.clientFactory = options.clientFactory;
    else if (options.client) this.clientFactory = () => options.client!;
    else this.clientFactory = () => new DaemonClient({
        url: normalizePaseoWsHost(options.host ?? process.env.PASEO_HOST ?? process.env.PASEO_COMPANION_PASEO_HOST),
        clientId: options.clientId ?? `paseo-reminder-cw-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
        clientType: 'cli',
        webSocketFactory: options.webSocketFactory ?? ((url, wsOptions) => new WebSocket(url, wsOptions as any)),
        reconnect: { enabled: false },
      }) as unknown as FetchAgentsClient;
  }
  async observe(agentId: string): Promise<ContextUsage | 'unknown'> {
    const client = this.clientFactory();
    await client.connect();
    try {
      const result = await client.fetchAgents({});
      const entry = result.entries.find((item: any) => String((item.agent ?? item).id) === agentId);
      // The daemon puts the live context-window occupancy under `lastUsage`
      // (not `usage`, despite AgentUsage being the shared type name in
      // @getpaseo/protocol) -- verified against a real running agent
      // (id 1696e55d) via a live fetchAgents() call before wiring this in.
      const usage = entry ? (entry.agent ?? entry).lastUsage : undefined;
      const used = usage?.contextWindowUsedTokens;
      const limit = usage?.contextWindowMaxTokens;
      if (typeof used !== 'number' || typeof limit !== 'number' || !(limit > 0)) return 'unknown';
      return { usedTokens: used, limitTokens: limit, percent: used / limit, observedAt: new Date().toISOString(), source: this.source };
    } catch {
      return 'unknown';
    } finally {
      await client.close();
    }
  }
  async close(): Promise<void> { /* per-call clients are closed by observe() */ }
}
