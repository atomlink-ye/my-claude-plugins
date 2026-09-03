/**
 * The one bounded, read-only answer to "what is running, what awaits me, why,
 * and what happens next" for a single ControlWorkspace.
 *
 * A pure fold, like the channel and sequence projections beside it: it never
 * reads the clock or touches state, so `nowMs` arrives as a fact and every age
 * is testable without freezing a global clock. The renderer consumes the same
 * projection the JSON does, so the two cannot drift.
 */
import type { ChannelEvent, Delivery, Goal, Member, Result, RuntimeSession, Task } from './arcp.js';
import { projectDeliveryLatency, renderDeliveryLatency, type DeliveryLatency } from './delivery-latency.js';

/** A fact that could not be established. Never omitted, never guessed: a reader
 * must be able to tell "nothing pending" from "we could not see". */
export const UNKNOWN = 'unknown' as const;
export type Unknown = typeof UNKNOWN;

export type ControlRuntimeState = 'running' | 'idle' | 'attention' | 'terminal';
export type NextTriggerReason =
  | 'owner_decision_pending' | 'ack_pending' | 'awaiting_result'
  | 'campaign_next_round' | 'idle_no_pending_work';

/**
 * Campaign facts are supplied by the caller from the task artifact. ARCP does
 * not read the external bundle, and these are labelled as caller-supplied
 * everywhere they surface, so a reader never mistakes them for control-plane
 * truth. `currentRound` and `checkpointSha` name the round that just closed;
 * the projection never infers a checkpoint from durable state.
 */
export interface ControlCampaignFacts {
  campaignState?: string; nextContractRef?: string; nextLaunchBy?: string; stopAuthority?: string;
  currentRound?: string; checkpointSha?: string;
}

export interface ControlPanoramaFacts {
  workspaceId: string;
  workspacePurpose?: string;
  nowMs: number;
  sessions: readonly RuntimeSession[];
  members: readonly Member[];
  goals: readonly Goal[];
  tasks: readonly Task[];
  results: readonly Result[];
  events: readonly ChannelEvent[];
  deliveries?: readonly Delivery[];
  admission?: { action: string; providerId: string; model: string; reasons: readonly string[] };
  budgetSource?: { id: string; observedAt: string; trust: string };
  cacheClass?: string;
  campaign?: ControlCampaignFacts;
}

export interface ControlPanoramaRuntime { runtimeId: string; role: string | Unknown; memberId: string | Unknown; provider: string; state: ControlRuntimeState; }
export interface ControlPanoramaPending { decisions: number; acks: number; takeovers: number; oldestOpenAgeMs: number | Unknown; oldestOpenEventId: string | Unknown; }
export interface ControlPanoramaDisposition { eventId: string; kind: string; actor: string | Unknown; reason: string | Unknown; evidenceRefs: readonly string[]; at: string; }

export interface ControlPanorama {
  workspaceId: string;
  purpose: string | Unknown;
  runtimes: ControlPanoramaRuntime[];
  goal: { id: string; title: string; state: string } | Unknown;
  task: { id: string; title: string; lifecycle: string; fence: number } | Unknown;
  latestResult: { id: string; status: string; summary: string } | Unknown;
  checkpointSha: string | Unknown;
  pending: ControlPanoramaPending;
  latestDisposition: ControlPanoramaDisposition | Unknown;
  providerBudget: { admission: string; providerId: string; model: string; reasons: readonly string[]; sourceId: string | Unknown; observedAt: string | Unknown; trust: string | Unknown; cacheClass: string | Unknown } | Unknown;
  campaign: { campaignState: string | Unknown; nextContractRef: string | Unknown; nextLaunchBy: string | Unknown; stopAuthority: string | Unknown; currentRound: string | Unknown; checkpointSha: string | Unknown } | Unknown;
  nextTrigger: string;
  nextTriggerReason: NextTriggerReason;
  latency: DeliveryLatency;
}

const OPEN_POLICIES = ['ack_required', 'decision_required'];
const isOpenObligation = (event: ChannelEvent) => OPEN_POLICIES.includes(event.consumptionPolicy) && event.consumptionState === 'open';
/** A commit reference a Worker actually reported. A branch tip or a clean tree
 * is never used: inferring a checkpoint from the filesystem is a guess. */
const COMMIT_REF = /^(?:commit:)?([0-9a-f]{7,40})$/;

function runtimeState(session: RuntimeSession): ControlRuntimeState {
  if (session.state === 'terminal') return 'terminal';
  if (session.state === 'running') return 'running';
  if (['attention', 'placement_mismatch', 'transport_indeterminate'].includes(session.state)) return 'attention';
  return 'idle';
}

export function projectControlPanorama(facts: ControlPanoramaFacts): ControlPanorama {
  const scoped = <T extends { workspaceId?: string }>(items: readonly T[]) => items.filter((item) => item.workspaceId === facts.workspaceId);
  const members = new Map(scoped(facts.members).map((item) => [item.id, item]));
  const sessions = scoped(facts.sessions);
  const tasks = scoped(facts.tasks);
  const results = scoped(facts.results);
  const events = scoped(facts.events);

  const runtimes = sessions.map((session) => ({
    runtimeId: session.id,
    role: (session.memberId && members.get(session.memberId)?.role) || UNKNOWN,
    memberId: session.memberId ?? UNKNOWN,
    provider: session.provider,
    state: runtimeState(session),
  }));

  const live = sessions.filter((session) => session.state !== 'terminal');
  const newestSession = [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const goal = facts.goals.find((item) => item.id === newestSession?.goalId);
  const task = tasks.find((item) => item.id === newestSession?.taskId);
  const latestResult = [...results].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);

  const checkpointSha = latestResult?.evidenceRefs
    .map((ref) => COMMIT_REF.exec(ref.trim())?.[1])
    .find((value): value is string => Boolean(value)) ?? UNKNOWN;

  const open = events.filter(isOpenObligation);
  const oldest = [...open].sort((a, b) => (a.deliveredAt ?? a.createdAt).localeCompare(b.deliveredAt ?? b.createdAt)).at(0);
  const oldestAt = oldest ? Date.parse(oldest.deliveredAt ?? oldest.createdAt) : Number.NaN;
  const pending: ControlPanoramaPending = {
    decisions: open.filter((event) => event.consumptionPolicy === 'decision_required').length,
    acks: open.filter((event) => event.consumptionPolicy === 'ack_required').length,
    takeovers: events.filter((event) => Boolean(event.takeover)).length,
    oldestOpenAgeMs: Number.isFinite(oldestAt) ? Math.max(0, facts.nowMs - oldestAt) : UNKNOWN,
    oldestOpenEventId: oldest?.id ?? UNKNOWN,
  };

  // The most recent thing a human or Manager actually decided, with why.
  const dispositions: ControlPanoramaDisposition[] = [];
  for (const event of events) {
    if (event.verdict && event.resolvedAt) dispositions.push({ eventId: event.id, kind: `decision_${event.verdict}`, actor: event.targetMemberId ?? UNKNOWN, reason: event.content.summary || UNKNOWN, evidenceRefs: event.content.evidenceRefs, at: event.resolvedAt });
    if (event.takeover) dispositions.push({ eventId: event.id, kind: `takeover_${event.takeover.trigger}`, actor: event.takeover.toMemberId, reason: event.takeover.evidence, evidenceRefs: [], at: event.takeover.at });
    for (const receipt of event.dispositions) dispositions.push({ eventId: event.id, kind: receipt.kind, actor: receipt.actorMemberId, reason: ('reason' in receipt && typeof (receipt as { reason?: unknown }).reason === 'string' ? (receipt as { reason: string }).reason : UNKNOWN), evidenceRefs: [], at: receipt.at });
  }
  const latestDisposition = [...dispositions].sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? UNKNOWN;

  const providerBudget = facts.admission
    ? { admission: facts.admission.action, providerId: facts.admission.providerId, model: facts.admission.model, reasons: facts.admission.reasons, sourceId: facts.budgetSource?.id ?? UNKNOWN, observedAt: facts.budgetSource?.observedAt ?? UNKNOWN, trust: facts.budgetSource?.trust ?? UNKNOWN, cacheClass: facts.cacheClass ?? UNKNOWN }
    : UNKNOWN;

  const campaign = facts.campaign
    ? { campaignState: facts.campaign.campaignState ?? UNKNOWN, nextContractRef: facts.campaign.nextContractRef ?? UNKNOWN, nextLaunchBy: facts.campaign.nextLaunchBy ?? UNKNOWN, stopAuthority: facts.campaign.stopAuthority ?? UNKNOWN, currentRound: facts.campaign.currentRound ?? UNKNOWN, checkpointSha: facts.campaign.checkpointSha ?? UNKNOWN }
    : UNKNOWN;

  // Ordered by who is blocking: an obligation owed by a human outranks work owed
  // by an agent, which outranks the campaign queue. Idle is never completion —
  // a claimed Task with no Result is still owed, however quiet the runtime is.
  const unresolvedTask = tasks.find((item) => ['claimed', 'running', 'waiting'].includes(item.lifecycle) && !results.some((result) => result.taskId === item.id));
  const [nextTriggerReason, nextTrigger]: [NextTriggerReason, string] =
    pending.decisions > 0 ? ['owner_decision_pending', `Resolve ${pending.decisions} open decision obligation(s); oldest is ${pending.oldestOpenEventId}`]
      : pending.acks > 0 ? ['ack_pending', `ACK ${pending.acks} open obligation(s); oldest is ${pending.oldestOpenEventId}`]
        : unresolvedTask ? ['awaiting_result', `Task ${unresolvedTask.id} is ${unresolvedTask.lifecycle} with no Result; an idle runtime is not a finished one`]
          : campaign !== UNKNOWN && campaign.nextContractRef !== UNKNOWN ? ['campaign_next_round', `Launch the next contract ${campaign.nextContractRef}${campaign.nextLaunchBy !== UNKNOWN ? ` by ${campaign.nextLaunchBy}` : ''}`]
            : ['idle_no_pending_work', live.length ? 'A runtime is live with nothing open; wait for it to report' : 'Nothing is running and nothing is open'];

  return {
    workspaceId: facts.workspaceId,
    purpose: facts.workspacePurpose ?? UNKNOWN,
    runtimes,
    goal: goal ? { id: goal.id, title: goal.title, state: goal.state } : UNKNOWN,
    task: task ? { id: task.id, title: task.title, lifecycle: task.lifecycle, fence: task.fence } : UNKNOWN,
    latestResult: latestResult ? { id: latestResult.id, status: latestResult.status, summary: latestResult.summary } : UNKNOWN,
    checkpointSha,
    pending,
    latestDisposition,
    providerBudget,
    campaign,
    nextTrigger,
    nextTriggerReason,
    latency: projectDeliveryLatency({ workspaceId: facts.workspaceId, nowMs: facts.nowMs, events, deliveries: facts.deliveries ?? [], results }),
  };
}

const age = (value: number | Unknown) => value === UNKNOWN ? UNKNOWN : `${Math.round(value / 60_000)}m`;

/** Compact Markdown from the same projection the JSON uses. */
export function renderControlPanorama(panorama: ControlPanorama): string {
  const lines: string[] = [];
  lines.push(`# Control panorama — ${panorama.workspaceId}`);
  lines.push('');
  lines.push(`**Purpose:** ${panorama.purpose}`);
  lines.push('');

  lines.push('## Running');
  if (!panorama.runtimes.length) lines.push('No runtimes.');
  else {
    lines.push('| Runtime | Role | Provider | State |');
    lines.push('|---|---|---|---|');
    for (const runtime of panorama.runtimes) lines.push(`| ${runtime.runtimeId} | ${runtime.role} | ${runtime.provider} | ${runtime.state} |`);
  }
  lines.push('');

  lines.push('## Work');
  lines.push(`- Goal: ${panorama.goal === UNKNOWN ? UNKNOWN : `${panorama.goal.title} (${panorama.goal.id}, ${panorama.goal.state})`}`);
  lines.push(`- Task: ${panorama.task === UNKNOWN ? UNKNOWN : `${panorama.task.title} (${panorama.task.id}, ${panorama.task.lifecycle}, fence ${panorama.task.fence})`}`);
  lines.push(`- Latest Result: ${panorama.latestResult === UNKNOWN ? UNKNOWN : `${panorama.latestResult.id} — ${panorama.latestResult.status} — ${panorama.latestResult.summary}`}`);
  lines.push(`- Checkpoint SHA: ${panorama.checkpointSha}`);
  lines.push('');

  lines.push('## Awaiting action');
  lines.push(`- Open decisions: ${panorama.pending.decisions}`);
  lines.push(`- Open ACKs: ${panorama.pending.acks}`);
  lines.push(`- Takeovers recorded: ${panorama.pending.takeovers}`);
  lines.push(`- Oldest open: ${age(panorama.pending.oldestOpenAgeMs)} (${panorama.pending.oldestOpenEventId})`);
  lines.push('');

  lines.push('## Latest disposition');
  if (panorama.latestDisposition === UNKNOWN) lines.push(UNKNOWN);
  else {
    const item = panorama.latestDisposition;
    lines.push(`- ${item.kind} by ${item.actor} at ${item.at}`);
    lines.push(`- Reason: ${item.reason}`);
    if (item.evidenceRefs.length) lines.push(`- Evidence: ${item.evidenceRefs.join(', ')}`);
  }
  lines.push('');

  lines.push('## Capacity');
  if (panorama.providerBudget === UNKNOWN) lines.push(UNKNOWN);
  else {
    const budget = panorama.providerBudget;
    lines.push(`- Admission: ${budget.admission} (${budget.providerId} ${budget.model})`);
    if (budget.reasons.length) lines.push(`- Reasons: ${budget.reasons.join('; ')}`);
    lines.push(`- Source: ${budget.sourceId}, observed ${budget.observedAt}, trust ${budget.trust}`);
    lines.push(`- Cache: ${budget.cacheClass}`);
  }
  lines.push('');

  lines.push('## Campaign _(caller-supplied, not control-plane truth)_');
  if (panorama.campaign === UNKNOWN) lines.push(UNKNOWN);
  else {
    lines.push(`- State: ${panorama.campaign.campaignState}`);
    lines.push(`- Round just closed: ${panorama.campaign.currentRound} at ${panorama.campaign.checkpointSha}`);
    lines.push(`- Next contract: ${panorama.campaign.nextContractRef}`);
    lines.push(`- Next launch by: ${panorama.campaign.nextLaunchBy}`);
    lines.push(`- Stop authority: ${panorama.campaign.stopAuthority}`);
  }
  lines.push('');

  lines.push(renderDeliveryLatency(panorama.latency));
  lines.push('');

  lines.push('## Next');
  lines.push(`- **${panorama.nextTriggerReason}** — ${panorama.nextTrigger}`);
  return lines.join('\n');
}
