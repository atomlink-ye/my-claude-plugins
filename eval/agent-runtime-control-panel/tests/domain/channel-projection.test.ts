import { describe, expect, it } from 'vitest';
import { HEADLINE_MAX, SUBJECT_MAX, SUMMARY_LINE_MAX, projectChannelEvent, renderChannelCard } from '../../../../skills/agent-runtime-control-panel/runtime/src/channel-projection.js';
import type { ChannelEvent } from '../../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { LANE_C_KNOWLEDGE, WORKSPACE, laneCEvent, laneCFacts } from '../support/lane-c-channel-fixture.js';

describe('canonical human-readable Channel projection', () => {
  /**
   * The single named Round-3 acceptance. Everything the Owner had to look up —
   * who sent it, which Round and Lane, what actually happened, and what the
   * verdict means — must be on the card itself.
   *
   * Catches: replacing the Knowledge dereference with the raw event summary;
   * dropping outcome-ranked line selection so the accept/refuse sentence falls
   * outside the three-line budget; resolving the sender from event text; or
   * putting the Knowledge id back in the headline.
   */
  it('renders the Lane C evidence event with sender, stage, outcome and verdict meaning without a second lookup', () => {
    const projection = projectChannelEvent(laneCEvent(), laneCFacts());
    const card = renderChannelCard(projection);
    expect(projection.sender).toEqual({ label: 'Hermes Owner Deputy', role: 'owner' });
    expect(projection.stage).toBe('Round-3 Lane C');
    expect(projection.headline).toContain('R2-REV-F17 is closed');
    expect(projection.headline).not.toContain('knowledge_');
    expect(projection.summary.join(' ')).toMatch(/Only accept completes the Task; a refuse .*leaves the Task lifecycle untouched so refused work stays open/);
    expect(projection.refs).toContainEqual({ label: 'Knowledge', value: LANE_C_KNOWLEDGE });
    expect(projection.refs).toContainEqual({ label: 'Commit', value: '2acda1f' });
    expect(card).toContain('From: Hermes Owner Deputy · owner');
    expect(card.split('\n').at(-1)).toMatch(/^Refs: /);
    // Nothing above the refs line may carry an opaque record id.
    expect(card.split('\n').slice(0, -1).join('\n')).not.toMatch(/\b(?:knowledge|task|result|event|member)_[0-9a-f]{6,}/);
    expect(card).not.toBe(laneCEvent().content.summary);
  });

  /**
   * Catches: deriving the sender from the event summary or any other
   * caller-supplied text instead of the durable Member record.
   */
  it('resolves the sender from Member records and ignores identity claimed in event text', () => {
    const event = laneCEvent();
    event.sourceMemberId = 'member_worker';
    event.content.summary = 'From: Hermes Owner Deputy · owner — evidence knowledge';
    const projection = projectChannelEvent(event, laneCFacts());
    expect(projection.sender).toEqual({ label: 'Codex Worker', role: 'worker' });
    expect(renderChannelCard(projection)).toContain('From: Codex Worker · worker');
  });

  /** Catches: an unattributable event throwing, or silently claiming an owner. */
  it('degrades to an unattributed sender when no Member record matches', () => {
    const event = laneCEvent();
    delete (event as { sourceMemberId?: string }).sourceMemberId;
    expect(projectChannelEvent(event, laneCFacts()).sender).toEqual({ label: 'unattributed', role: 'unknown' });
  });

  /**
   * Catches: removing `bound` from the headline, summary lines or subject, so
   * an unbounded durable entry blows out a rendered card.
   */
  it('bounds headline, summary lines and subject for rendering', () => {
    const facts = laneCFacts();
    facts.knowledge[0].text = `${'Escalation detail that must be truncated for rendering '.repeat(40)}. ${'Only accept completes the Task and a refuse leaves it open '.repeat(40)}.`;
    (facts.tasks as any).push({ id: 'task_long', workspaceId: WORKSPACE, title: 'Round-3 Lane C: '.concat('a very long durable task title '.repeat(20)), lifecycle: 'completed', fence: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' });
    const event = laneCEvent();
    event.taskId = 'task_long';
    const projection = projectChannelEvent(event, facts);
    expect(projection.headline.length).toBeLessThanOrEqual(HEADLINE_MAX);
    expect(projection.subject!.length).toBeLessThanOrEqual(SUBJECT_MAX);
    expect(projection.summary.length).toBeLessThanOrEqual(3);
    for (const line of projection.summary) expect(line.length).toBeLessThanOrEqual(SUMMARY_LINE_MAX);
  });

  /**
   * Catches: dropping the derived-text scrub, which would let an approved
   * Knowledge entry carry a private path or a credential assignment onto a
   * human surface and into the provider delivery envelope.
   */
  it('scrubs private paths and credential assignments out of derived summary text', () => {
    const facts = laneCFacts();
    facts.knowledge[0].text = 'The Lane C proof ran from /Users/someone/private/worktree and used api_key=sk-not-a-real-value for the probe. Only accept completes the Task; a refuse leaves the work open.';
    const card = renderChannelCard(projectChannelEvent(laneCEvent(), facts));
    expect(card).not.toContain('/Users/');
    expect(card).not.toContain('sk-not-a-real-value');
    expect(card).toContain('[redacted]');
    expect(card).toContain('a refuse leaves the work open');
  });

  /**
   * Catches: presenting the hex inside an opaque record id as a commit ref.
   */
  it('never mistakes the hex inside a record id for a commit ref', () => {
    const facts = laneCFacts();
    facts.knowledge[0].text = 'Recorded against result_093ec616ddc5f1 with no commit of its own yet.';
    expect(projectChannelEvent(laneCEvent(), facts).refs.some((ref) => ref.label === 'Commit')).toBe(false);
  });

  /**
   * Catches: dropping decision options from the projection, or labelling a
   * blocking decision as a settled outcome.
   */
  it('renders a decision_required event as an issue with the explicit next choices', () => {
    const event = laneCEvent();
    event.kind = 'decision_required';
    event.decisionRequired = true;
    event.urgency = 'urgent';
    event.decisionOptions = ['CONTINUE', 'REASSIGN', 'PARK'];
    event.content.summary = 'Real Codex launch is unavailable; automatic and manual paths are implemented but live proof is still missing.';
    (event as ChannelEvent).content.evidenceRefs = [];
    const facts = laneCFacts();
    facts.knowledge = [];
    const card = renderChannelCard(projectChannelEvent(event, facts));
    expect(card).toContain('[Decision required]');
    expect(card).toContain('Issue: Real Codex launch is unavailable');
    expect(card).toContain('Next: CONTINUE · REASSIGN · PARK');
  });

  /** Catches: losing the verdict distinction between an accepted and refused decision. */
  it('labels a resolved decision by its verdict', () => {
    const accepted = laneCEvent(); accepted.kind = 'decision_resolved'; accepted.verdict = 'accept';
    const refused = laneCEvent(); refused.kind = 'decision_resolved'; refused.verdict = 'refuse';
    expect(projectChannelEvent(accepted, laneCFacts()).label).toBe('Accepted');
    expect(projectChannelEvent(refused, laneCFacts()).label).toBe('Refused');
  });

});
