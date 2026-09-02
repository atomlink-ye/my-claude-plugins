import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArcpStore } from '../../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { createControl } from '../support/create-control.js';
import { FakePaseoCli } from '../support/fake-paseo-cli.js';
import { LANE_C_KNOWLEDGE, OWNER_MEMBER, WORKSPACE, laneCFacts } from '../support/lane-c-channel-fixture.js';

describe('legacy channel projection persistence', () => {
  it('enriches events written before the projection existed without rewriting the journal', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'arcp-legacy-projection-'));
    const legacy = {
      actors: [], bindings: [], credentials: {},
      workspaces: [{ id: WORKSPACE, purpose: 'campaign', lifecycle: 'active', ownerActorId: 'actor_689a470de46a647be6aa', ownerMemberId: OWNER_MEMBER, createdAt: '2026-09-01T13:01:54.413Z', updatedAt: '2026-09-01T13:01:54.413Z' }],
      members: laneCFacts().members, memberCredentials: {}, tasks: [], knowledge: laneCFacts().knowledge, results: [], goals: [], sessions: [], deliveries: [],
      channelEvents: [{ id: 'event_legacy', workspaceId: WORKSPACE, sourceMemberId: OWNER_MEMBER, targetRole: 'manager', kind: 'finding', urgency: 'normal', decisionRequired: false, summary: `evidence knowledge ${LANE_C_KNOWLEDGE}`, evidenceRefs: [], createdAt: '2026-09-01T21:50:05.694Z' }],
      confirmations: [], supervisionPolicies: [], supervisionReviews: [], supervisionSignals: [],
    };
    const file = path.join(dir, 'arcp-state.json');
    await writeFile(file, JSON.stringify(legacy, null, 2) + '\n', { mode: 0o600 });
    const store = new ArcpStore(dir);
    await store.init();
    const { service } = await createControl(dir, { cli: new FakePaseoCli(), store });
    const projected = service.channelEvents(WORKSPACE)[0];
    expect(projected.projection.sender.label).toBe('Hermes Owner Deputy');
    expect(projected.projection.headline).toContain('R2-REV-F17 is closed');
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    expect(persisted.channelEvents).toHaveLength(1);
    expect(persisted.channelEvents[0]).not.toHaveProperty('projection');
    expect(persisted.channelEvents[0].content.summary).toBe(`evidence knowledge ${LANE_C_KNOWLEDGE}`);
    expect(persisted.knowledge[0].text).toBe(laneCFacts().knowledge[0].text);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    service.close();
  });
});
