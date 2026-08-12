import { describe, expect, it } from 'vitest';
import { commandIsPaseoWait } from '../../../skills/paseo-companion/paseo-reminder/src/wait-source.js';

describe('paseo manager companion', () => {
  it('exports a server factory', async () => {
    const mod = await import('../../../skills/paseo-companion/paseo-reminder/src/server.js');
    expect(typeof mod.createServer).toBe('function');
  });

  it('adapts direct daemon schedule RPC payloads without CLI presentation', async () => {
    const { PaseoScheduleObserver, normalizePaseoWsHost } = await import('../../../skills/paseo-companion/paseo-reminder/src/schedule-observer.js');
    const calls: unknown[] = [];
    const fake = {
      async connect() { calls.push('connect'); },
      async close() {},
      async scheduleList() { return { payload: { schedules: [{ id: 's1', name: 'heartbeat', status: 'active', target: { type: 'agent', agentId: 'manager-1' } }] } }; },
      async scheduleInspect(options: { id: string }) { calls.push(options); return { payload: { schedule: { id: options.id, status: 'active' } } }; },
      async scheduleLogs() { return { payload: { runs: [{ id: 'r1', startedAt: '2026-08-11T00:00:00Z', scheduledFor: '2026-08-11T00:00:00Z', status: 'failed' }] } }; },
    };
    const observer = new PaseoScheduleObserver({ client: fake as any });
    expect(normalizePaseoWsHost('tcp://127.0.0.1:6767')).toBe('ws://127.0.0.1:6767/ws');
    expect(await observer.scheduleList()).toEqual(expect.objectContaining({ payload: expect.anything() }));
    expect(await observer.scheduleInspect('s1')).toEqual(expect.objectContaining({ payload: expect.anything() }));
    expect(await observer.scheduleLogs('s1')).toEqual(expect.objectContaining({ payload: expect.anything() }));
    expect(calls).toContain('connect');
  });

  it('uses a fresh disposable client for each schedule RPC', async () => {
    const { PaseoScheduleObserver } = await import('../../../skills/paseo-companion/paseo-reminder/src/schedule-observer.js');
    let created = 0;
    const observer = new PaseoScheduleObserver({ clientFactory: () => {
      let disposed = false;
      created++;
      return {
        async connect() {},
        async close() { disposed = true; },
        async scheduleInspect() { if (disposed) throw new Error('disposed client reused'); return { schedule: { id: 's1', status: 'active' } }; },
        async scheduleLogs() { if (disposed) throw new Error('disposed client reused'); return { runs: [] }; },
        async scheduleList() { if (disposed) throw new Error('disposed client reused'); return { schedules: [] }; },
      } as any;
    } });
    await observer.scheduleInspect('s1');
    await observer.scheduleLogs('s1');
    expect(created).toBe(2);
  });

  it('matches real paseo wait argv with a seven-character UUID prefix without shell self-matches', () => {
    const id = '2291059d-c7f2-4c39-b973-e053c436b8a1';
    expect(commandIsPaseoWait('node --disable-warning=DEP0040 /opt/homebrew/bin/paseo wait 2291059 --timeout 900', id)).toBe(true);
    expect(commandIsPaseoWait(`paseo wait ${id.slice(0, 8)} --timeout 1800`, id)).toBe(true);
    expect(commandIsPaseoWait(`paseo wait ${id} --timeout 1800`, id.slice(0, 8))).toBe(true);
    expect(commandIsPaseoWait(`sh -c "paseo wait ${id}"`, id)).toBe(false);
    expect(commandIsPaseoWait(`paseo wait 2291058 --timeout 900`, id)).toBe(false);
    expect(commandIsPaseoWait(`node --disable-warning=DEP0040 /opt/homebrew/bin/paseo wait 2291059d-near-prefix --timeout 900`, id)).toBe(false);
    expect(commandIsPaseoWait(`node --require /opt/homebrew/bin/paseo wait 2291059 --timeout 900`, id)).toBe(false);
    expect(commandIsPaseoWait(`node --disable-warning=DEP0040 /opt/homebrew/bin/paseo wait 2291059 --timeout 900`, id.replace(/^2291059d/, '2291058d'))).toBe(false);
    expect(commandIsPaseoWait(`paseo wait ${id}-near-prefix`, id)).toBe(false);
  });
});
