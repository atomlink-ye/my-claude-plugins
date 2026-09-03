import type { ChannelEvent, ChannelEventKind, ConsumptionPolicy, ConsumptionState, Delivery, ExpectedAction, Goal, KnowledgeEntry, Member, Result, RuntimeSession, Task } from './arcp.js';

/**
 * The one human-readable projection of a durable ChannelEvent.
 *
 * Authority item 11: a human-visible Channel projection must be readable
 * without a second lookup. Every human surface — CLI `channel list`, `inbox`,
 * the panorama/TUI and the provider delivery envelope — renders THIS structure
 * through `renderChannelCard`, so no surface can drift into its own string
 * construction and re-introduce `Task task_9ea0... completed by durable Result`.
 *
 * The projection is computed at READ time from durable facts. Nothing here is
 * persisted and the append-only journal is never rewritten, so events written
 * before this existed project exactly as well as events written after it.
 */
export interface ChannelProjectionSender { label: string; role: string; }
/**
 * One typed reference. Kept as a pair rather than a pre-joined string so a
 * renderer can decide its own presentation — a plain-text card joins them, the
 * Markdown renderer emits a bullet list — without any surface re-parsing text.
 */
export interface ChannelProjectionRef { label: string; value: string; }
export interface ChannelProjectionTransport { state: string; deliveredAt?: string; }
export interface ChannelProjectionRecipientProcessing { state: 'unobserved' | 'processed'; memberId?: string; memberLabel?: string; at?: string; }
export interface ChannelProjectionAcknowledgement { state: 'not_required' | 'pending' | 'acknowledged'; memberId?: string; at?: string; reason?: string; }
export interface ChannelProjectionResultCausality { relation: 'reported_by_result' | 'completed_by_result'; resultId: string; taskId: string; fence: number; status: Result['status']; sourceId?: string; createdAt: string; }
export interface ChannelProjection {
  eventId: string;
  /** The durable event kind, so a renderer can pick a stable status icon. */
  kind: ChannelEventKind;
  /** Bracket label, e.g. `Completed`, `Decision required`, `Refused`. */
  label: string;
  /** Round/Lane/phase, when it can be established from durable facts. */
  stage?: string;
  /** Short related Goal/Task title, hard-truncated. */
  subject?: string;
  /** Resolved server-side from Member records; never parsed from event text. */
  sender: ChannelProjectionSender;
  /** `summary[0]`; the concise outcome or issue, never an opaque ID. */
  headline: string;
  /** One to three bounded lines drawn from already-approved durable content. */
  summary: string[];
  /** Typed references, rendered last and nowhere else. */
  refs: ChannelProjectionRef[];
  /** Explicit choices a human must pick between, when the event carries them. */
  options: string[];
  /** True when the first line states a problem to act on, not an outcome. */
  issue: boolean;
  urgency: ChannelEvent['urgency'];
  priority: ChannelEvent['priority'];
  consumptionPolicy: ConsumptionPolicy;
  consumptionState: ConsumptionState;
  expectedAction: ExpectedAction;
  decisionRequired: boolean;
  verdict?: ChannelEvent['verdict'];
  /** Transport, recipient processing, and acknowledgement are independent
   * facts. In particular, an idle runtime never populates processing. */
  transport: ChannelProjectionTransport;
  recipientProcessing: ChannelProjectionRecipientProcessing;
  acknowledgement: ChannelProjectionAcknowledgement;
  resultCausality?: ChannelProjectionResultCausality;
  deliveryState: ChannelEvent['deliveryState'];
  createdAt: string;
}

/** Durable records the projection may dereference. Read-only by construction. */
export interface ChannelProjectionFacts {
  members: readonly Member[];
  tasks: readonly Task[];
  goals: readonly Goal[];
  knowledge: readonly KnowledgeEntry[];
  results: readonly Result[];
  /** Resolution is durable event state, not a delivery outcome. */
  channelEvents?: readonly ChannelEvent[];
  deliveries?: readonly Delivery[];
  sessions?: readonly RuntimeSession[];
}

export const HEADLINE_MAX = 120;
export const SUMMARY_LINE_MAX = 180;
export const SUBJECT_MAX = 72;
export const STAGE_MAX = 48;
export const SUMMARY_MAX_LINES = 3;

const KIND_LABELS: Record<ChannelEventKind, string> = {
  decision_required: 'Decision required',
  decision_resolved: 'Decision resolved',
  task_claimed: 'Claimed',
  task_candidate: 'Candidate',
  task_completed: 'Completed',
  task_failed: 'Failed',
  task_unknown: 'Unknown',
  phase_progress: 'Progress',
  phase_completed: 'Phase completed',
  blocker: 'Blocker',
  finding: 'Finding',
  permission: 'Permission',
  attention: 'Attention',
  runtime_health: 'Runtime health',
  transport_uncertainty: 'Transport uncertain',
  material_progress: 'Progress',
  workspace_analysis_required: 'Analysis required',
};

/** Kinds whose first line is a problem to act on rather than an outcome. */
const ISSUE_KINDS = new Set<ChannelEventKind>(['decision_required', 'blocker', 'task_failed', 'task_unknown', 'attention', 'permission', 'runtime_health', 'transport_uncertainty', 'workspace_analysis_required']);

/**
 * Terms that distinguish an outcome sentence from narration. Selection is
 * ranked so the line a human actually needs — "only accept completes the Task;
 * a refuse ... leaves the work open" — survives a three-line budget even when
 * it is the eighteenth sentence of a long durable Knowledge entry.
 */
const OUTCOME_TERMS = ['accept', 'refuse', 'refused', 'complete', 'completes', 'completed', 'closed', 'close', 'open', 'blocked', 'blocker', 'failed', 'fails', 'missing', 'unavailable', 'requires', 'decision', 'verdict', 'next', 'recommend', 'proof', 'landed', 'risk', 'unresolved', 'cannot', 'must'];

/** Opaque record IDs. They belong in `refs`, never in a headline or summary. */
const ID_TOKEN = /\b(?:task|result|knowledge|event|member|delivery|workspace|goal|runtime|session|actor|binding|policy|review|signal)_[A-Za-z0-9][A-Za-z0-9_-]{5,}/g;
/** A short git sha: hex, and carrying at least one digit so prose cannot match. */
const COMMIT_TOKEN = /\b(?=[0-9a-f]*[0-9])[0-9a-f]{7,12}\b/g;
const PRIVATE_PATH = /(?:file:\/\/\/|\/Users\/|\/private\/|\/tmp\/|\/var\/|\/home\/|[A-Za-z]:\\)\S*/gi;
const SECRET_ASSIGNMENT = /(?:credential|authorization|bearer|api[_-]?(?:key|secret)|access[_-]?token|token|secret|password|passwd|private[_-]?key)\s*[:=]\s*\S+/gi;
const TRANSCRIPT_MARKUP = /<\/?(?:thinking|assistant|user|system)>/gi;

/**
 * Strip anything the Channel guard would have refused at write time.
 *
 * Derived text is scrubbed rather than rejected on purpose: the projection is
 * built inside the same mutation that appends an event, and `ArcpStore.mutate`
 * has no rollback, so a throw here could leave partial durable state. This
 * function is total.
 */
function scrub(value: unknown): string {
  return String(value ?? '')
    .replace(TRANSCRIPT_MARKUP, ' ')
    .replace(SECRET_ASSIGNMENT, '[redacted]')
    .replace(PRIVATE_PATH, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
}

function bound(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function withoutIds(value: string): string {
  return value.replace(ID_TOKEN, '').replace(/\s+([.,;:])(?=\s|$)/g, '$1').replace(/\s+/g, ' ').trim();
}

const MIN_SENTENCE = 12;

/**
 * Split durable text into renderable lines. A short leading fragment is merged
 * forward rather than dropped: a Result whose first sentence is the single word
 * `ACCEPT.` is carrying the verdict, and dropping it would delete the outcome
 * the whole card exists to show.
 */
function sentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((item) => withoutIds(scrub(item)))
    .map((item) => item.replace(/^[-*·•\s]+/, '').trim())
    .filter((item) => item.length > 0);
  const lines: string[] = [];
  let carry = '';
  for (const part of parts) {
    const merged = carry ? `${carry} ${part}` : part;
    if (merged.length >= MIN_SENTENCE && /\s/.test(merged)) { lines.push(merged); carry = ''; }
    else carry = merged;
  }
  if (carry) lines.push(carry);
  return lines;
}

function outcomeScore(sentence: string): number {
  const words = sentence.toLowerCase().match(/[a-z]+/g) ?? [];
  let score = 0;
  for (const word of words) if (OUTCOME_TERMS.includes(word)) score += 1;
  return score;
}

const STAGE_PATTERNS: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [/\bR(\d)[-\s]?LANE[-\s]?([A-Z])\b/i, (m) => `Round-${m[1]} Lane ${m[2].toUpperCase()}`],
  [/\bRound[-\s·]*(\d)\s*(?:·|-|—|:)?\s*Lane\s*([A-Za-z])\b/i, (m) => `Round-${m[1]} Lane ${m[2].toUpperCase()}`],
  [/\bLane\s*([A-Za-z])\b/i, (m) => `Lane ${m[1].toUpperCase()}`],
  [/\bRound[-\s]?(\d)\b/i, (m) => `Round-${m[1]}`],
];

function stageFrom(text: string | undefined): string | undefined {
  if (!text) return undefined;
  for (const [pattern, format] of STAGE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return format(match);
  }
  return undefined;
}

/** A stage recorded deliberately as a Knowledge tag outranks any derivation. */
function stageFromTags(tags: readonly string[] | undefined): string | undefined {
  const round = tags?.find((tag) => /^round[-_]?\d$/i.test(tag));
  const lane = tags?.find((tag) => /^lane[-_]?[a-z]$/i.test(tag));
  if (!round && !lane) return undefined;
  const roundLabel = round ? `Round-${round.replace(/\D/g, '')}` : undefined;
  const laneLabel = lane ? `Lane ${lane.slice(-1).toUpperCase()}` : undefined;
  return [roundLabel, laneLabel].filter(Boolean).join(' ');
}

function idsIn(...values: Array<string | undefined>): string[] {
  const found = new Set<string>();
  for (const value of values) for (const match of String(value ?? '').matchAll(ID_TOKEN)) found.add(match[0]);
  return [...found];
}

/**
 * Build the canonical human projection of one durable event.
 *
 * Never throws: an event whose related records are missing still projects,
 * degraded, because a Channel that fails to render is worse than one that
 * renders less.
 */
export function projectChannelEvent(event: ChannelEvent, facts: ChannelProjectionFacts): ChannelProjection {
  const eventSummary = event.content?.summary ?? '';
  const evidenceRefs = event.content?.evidenceRefs ?? [];
  const referenced = idsIn(eventSummary, ...evidenceRefs);

  // Sender is resolved from durable Member records only. Event text is
  // author-supplied and must never be able to claim an identity.
  const member = facts.members.find((item) => item.id === event.sourceMemberId)
    ?? (event.sourceActorId ? facts.members.find((item) => item.actorId === event.sourceActorId) : undefined);
  const sender: ChannelProjectionSender = member
    ? { label: bound(scrub(member.label), SUBJECT_MAX), role: scrub(member.role) || 'unknown' }
    : { label: 'unattributed', role: 'unknown' };

  const knowledge = facts.knowledge.find((item) => referenced.includes(item.id))
    ?? facts.knowledge.find((item) => evidenceRefs.includes(item.id));
  const result = (event.resultId ? facts.results.find((item) => item.id === event.resultId) : undefined)
    ?? facts.results.find((item) => referenced.includes(item.id));
  const task = (event.taskId ? facts.tasks.find((item) => item.id === event.taskId) : undefined)
    ?? (knowledge?.taskId ? facts.tasks.find((item) => item.id === knowledge.taskId) : undefined)
    ?? (result ? facts.tasks.find((item) => item.id === result.taskId) : undefined);
  const goal = event.goalId ? facts.goals.find((item) => item.id === event.goalId) : undefined;
  const delivery = facts.deliveries?.filter((item) => item.eventId === event.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  const recipientSession = delivery ? facts.sessions?.find((item) => item.id === delivery.runtimeSessionId) : undefined;
  const recipient = recipientSession?.memberId
    ? facts.members.find((item) => item.id === recipientSession.memberId)
    : event.targetMemberId ? facts.members.find((item) => item.id === event.targetMemberId) : undefined;
  const ackReceipt = event.dispositions?.find((item) => item.kind === 'ack');
  const processedAt = delivery?.processedAt ?? (ackReceipt ? ackReceipt.at : undefined);
  const acknowledgedAt = delivery?.acknowledgedAt ?? event.acknowledgedAt ?? ackReceipt?.at;

  // Detail preference: the linked durable record carries the actual outcome;
  // the event summary is usually only its machine-addressable stub.
  const detail = knowledge?.text || result?.summary || eventSummary;

  const resolution = event.verdict
    ? event.verdict
    : facts.channelEvents?.find((item) => item.kind === 'decision_resolved' && item.relatedEventId === event.id)?.verdict;
  const label = resolution && (event.kind === 'decision_required' || event.kind === 'decision_resolved')
    ? resolution === 'refuse' ? 'Refused' : 'Accepted'
    : KIND_LABELS[event.kind] ?? 'Event';

  const subjectSource = task?.title ?? goal?.title;
  const subject = subjectSource ? bound(withoutIds(scrub(subjectSource)), SUBJECT_MAX) : undefined;

  const stage = stageFromTags(knowledge?.tags)
    ?? stageFrom(task?.title)
    ?? stageFrom(detail)
    ?? stageFrom(eventSummary);

  const candidates = sentences(detail);
  const fallback = withoutIds(scrub(eventSummary)) || `${label} recorded`;
  const first = candidates[0] ?? fallback;
  // Keep the opening sentence, then the highest-signal remaining sentences, and
  // re-emit them in document order so the lines still read as prose.
  const rest = candidates.slice(1).map((text, index) => ({ text, index, score: outcomeScore(text) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, SUMMARY_MAX_LINES - 1)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.text);
  const stagePrefix = stage && first.toUpperCase().startsWith(stage.replace(/Round-(\d) Lane ([A-Z])/, 'R$1-LANE-$2').toUpperCase())
    ? first.slice(stage.replace(/Round-(\d) Lane ([A-Z])/, 'R$1-LANE-$2').length).replace(/^[\s:·-]+/, '')
    : first;
  const headline = bound(stagePrefix || first, HEADLINE_MAX);
  const summary = [headline, ...rest.map((line) => bound(line, SUMMARY_LINE_MAX))].slice(0, SUMMARY_MAX_LINES);

  // Scan for commits only AFTER record ids are removed, so the hex inside an
  // opaque id can never be presented to a human as a commit ref.
  const commits = [...new Set([...withoutIds(String(detail)).matchAll(COMMIT_TOKEN)].map((match) => match[0]))].slice(0, 2);
  const refs: ChannelProjectionRef[] = [
    ...(task ? [{ label: 'Task', value: task.id }] : []),
    ...(result ? [{ label: 'Result', value: result.id }] : []),
    ...(knowledge ? [{ label: 'Knowledge', value: knowledge.id }] : []),
    ...(event.relatedEventId ? [{ label: 'Event', value: event.relatedEventId }] : []),
    ...commits.map((sha) => ({ label: 'Commit', value: sha })),
    ...evidenceRefs.filter((ref) => ref !== knowledge?.id).map((ref) => ({ label: 'Evidence', value: bound(scrub(ref), SUBJECT_MAX) })),
  ];

  const resultCausality = result && task ? {
    relation: event.kind === 'task_completed' ? 'completed_by_result' as const : 'reported_by_result' as const,
    resultId: result.id,
    taskId: result.taskId,
    fence: result.fence,
    status: result.status,
    ...(result.sourceId ? { sourceId: result.sourceId } : {}),
    createdAt: result.createdAt,
  } : undefined;
  return {
    eventId: event.id,
    kind: event.kind,
    label,
    ...(stage ? { stage: bound(stage, STAGE_MAX) } : {}),
    ...(subject ? { subject } : {}),
    sender,
    headline,
    summary,
    refs,
    options: (event.decisionOptions ?? []).map((option) => bound(withoutIds(scrub(option)), SUBJECT_MAX)),
    issue: event.decisionRequired || ISSUE_KINDS.has(event.kind),
    urgency: event.urgency,
    priority: event.priority ?? (event.urgency === 'urgent' ? 'important' : 'normal'),
    consumptionPolicy: event.consumptionPolicy ?? (event.kind === 'decision_required' ? 'decision_required' : event.decisionRequired ? 'ack_required' : 'consume_on_delivery'),
    consumptionState: event.consumptionState ?? 'open',
    expectedAction: event.expectedAction ?? (event.kind === 'decision_required' ? { kind: 'resolve', instruction: 'Resolve with an accept or refuse verdict and a reason.' } : event.decisionRequired ? { kind: 'ack', instruction: 'ACK after handling, or defer with a reason if blocked.' } : { kind: 'none', instruction: 'No reply required — this message is consumed when delivered.' }),
    decisionRequired: event.decisionRequired,
    ...(event.verdict ? { verdict: event.verdict } : {}),
    transport: { state: delivery?.state ?? event.deliveryState, ...(delivery?.deliveredAt ? { deliveredAt: delivery.deliveredAt } : event.deliveredAt ? { deliveredAt: event.deliveredAt } : {}) },
    recipientProcessing: { state: processedAt ? 'processed' : 'unobserved', ...(recipient ? { memberId: recipient.id, memberLabel: bound(scrub(recipient.label), SUBJECT_MAX) } : {}), ...(processedAt ? { at: processedAt } : {}) },
    acknowledgement: event.consumptionPolicy === 'consume_on_delivery'
      ? { state: 'not_required' as const }
      : { state: acknowledgedAt ? 'acknowledged' as const : 'pending' as const, ...(ackReceipt ? { memberId: ackReceipt.actorMemberId, at: ackReceipt.at, reason: ackReceipt.reason } : delivery?.acknowledgedByMemberId ? { memberId: delivery.acknowledgedByMemberId, ...(delivery.acknowledgedAt ? { at: delivery.acknowledgedAt } : {}) } : {}) },
    ...(resultCausality ? { resultCausality } : {}),
    deliveryState: event.deliveryState,
    createdAt: event.createdAt,
  };
}

/**
 * Render the projection as the compact card every human surface shows. This is
 * the only place Channel notification text is constructed.
 */
export function renderChannelCard(projection: ChannelProjection): string {
  const heading = [projection.label ? `[${projection.label}]` : '[Event]', projection.stage, projection.subject ? `— ${projection.subject}` : undefined]
    .filter(Boolean).join(' ');
  const [headline, ...rest] = projection.summary;
  const lines = [
    heading,
    `From: ${projection.sender.label} · ${projection.sender.role}`,
    `${projection.issue ? 'Issue' : 'Outcome'}: ${headline}`,
    ...rest,
    ...(projection.options.length ? [`Next: ${projection.options.join(' · ')}`] : []),
    ...(projection.refs.length ? [`Refs: ${projection.refs.map((ref) => `${ref.label} ${ref.value}`).join(' · ')}`] : []),
  ];
  return lines.join('\n');
}

/** Project and render in one step, for surfaces that only need the text block. */
export function channelCardFor(event: ChannelEvent, facts: ChannelProjectionFacts): string {
  return renderChannelCard(projectChannelEvent(event, facts));
}
