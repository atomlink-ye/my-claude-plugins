import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { projectChannelEvent, renderChannelCard } from '../../../../skills/agent-runtime-control-panel/runtime/src/channel-projection.js';

const LANE_C_KNOWLEDGE = 'knowledge_308365c2-c1e4-46e5-a2e3-7ff89db32d9b';

describe('campaign-state canary: channel projection', () => {
  it('renders the real campaign event referencing the Lane C evidence', async () => {
    const file = process.env.ARCP_CAMPAIGN_STATE;
    expect(file, 'ARCP_CAMPAIGN_STATE is required for a campaign-state canary').toBeTruthy();
    const live = JSON.parse(await readFile(file!, 'utf8'));
    const facts = { members: live.members, tasks: live.tasks, goals: live.goals, knowledge: live.knowledge, results: live.results };
    const event = live.channelEvents.find((item: any) => JSON.stringify(item).includes(LANE_C_KNOWLEDGE.slice(0, 20)));
    expect(event, 'the live state file must still contain the named acceptance event').toBeDefined();
    const card = renderChannelCard(projectChannelEvent(event, facts));
    expect(card).toContain('From: Hermes Owner Deputy · owner');
    expect(card).toContain('Round-3 Lane C');
    expect(card).toContain('R2-REV-F17 is closed');
    expect(card).toMatch(/Only accept completes the Task; a refuse .*stays open/);
  });
});
