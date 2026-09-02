import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type {
  ActionResult,
  ChannelEvent,
  ControlWorkspace,
  KnowledgeEntry,
  Member,
  Result,
  RuntimeObservation,
  RuntimeSession,
  State,
  Task,
  WorkSummary,
} from './arcp.js';

/**
 * Workspace Steward.
 *
 * An ephemeral, read-only-by-default analysis role. It reads durable Workspace
 * facts plus live Runtime observations for one subject Task, classifies it, and
 * publishes exactly one cited report carrying exactly one recommendation.
 *
 * It is NOT a second Manager. Its write surface is deliberately two methods on
 * {@link StewardWorkspaceView} - record the report, notify the Manager - so it
 * is structurally incapable of claiming a Task, submitting a product Result,
 * delivering to a runtime, or otherwise mutating product work. Authority stays
 * with the Manager/Deputy; the Steward only advises.
 *
 * There is no always-on Steward runtime. Every analysis is one bounded call.
 */

export type StewardClassification = 'HEALTHY' | 'DEGRADED' | 'STUCK' | 'TRANSPORT_INDETERMINATE';
export type StewardRecommendation = 'CONTINUE' | 'STEER' | 'REASSIGN' | 'PARK' | 'OWNER_DECISION';
export type StewardTrigger = 'automatic' | 'manual';

export class StewardError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
/** Raised when the owner-selected Steward provider is not live. Never substituted. */
export class StewardProviderUnavailableError extends StewardError {
  constructor(message: string) { super('steward_provider_unavailable', message); }
}

/**
 * Owner-configured Steward policy for one Workspace. The supervision budgets
 * that decide *when* a breach happens are Lane A's; this policy only carries
 * what the Steward execution path itself needs.
 */
export interface StewardPolicy {
  workspaceId: string;
  /** Owner-selected profile. `codex-worker` is Codex Terra medium. Never substituted. */
  stewardProfileId: string;
  /** Member identity the Steward authors its report as. */
  stewardMemberId: string;
  /** One analysis per subject within this window; repeated triggers dedupe. */
  cooldownMs: number;
  /** Manual analysis stays available even when the automatic trigger is off. */
  automatic: boolean;
  /**
   * How far back a manual analysis looks for material progress. Automatic
   * analyses use the window carried by the supervision breach instead.
   */
  manualProgressWindowMs: number;
}

/**
 * A supervision budget breach. Lane A owns budget evaluation and produces this;
 * the Steward only consumes it. Until Lane A lands, it is hand-raised.
 */
export interface SupervisionBreach {
  workspaceId: string;
  subjectTaskId: string;
  /** Task fence, or runtime generation, at the moment of the breach. */
  generation: number;
  reason: 'review_budget' | 'inactivity_budget';
  /** Material progress at or after this instant clears the breach. */
  progressSince: string;
  observedAt: string;
  /** Optional pointer back to Lane A's durable breach event. */
  eventId?: string;
}

/** The normalized input of the one execution path. Both triggers become this. */
export interface StewardAnalysisRequest {
  trigger: StewardTrigger;
  workspaceId: string;
  subjectTaskId: string;
  generation: number;
  progressSince: string;
  requestedAt: string;
  /** Manual trigger only. */
  requestedByMemberId?: string;
  breachReason?: SupervisionBreach['reason'];
  breachEventId?: string;
}

export interface StewardDossier {
  key: string;
  request: StewardAnalysisRequest;
  workspace: ControlWorkspace;
  subject: Task;
  session?: RuntimeSession;
  observation?: RuntimeObservation;
  workSummary?: WorkSummary;
  /** Durable material progress only. Liveness and turn state are excluded on purpose. */
  materialProgress: { latestAt?: string; refs: string[] };
  evidenceRefs: string[];
  classification: StewardClassification;
  recommendation: StewardRecommendation;
  why: string;
}

export interface StewardNarrative {
  narrative?: string;
  /** Production Codex analysts set this only after a cited Result is found. */
  cited?: boolean;
  evidenceRefs?: string[];
  provider: string;
  model: string;
  thinking?: string;
  runtimeSessionId?: string;
  analysisTaskId?: string;
}

/** The analysis runtime. Production is Codex; the port exists so it can be faked in tests. */
export interface StewardAnalyst {
  readonly profileId: string;
  analyze(dossier: StewardDossier): Promise<StewardNarrative>;
}

/** The Steward's entire access to ARCP. Reads are wide; writes are exactly two. */
export interface StewardWorkspaceView {
  readState(): State;
  observeSubject(sessionId: string): Promise<{ session: RuntimeSession; observation: RuntimeObservation; workSummary: WorkSummary } | undefined>;
  recordReport(input: { workspaceId: string; authorMemberId: string; kind: KnowledgeEntry['kind']; text: string; tags: string[]; taskId?: string }): Promise<KnowledgeEntry>;
  notifyManager(input: { id: string; workspaceId: string; taskId?: string; sourceMemberId: string; summary: string; evidenceRefs: string[]; urgency: 'normal' | 'urgent' }): Promise<ChannelEvent>;
}

export type StewardOutcomeStatus = 'analyzed' | 'deduplicated' | 'cooldown' | 'disabled' | 'timeout';

export interface StewardAnalysisOutcome {
  status: StewardOutcomeStatus;
  key: string;
  trigger: StewardTrigger;
  workspaceId: string;
  subjectTaskId: string;
  generation: number;
  knowledgeId?: string;
  eventId?: string;
  classification?: StewardClassification;
  recommendation?: StewardRecommendation;
  evidenceRefs?: string[];
  narrative?: string;
  analysisRuntimeSessionId?: string;
  why?: string;
}

export const STEWARD_REPORT_TAG = 'workspace-steward';
export const analysisKeyOf = (workspaceId: string, subjectTaskId: string, generation: number) => `${workspaceId}:${subjectTaskId}:${generation}`;
const analysisTag = (key: string) => `analysis:${key}`;
const subjectTag = (workspaceId: string, subjectTaskId: string) => `subject:${workspaceId}:${subjectTaskId}`;
const eventIdFor = (key: string) => `event_steward_${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;

/** Durable material progress kinds. Token streaming and keepalives are not progress. */
const PROGRESS_EVENT_KINDS = new Set(['material_progress', 'phase_progress', 'phase_completed', 'task_completed', 'task_candidate']);
const TERMINAL_TASK_LIFECYCLES = new Set(['completed', 'failed', 'cancelled']);

export class WorkspaceSteward {
  private readonly executions: Array<(request: StewardAnalysisRequest) => void> = [];
  constructor(
    private readonly view: StewardWorkspaceView,
    private readonly analyst: StewardAnalyst,
    private readonly policy: StewardPolicy,
  ) {}

  /**
   * Observe every entry into the one execution path. Both triggers must show up
   * here; a second parallel implementation would not.
   */
  onExecution(listener: (request: StewardAnalysisRequest) => void): () => void {
    this.executions.push(listener);
    return () => { const index = this.executions.indexOf(listener); if (index >= 0) this.executions.splice(index, 1); };
  }

  /**
   * Automatic trigger. Lane A's supervision breach enters the Steward here and
   * nowhere else, and immediately becomes the same request the manual trigger
   * builds.
   */
  async onSupervisionBreach(breach: SupervisionBreach): Promise<StewardAnalysisOutcome> {
    const request: StewardAnalysisRequest = {
      trigger: 'automatic',
      workspaceId: breach.workspaceId,
      subjectTaskId: breach.subjectTaskId,
      generation: breach.generation,
      progressSince: breach.progressSince,
      requestedAt: breach.observedAt,
      breachReason: breach.reason,
      ...(breach.eventId ? { breachEventId: breach.eventId } : {}),
    };
    if (!this.policy.automatic) {
      return { status: 'disabled', key: analysisKeyOf(request.workspaceId, request.subjectTaskId, request.generation), trigger: 'automatic', workspaceId: request.workspaceId, subjectTaskId: request.subjectTaskId, generation: request.generation, why: 'automatic Steward analysis is disabled by policy' };
    }
    return this.analyze(request);
  }

  /**
   * Manual trigger. An authorized Workspace member enters the Steward here and
   * nowhere else. Everything after authorization is the automatic path.
   */
  async requestAnalysis(input: { workspaceId: string; subjectTaskId: string; requestedByMemberId: string; at?: string }): Promise<StewardAnalysisOutcome> {
    const state = this.view.readState();
    const workspace = state.workspaces.find((item) => item.id === input.workspaceId);
    if (!workspace) throw new StewardError('not_found', 'workspace not found');
    const member = state.members.find((item) => item.id === input.requestedByMemberId && item.workspaceId === input.workspaceId);
    if (!member || !isAuthorizedRequester(member, workspace)) throw new StewardError('unauthorized', 'member is not authorized to request a Workspace Steward analysis');
    const subject = state.tasks.find((item) => item.id === input.subjectTaskId && item.workspaceId === input.workspaceId);
    if (!subject) throw new StewardError('not_found', 'subject task not found');
    const at = input.at ?? new Date().toISOString();
    return this.analyze({
      trigger: 'manual',
      workspaceId: input.workspaceId,
      subjectTaskId: subject.id,
      generation: subject.fence,
      progressSince: new Date(Date.parse(at) - this.policy.manualProgressWindowMs).toISOString(),
      requestedAt: at,
      requestedByMemberId: member.id,
    });
  }

  /**
   * The single Steward execution path. `onSupervisionBreach` and
   * `requestAnalysis` are thin adapters onto this method and hold no analysis
   * logic of their own, so the two triggers cannot drift apart.
   */
  private async analyze(request: StewardAnalysisRequest): Promise<StewardAnalysisOutcome> {
    for (const listener of [...this.executions]) listener(request);
    const key = analysisKeyOf(request.workspaceId, request.subjectTaskId, request.generation);
    const base = { key, trigger: request.trigger, workspaceId: request.workspaceId, subjectTaskId: request.subjectTaskId, generation: request.generation };
    const state = this.view.readState();

    const priorForKey = state.knowledge.find((entry) => entry.workspaceId === request.workspaceId && entry.tags.includes(analysisTag(key)));
    if (priorForKey) return { ...base, status: 'deduplicated', knowledgeId: priorForKey.id, eventId: eventIdFor(key), ...readReportFacts(priorForKey), why: 'an analysis already exists for this subject generation' };

    const priorForSubject = state.knowledge
      .filter((entry) => entry.workspaceId === request.workspaceId && entry.tags.includes(subjectTag(request.workspaceId, request.subjectTaskId)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (priorForSubject && Date.parse(request.requestedAt) - Date.parse(priorForSubject.createdAt) < this.policy.cooldownMs) {
      return { ...base, status: 'cooldown', knowledgeId: priorForSubject.id, ...readReportFacts(priorForSubject), why: `subject is inside the ${this.policy.cooldownMs}ms Steward cooldown` };
    }

    const workspace = state.workspaces.find((item) => item.id === request.workspaceId);
    const subject = state.tasks.find((item) => item.id === request.subjectTaskId && item.workspaceId === request.workspaceId);
    if (!workspace || !subject) throw new StewardError('not_found', 'workspace or subject task not found');

    const session = state.sessions
      .filter((item) => item.workspaceId === request.workspaceId && item.taskId === subject.id)
      .sort((a, b) => b.generation - a.generation)[0];
    const observed = session ? await this.view.observeSubject(session.id) : undefined;

    const materialProgress = materialProgressOf(state, subject, observed?.workSummary);
    const priorAnalyses = state.knowledge.filter((entry) => entry.workspaceId === request.workspaceId && entry.tags.includes(subjectTag(request.workspaceId, request.subjectTaskId)));
    const verdict = classify({ request, subject, session: observed?.session ?? session, observation: observed?.observation, materialProgress, priorAnalyses });

    const evidenceRefs = [
      subject.id,
      ...(session ? [session.id] : []),
      ...(request.breachEventId ? [request.breachEventId] : []),
      ...(session?.blockedOnEventId ? [session.blockedOnEventId] : []),
      ...materialProgress.refs,
    ];

    const dossier: StewardDossier = {
      key,
      request,
      workspace,
      subject,
      ...(observed?.session ?? session ? { session: observed?.session ?? session } : {}),
      ...(observed?.observation ? { observation: observed.observation } : {}),
      ...(observed?.workSummary ? { workSummary: observed.workSummary } : {}),
      materialProgress,
      evidenceRefs,
      classification: verdict.classification,
      recommendation: verdict.recommendation,
      why: verdict.why,
    };

    // Owner-selected provider only. A failure here is loud and leaves the
    // dedupe slot unused, so the analysis can be retried once Codex returns.
    const narrative = await this.analyst.analyze(dossier);
    // A production timeout or an uncited analysis is not a Steward report.
    // Keep the dedupe slot free so a later bounded run can retry.
    if (narrative.cited === false || !narrative.narrative) return { ...base, status: 'timeout', why: 'Steward analysis timed out or produced no cited Result' };

    const analysisRefs = [...evidenceRefs, ...(narrative.evidenceRefs ?? []), ...(narrative.runtimeSessionId ? [narrative.runtimeSessionId] : []), ...(narrative.analysisTaskId ? [narrative.analysisTaskId] : [])];
    const text = renderReport(dossier, narrative, analysisRefs);
    const report = await this.view.recordReport({
      workspaceId: request.workspaceId,
      authorMemberId: this.policy.stewardMemberId,
      kind: verdict.classification === 'HEALTHY' ? 'learning' : 'problem',
      text,
      tags: [
        STEWARD_REPORT_TAG,
        analysisTag(key),
        subjectTag(request.workspaceId, request.subjectTaskId),
        `trigger:${request.trigger}`,
        `classification:${verdict.classification}`,
        `recommendation:${verdict.recommendation}`,
        `provider:${narrative.provider}`,
        `model:${narrative.model}`,
      ],
      taskId: subject.id,
    });

    const event = await this.view.notifyManager({
      id: eventIdFor(key),
      workspaceId: request.workspaceId,
      taskId: subject.id,
      sourceMemberId: this.policy.stewardMemberId,
      summary: `Workspace Steward ${verdict.classification} on ${subject.id}: ${verdict.recommendation} (report ${report.id})`,
      evidenceRefs: [report.id, ...analysisRefs],
      urgency: verdict.recommendation === 'CONTINUE' ? 'normal' : 'urgent',
    });

    return {
      ...base,
      status: 'analyzed',
      knowledgeId: report.id,
      eventId: event.id,
      classification: verdict.classification,
      recommendation: verdict.recommendation,
      evidenceRefs: analysisRefs,
      ...(narrative.narrative ? { narrative: narrative.narrative } : {}),
      ...(narrative.runtimeSessionId ? { analysisRuntimeSessionId: narrative.runtimeSessionId } : {}),
      why: verdict.why,
    };
  }

  /** Every Steward report for one Workspace, newest first. Restart-safe by construction. */
  reports(workspaceId: string): Array<KnowledgeEntry & { classification?: StewardClassification; recommendation?: StewardRecommendation }> {
    return this.view.readState().knowledge
      .filter((entry) => entry.workspaceId === workspaceId && entry.tags.includes(STEWARD_REPORT_TAG))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((entry) => ({ ...entry, ...readReportFacts(entry) }));
  }
}

function isAuthorizedRequester(member: Member, workspace: ControlWorkspace): boolean {
  if (workspace.ownerMemberId === member.id) return true;
  if (['owner', 'manager', 'deputy'].includes(member.role)) return true;
  return member.capabilities.includes('request_steward_analysis');
}

function readReportFacts(entry: KnowledgeEntry): { classification?: StewardClassification; recommendation?: StewardRecommendation } {
  const classification = entry.tags.find((tag) => tag.startsWith('classification:'))?.slice('classification:'.length) as StewardClassification | undefined;
  const recommendation = entry.tags.find((tag) => tag.startsWith('recommendation:'))?.slice('recommendation:'.length) as StewardRecommendation | undefined;
  return { ...(classification ? { classification } : {}), ...(recommendation ? { recommendation } : {}) };
}

/**
 * Durable material progress for one subject Task.
 *
 * A stalled runtime records `state=running, lastTurnState=running`, exactly
 * like a healthy one, so liveness is deliberately not consulted here. Only
 * durable state changes count: Results, Knowledge, progress ChannelEvents and
 * observed commits.
 */
function materialProgressOf(state: State, subject: Task, workSummary?: WorkSummary): { latestAt?: string; refs: string[] } {
  const points: Array<{ at: string; ref: string }> = [];
  for (const result of state.results as Result[]) if (result.taskId === subject.id) points.push({ at: result.createdAt, ref: result.id });
  for (const entry of state.knowledge) if (entry.taskId === subject.id && !entry.tags.includes(STEWARD_REPORT_TAG)) points.push({ at: entry.createdAt, ref: entry.id });
  for (const event of state.channelEvents) if (event.taskId === subject.id && PROGRESS_EVENT_KINDS.has(event.kind)) points.push({ at: event.createdAt, ref: event.id });
  const commit = workSummary?.latestCommit;
  if (commit && Number.isFinite(Date.parse(commit.time))) points.push({ at: new Date(commit.time).toISOString(), ref: commit.sha });
  points.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { ...(points[0] ? { latestAt: points[0].at } : {}), refs: points.slice(0, 8).map((point) => point.ref) };
}

function classify(input: {
  request: StewardAnalysisRequest;
  subject: Task;
  session?: RuntimeSession;
  observation?: RuntimeObservation;
  materialProgress: { latestAt?: string };
  priorAnalyses: KnowledgeEntry[];
}): { classification: StewardClassification; recommendation: StewardRecommendation; why: string } {
  const { subject, session, observation, materialProgress, request } = input;
  if (session && (session.state === 'transport_indeterminate' || observation?.freshness === 'unavailable' || observation?.health === 'unavailable')) {
    return { classification: 'TRANSPORT_INDETERMINATE', recommendation: 'OWNER_DECISION', why: `runtime ${session.id} cannot be observed, so progress cannot be established either way` };
  }
  if (TERMINAL_TASK_LIFECYCLES.has(subject.lifecycle)) {
    return { classification: 'HEALTHY', recommendation: 'PARK', why: `subject task is ${subject.lifecycle}; there is nothing left to supervise` };
  }
  // Lane C's durable blocked-on-decision record is the canonical representation
  // of a runtime parked on an unanswered question. It lives in session fields
  // rather than session.state precisely because observe() overwrites state, so
  // it must be read here; a blocked runtime is not a stalled one.
  if (session?.blockedOnEventId) {
    return { classification: 'DEGRADED', recommendation: 'OWNER_DECISION', why: `runtime ${session.id} is blocked on unanswered decision ${session.blockedOnEventId} since ${session.blockedSince ?? 'an unrecorded time'}; only the Owner/Deputy can clear it` };
  }
  const attention = session?.state === 'attention' || observation?.attention === true || (typeof observation?.pendingPermissions === 'number' && observation.pendingPermissions > 0);
  if (attention) {
    return { classification: 'DEGRADED', recommendation: 'STEER', why: 'runtime is waiting on attention or a pending permission, which is a known and steerable cause' };
  }
  const progressed = Boolean(materialProgress.latestAt) && Date.parse(materialProgress.latestAt!) >= Date.parse(request.progressSince);
  if (!progressed) {
    const repeated = input.priorAnalyses.some((entry) => entry.tags.includes('classification:STUCK'));
    return {
      classification: 'STUCK',
      recommendation: repeated ? 'REASSIGN' : 'STEER',
      why: materialProgress.latestAt
        ? `no durable material progress since ${request.progressSince}; the newest durable progress is ${materialProgress.latestAt}`
        : `no durable material progress has ever been recorded for ${subject.id}`,
    };
  }
  return { classification: 'HEALTHY', recommendation: 'CONTINUE', why: `durable material progress at ${materialProgress.latestAt} is at or after ${request.progressSince}` };
}

function renderReport(dossier: StewardDossier, narrative: StewardNarrative, refs: string[]): string {
  const lines = [
    `Workspace Steward report ${dossier.key}`,
    `trigger=${dossier.request.trigger}${dossier.request.breachReason ? ` breach=${dossier.request.breachReason}` : ''}${dossier.request.requestedByMemberId ? ` requestedBy=${dossier.request.requestedByMemberId}` : ''}`,
    `classification=${dossier.classification} recommendation=${dossier.recommendation}`,
    `why: ${dossier.why}`,
    `analysis provider=${narrative.provider} model=${narrative.model}${narrative.thinking ? ` thinking=${narrative.thinking}` : ''}`,
    `subject task=${dossier.subject.id} lifecycle=${dossier.subject.lifecycle} fence=${dossier.subject.fence}`,
    `runtime=${dossier.session?.id ?? 'none'} state=${dossier.session?.state ?? 'none'} lastTurnState=${dossier.session?.lastTurnState ?? 'none'}`,
    `durable material progress=${dossier.materialProgress.latestAt ?? 'none'} required since ${dossier.request.progressSince}`,
    `evidence: ${refs.join(' ')}`,
    narrative.narrative ? `analysis: ${narrative.narrative}` : 'analysis: narrative unavailable from the Steward runtime within its bound; the classification above is derived from durable facts',
    'The Steward advises only. Manager/Deputy retains authority and this report mutates no product work.',
  ];
  return lines.join('\n');
}

/**
 * Build the Steward's narrow view over a full ArcpService. The Steward never
 * receives the service itself, so it cannot reach claimTask, submitResult,
 * deliver, launch or stop.
 */
export function stewardViewOf(service: {
  state(): State;
  runtimeStatus(id: string, refresh?: boolean): Promise<{ session: RuntimeSession; observation: RuntimeObservation; workSummary: WorkSummary }>;
  addKnowledge(input: { workspaceId: string; authorMemberId: string; kind: KnowledgeEntry['kind']; text: string; tags?: string[]; taskId?: string }): Promise<KnowledgeEntry>;
  publishChannelEvent(input: Record<string, unknown>): Promise<ChannelEvent>;
}): StewardWorkspaceView {
  return {
    readState: () => service.state(),
    observeSubject: async (sessionId) => {
      try { return await service.runtimeStatus(sessionId, true); } catch { return undefined; }
    },
    recordReport: (input) => service.addKnowledge(input),
    notifyManager: (input) => service.publishChannelEvent({
      id: input.id,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      sourceMemberId: input.sourceMemberId,
      targetRole: 'manager',
      kind: 'finding',
      urgency: input.urgency,
      decisionRequired: false,
      summary: input.summary,
      evidenceRefs: input.evidenceRefs,
    }),
  };
}

type StewardRuntimeService = {
  preflight(input: { profileId: string }): Promise<ActionResult>;
  startManaged(input: { actorId: string; workspaceId: string; title: string; profileId: string; role?: string; taskScope?: 'product' | 'steward_analysis' }): Promise<ActionResult | { task: Task; session: RuntimeSession; member: Member }>;
  stopRuntime(id: string): Promise<RuntimeSession>;
  state(): State;
};

/**
 * The production Steward analyst: an ephemeral runtime on the owner-selected
 * profile. It refuses to run on anything else, and it always stops the runtime
 * it started, because there is no always-on Steward.
 */
export class CodexRuntimeAnalyst implements StewardAnalyst {
  constructor(
    private readonly service: StewardRuntimeService,
    private readonly options: { profileId: string; actorId: string; waitMs: number; pollMs?: number; sleep?: (ms: number) => Promise<void> },
  ) {}
  get profileId(): string { return this.options.profileId; }

  async analyze(dossier: StewardDossier): Promise<StewardNarrative> {
    const preflight = await this.service.preflight({ profileId: this.options.profileId });
    if (!preflight.launchable) throw new StewardProviderUnavailableError(`Steward profile ${this.options.profileId} is not live-validated: ${preflight.why}`);
    if (preflight.profileId !== this.options.profileId) throw new StewardProviderUnavailableError(`preflight resolved profile ${preflight.profileId} instead of the configured ${this.options.profileId}`);
    const substituted = (['provider', 'model', 'mode', 'thinking'] as const).find((field) => preflight.requested[field] !== preflight.effective[field]);
    if (substituted) throw new StewardProviderUnavailableError(`Steward provider substitution refused: ${substituted} ${String(preflight.requested[substituted])} would become ${String(preflight.effective[substituted])}`);

    const started = await this.service.startManaged({ actorId: this.options.actorId, workspaceId: dossier.workspace.id, title: analysisBrief(dossier), profileId: this.options.profileId, role: 'steward-analyst', taskScope: 'steward_analysis' });
    if ('action' in started) throw new StewardProviderUnavailableError(`Steward runtime was held: ${started.why}`);
    const { session, task } = started;
    try {
      if (session.provider !== preflight.requested.provider || session.model !== preflight.requested.model) {
        throw new StewardProviderUnavailableError(`Steward runtime launched as ${session.provider}/${session.model} instead of ${preflight.requested.provider}/${preflight.requested.model}`);
      }
      const narrative = await this.awaitNarrative(task.id, session.memberId);
      return {
        ...(narrative ? { narrative: narrative.summary, cited: true, evidenceRefs: narrative.evidenceRefs } : { cited: false }),
        provider: session.provider,
        model: session.model,
        ...(session.thinking ? { thinking: session.thinking } : {}),
        runtimeSessionId: session.id,
        analysisTaskId: task.id,
      };
    } finally {
      await this.service.stopRuntime(session.id).catch(() => undefined);
    }
  }

  private async awaitNarrative(taskId: string, memberId?: string): Promise<{ summary: string; evidenceRefs: string[] } | undefined> {
    const pollMs = this.options.pollMs ?? 500;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()));
    const deadline = Date.now() + this.options.waitMs;
    for (;;) {
      const result = this.service.state().results.find((item) => item.taskId === taskId);
      if (result?.status === 'candidate' && result.evidenceRefs.length > 0 && result.memberId === memberId) return { summary: result.summary, evidenceRefs: result.evidenceRefs };
      if (Date.now() >= deadline) return undefined;
      await sleep(pollMs);
    }
  }
}

export function analysisBrief(dossier: StewardDossier): string {
  const arcpScript = fileURLToPath(new URL('../../scripts/arcp', import.meta.url));
  const nodeArcp = (...args: string[]) => [process.execPath, arcpScript, ...args].map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
  const contextCommand = nodeArcp('workspace', 'context', dossier.workspace.id);
  const claimCommand = nodeArcp('task', 'claim', '<analysis-task-id>', '--expected-fence', '0');
  const resultCommand = nodeArcp('result', 'submit', dossier.workspace.id, '--task', '<analysis-task-id>', '--summary', '<analysis>', '--expected-fence', '1', '--evidence', dossier.evidenceRefs.join(','));
  return [
    `Workspace Steward analysis ${dossier.key}.`,
    `You are an ephemeral, read-only Steward. Do not claim, steer or mutate any product work; report only.`,
    `Subject task ${dossier.subject.id} lifecycle=${dossier.subject.lifecycle} fence=${dossier.subject.fence}.`,
    `Runtime ${dossier.session?.id ?? 'none'} state=${dossier.session?.state ?? 'none'}.`,
    `Durable material progress ${dossier.materialProgress.latestAt ?? 'none'}, required since ${dossier.request.progressSince}.`,
    `ARCP already classified this ${dossier.classification} with recommendation ${dossier.recommendation} because ${dossier.why}.`,
    'Read the Workspace with the packaged command "' + contextCommand + '". The runtime handoff supplies your own analysis Task id; claim it with "' + claimCommand + '". Submit one cited Result whose summary is the analysis narrative confirming or disputing that classification with "' + resultCommand + '" using evidence refs ' + dossier.evidenceRefs.join(' ') + '.',
  ].join(' ');
  /*
    `Read the Workspace with the packaged command \`${nodeArcp('workspace', 'context', dossier.workspace.id)}\`. The runtime handoff supplies your own analysis Task id; claim it with \`${nodeArcp('task', 'claim', '<analysis-task-id>', '--expected-fence', '0')}\`. Submit one cited Result whose summary is the analysis narrative confirming or disputing that classification with \`${nodeArcp('result', 'submit', dossier.workspace.id, '--task', '<analysis-task-id>', '--summary', '<analysis>', '--expected-fence', '1', '--evidence', dossier.evidenceRefs.join(',')}\` using evidence refs ${dossier.evidenceRefs.join(' ')}.`,
  ].join(' ');
  */
}
