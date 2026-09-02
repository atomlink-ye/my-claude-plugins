import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { renderChannelMarkdown } from '../../../../skills/agent-runtime-control-panel/runtime/src/channel-markdown.js';
import { projectChannelEvent } from '../../../../skills/agent-runtime-control-panel/runtime/src/channel-projection.js';

const LANE_C_KNOWLEDGE = 'knowledge_308365c2-c1e4-46e5-a2e3-7ff89db32d9b';

describe('campaign-state canary: channel Markdown', () => {
  it('renders the real campaign Lane C event as bounded Markdown', async () => {
    const file = process.env.ARCP_CAMPAIGN_STATE;
    expect(file, 'ARCP_CAMPAIGN_STATE is required for a campaign-state canary').toBeTruthy();
    const live = JSON.parse(await readFile(file!, 'utf8'));
    const target = live.channelEvents.find((item: any) => JSON.stringify(item).includes(LANE_C_KNOWLEDGE.slice(0, 20)));
    expect(target, 'the live state file must still contain the named acceptance event').toBeDefined();
    const card = renderChannelMarkdown(projectChannelEvent(target, { members: live.members, tasks: live.tasks, goals: live.goals, knowledge: live.knowledge, results: live.results }), {});
    expect(card).toMatch(/^### Finding · Round-3 Lane C$/m);
    expect(card).toContain('**From:** Hermes Owner Deputy `owner`');
    expect(card).toContain('R2-REV-F17 is closed');
    expect(card).toMatch(/Only accept completes the Task; a refuse .*stays open/);
    expect(card).toContain(`- Knowledge: \`${LANE_C_KNOWLEDGE}\``);
    expect(card).toContain('- Commit: `2acda1f`');
    if (process.env.ARCP_PRINT_CARD === '1') process.stdout.write(`\n${card}\n\n`);
  });
});
