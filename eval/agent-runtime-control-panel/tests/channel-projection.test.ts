import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArcpService, ArcpStore } from '../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { HEADLINE_MAX, SUBJECT_MAX, SUMMARY_LINE_MAX, projectChannelEvent, renderChannelCard } from '../../../skills/agent-runtime-control-panel/runtime/src/channel-projection.js';
import type { ChannelEvent } from '../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { renderTuiSnapshot } from '../../../skills/agent-runtime-control-panel/runtime/src/tui.js';

class FakeCli {
  async run(args: string[]) {
    if (args[0] === 'provider' && args[1] === 'ls') return { value: [{ provider: 'codex', status: 'available', enabled: true, modes: ['auto', 'full-access'] }], stdout: '', stderr: '' };
    if (args[0] === 'provider' && args[1] === 'models') return { value: [{ id: 'gpt-5.6-terra', thinkingOptionIds: ['medium'] }], stdout: '', stderr: '' };
    if (args[0] === 'run') return { value: { id: 'paseo-session-1' }, stdout: '', stderr: '' };
    if (args[0] === 'inspect') return { value: { id: 'paseo-session-1', status: 'idle', provider: 'codex', model: 'gpt-5.6-terra', mode: 'auto', thinking: 'medium' }, stdout: '', stderr: '' };
    return { value: [], stdout: '', stderr: '' };
  }
}
const control = async () => { const service = new ArcpService(await mkdtemp(path.join(os.tmpdir(), 'arcp-projection-')), new FakeCli() as any); await service.init(); return service; };

const WORKSPACE = 'workspace_a3eef982-afab-47ac-b286-9749a3cce343';
const OWNER_MEMBER = 'member_287ac3ec-9649-4cee-8a7a-f750a0ce0b75';
const LANE_C_KNOWLEDGE = 'knowledge_308365c2-c1e4-46e5-a2e3-7ff89db32d9b';

/**
 * The Owner's named acceptance case, reproduced from the campaign Workspace as
 * public facts only: a Member label and role, one already-approved Knowledge
 * entry, and the durable ChannelEvent envelope that referenced it. No
 * credential, prompt body, private path or transcript is reproduced here.
 *
 * The rendered notification the Owner rejected was, in full:
 *   `evidence knowledge knowledge_3083...`
 */
const laneCFacts = () => ({
  members: [
    { id: OWNER_MEMBER, workspaceId: WORKSPACE, actorId: 'actor_689a470de46a647be6aa', joinKind: 'native' as const, label: 'Hermes Owner Deputy', role: 'owner', capabilities: ['write_knowledge'], lifecycle: 'busy' as const, createdAt: '2026-09-01T13:01:54.413Z', updatedAt: '2026-09-01T22:10:03.812Z' },
    { id: 'member_worker', workspaceId: WORKSPACE, joinKind: 'native' as const, label: 'Codex Worker', role: 'worker', capabilities: [], lifecycle: 'busy' as const, createdAt: '2026-09-01T13:01:54.413Z', updatedAt: '2026-09-01T13:01:54.413Z' },
  ],
  tasks: [],
  goals: [],
  results: [],
  knowledge: [{
    id: LANE_C_KNOWLEDGE, workspaceId: WORKSPACE, authorMemberId: OWNER_MEMBER, kind: 'evidence' as const, tags: [], createdAt: '2026-09-01T21:50:05.691Z',
    text: 'R3-LANE-C C1 LANDED at 2acda1f on feat/agent-runtime-control-panel: R2-REV-F17 is closed. Lanes A and B may rebase onto this now. WHAT CHANGED in arcp.ts decision semantics. resolveDecision(eventId, sourceMemberId, summary, verdict) takes a fourth argument, type DecisionVerdict = accept | refuse, defaulting to accept so every existing caller keeps its current meaning. Only accept completes the Task; a refuse clears decisionRequired, records the verdict, and deliberately leaves the Task lifecycle untouched so refused work stays open. An unrecognised verdict throws invalid_request with field verdict before any state is touched. ChannelEvent gains an optional verdict field carried on both the decision_required event and its linked decision_resolved reply. RuntimeSession gains blockedOnEventId, blockedSince and blockedQuestion. HTTP POST /v1/events/:id/resolve accepts verdict in the body, default accept.',
  }],
});

const laneCEvent = (): ChannelEvent => ({
  id: 'event_5eeeb49b421fb2596be4', workspaceId: WORKSPACE, sourceMemberId: OWNER_MEMBER, targetRole: 'manager',
  kind: 'finding', urgency: 'normal', decisionRequired: false,
  content: { summary: `evidence knowledge ${LANE_C_KNOWLEDGE}`, evidenceRefs: [], contentHash: 'e2a47ae3', sensitivity: 'normal', retention: 'standard' },
  deliveryState: 'processed', transitions: [{ state: 'queued', at: '2026-09-01T21:50:05.694Z' }, { state: 'processed', at: '2026-09-01T21:52:07.247Z' }],
  createdAt: '2026-09-01T21:50:05.694Z',
});

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

  /**
   * Catches: any surface constructing its own notification text. If the Channel
   * API, the member inbox, the panorama/TUI or the provider delivery envelope
   * stops calling the one builder, these equalities break.
   */
  it('uses one canonical projection across channel list, inbox, panorama/TUI and the delivery envelope', async () => {
    const service = await control();
    const { actor } = await service.registerActor({ clientIdentity: 'projection-owner' });
    const created = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'projection parity' });
    const workspaceId = created.workspace.id;
    const manager = await service.joinWorkspace({ workspaceId, label: 'Hermes Owner Deputy', role: 'manager' });
    const worker = await service.joinWorkspace({ workspaceId, label: 'Codex Worker', role: 'worker' });
    const task = await service.createTask({ workspaceId, title: 'Round-3 Lane E: human-readable Channel projection' });
    await service.store.mutate((state: any) => state.sessions.push({ id: 'live-manager', actorId: actor.id, goalId: 'goal-manager', bindingId: state.bindings[0].id, generation: 1, runtimeKind: 'paseo', adapterId: 'paseo', workspaceId, memberId: manager.member.id, profileId: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', state: 'idle', externalId: 'live-manager', createdAt: new Date().toISOString() }));
    const event = await service.publishChannelEvent({ workspaceId, taskId: task.id, sourceMemberId: worker.member.id, targetMemberId: manager.member.id, kind: 'task_completed', urgency: 'normal', decisionRequired: false, summary: `Task ${task.id} completed by durable Result`, evidenceRefs: [] });

    const listed = service.channelEvents(workspaceId).find((item) => item.id === event.id)!;
    const card = renderChannelCard(listed.projection);
    expect(card).toContain('[Completed] Round-3 Lane E');
    expect(card).toContain('From: Codex Worker · worker');
    expect(card).toContain(`Refs: Task ${task.id}`);
    // Acceptance 4: the durable id the Owner was forced to dereference appears
    // once, on the refs line, and never in the headline.
    expect(card).not.toContain(`Task ${task.id} completed by durable Result`);
    expect(card.split('\n').slice(0, -1).join('\n')).not.toMatch(/\b(?:knowledge|task|result|event|member)_[0-9a-f]{6,}/);
    expect(listed.projection.headline).toBe('Task completed by durable Result');

    const inbox = service.context(workspaceId, manager.member.id).inbox;
    const delivered = inbox.find((item: any) => item.eventId === event.id)!;
    expect(renderChannelCard((delivered as any).projection)).toBe(card);
    // Channel list, inbox and the provider envelope carry byte-identical
    // Markdown, so no surface can render its own envelope.
    expect((delivered as any).markdown).toBe(listed.markdown);
    expect((delivered as any).body).toBe(listed.markdown);
    expect((delivered as any).body).not.toBe(event.content.summary);
    expect(listed.markdown).toContain('### ✅ Completed · Round-3 Lane E');

    const panorama = await service.panorama(workspaceId);
    const snapshot = renderTuiSnapshot(panorama);
    for (const line of card.split('\n')) expect(snapshot).toContain(`  ${line}`);
    service.close();
  });

  /**
   * Catches: turning the projection into a stored field, which would require
   * rewriting the append-only journal. Reading must enrich, never migrate.
   */
  it('enriches events written before the projection existed without rewriting the journal', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'arcp-legacy-projection-'));
    const legacy = {
      actors: [], bindings: [], credentials: {},
      workspaces: [{ id: WORKSPACE, purpose: 'campaign', lifecycle: 'active', ownerActorId: 'actor_689a470de46a647be6aa', ownerMemberId: OWNER_MEMBER, createdAt: '2026-09-01T13:01:54.413Z', updatedAt: '2026-09-01T13:01:54.413Z' }],
      members: laneCFacts().members, memberCredentials: {}, tasks: [], knowledge: laneCFacts().knowledge, results: [], goals: [], sessions: [], deliveries: [],
      // A legacy flat event: summary and evidenceRefs outside `content`.
      channelEvents: [{ id: 'event_legacy', workspaceId: WORKSPACE, sourceMemberId: OWNER_MEMBER, targetRole: 'manager', kind: 'finding', urgency: 'normal', decisionRequired: false, summary: `evidence knowledge ${LANE_C_KNOWLEDGE}`, evidenceRefs: [], createdAt: '2026-09-01T21:50:05.694Z' }],
      confirmations: [], supervisionPolicies: [], supervisionReviews: [], supervisionSignals: [],
    };
    const file = path.join(dir, 'arcp-state.json');
    await writeFile(file, JSON.stringify(legacy, null, 2) + '\n', { mode: 0o600 });
    const store = new ArcpStore(dir);
    await store.init();
    const service = new ArcpService(dir, new FakeCli() as any, store);
    await service.init();
    const projected = service.channelEvents(WORKSPACE)[0];
    expect(projected.projection.sender.label).toBe('Hermes Owner Deputy');
    expect(projected.projection.headline).toContain('R2-REV-F17 is closed');
    // The journal keeps exactly the durable facts it already had: the
    // projection is derived on read and is never written back.
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    expect(persisted.channelEvents).toHaveLength(1);
    expect(persisted.channelEvents[0]).not.toHaveProperty('projection');
    expect(persisted.channelEvents[0].content.summary).toBe(`evidence knowledge ${LANE_C_KNOWLEDGE}`);
    expect(persisted.knowledge[0].text).toBe(laneCFacts().knowledge[0].text);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    service.close();
  });

  /**
   * The real-Workspace demonstration, reproducible on demand:
   * `ARCP_CAMPAIGN_STATE=<state file> npx vitest run`. It is skipped when the
   * variable is unset so the committed suite never depends on live state.
   */
  it('renders the real campaign event referencing the Lane C evidence, when a live state file is supplied', async () => {
    const file = process.env.ARCP_CAMPAIGN_STATE;
    if (!file) return;
    const live = JSON.parse(await readFile(file, 'utf8'));
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
