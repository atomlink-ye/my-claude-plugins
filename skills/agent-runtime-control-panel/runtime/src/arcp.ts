import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaseoCli, asRecord } from './cli.js';
import { createPaseoClient } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';
import { HermesAcpAdapter, type SafePointEvent } from './hermes-acp.js';
import { SQLiteStateStore, type StateStore } from './state-store.js';
import { contentAddress, normalizeChannelEvent } from './content.js';
import { projectChannelEvent, type ChannelProjection, type ChannelProjectionFacts } from './channel-projection.js';
import { renderChannelMarkdown, type ChannelMarkdownOptions } from './channel-markdown.js';
import { projectTemporal, temporalReconciliationPreview, type TemporalFilter, type TemporalProjection, type TemporalProjectionFacts } from './temporal-projection.js';
export { projectChannelEvent, renderChannelCard, channelCardFor } from './channel-projection.js';
export { renderChannelMarkdown, escapeMarkdown, escapeCode } from './channel-markdown.js';
export type { ChannelProjection, ChannelProjectionFacts, ChannelProjectionRef } from './channel-projection.js';
export type { ChannelMarkdownOptions } from './channel-markdown.js';
export { projectTemporal, temporalReconciliationPreview } from './temporal-projection.js';
export type { TemporalFilter, TemporalProjection, TemporalProjectionFacts, TemporalCard, TemporalDisposition } from './temporal-projection.js';
import { evaluateSupervision, materialProgressAt, supervisionPolicyId, supervisionSignalId, type SupervisionPolicy, type SupervisionReview, type SupervisionSignal, type SupervisionSignalKind, type SupervisionView } from './supervision.js';
import { CodexRuntimeAnalyst, WorkspaceSteward, stewardViewOf } from './steward.js';
import { ActorChannelRegistry, type ActorChannelAdapter, type ChannelBindingRef, type TransportReceipt } from './actor-channel.js';
import { collectCodexbar, collectPiGrokCache, evaluateAdmission, matchesModel, runCommandCollector, translatePaseoProviderUsage, type AdmissionDecision, type ProviderBudgetConfig, type ProviderBudgetEnvelopeV1, type ProviderBudgetSource } from './provider-budget.js';
import { RuntimeBudgetTracker, type RuntimeBudgetPolicy, type RuntimeBudgetSample, type RuntimeBudgetSignal, type RuntimeBudgetView } from './runtime-budget.js';
import { checkoutIdentity, surfaceName, type CheckoutRef, type ExecutionPlacementPort, type ExecutionSurface, type ExecutionSurfaceBinding, type ExecutionSurfaceKind, type ExecutionSurfaceRef, type RepositoryLocator, type RepositoryRef, type RuntimeBinding, type RuntimeBindingReceipt, type RuntimeBindingRef, type RuntimeLaunchSpec, type SurfaceArchiveAuthorization, type SurfaceClaim, type SurfaceRestoreEvidence, type SurfaceRestoreReceipt, type SurfaceSpec } from './execution-placement.js';
export { PROVIDER_BUDGET_SCHEMA, validateProviderBudgetEnvelope, evaluateAdmission, collectCodexbar, collectPiGrokCache, runCommandCollector, translatePaseoProviderUsage } from './provider-budget.js';
export type { AdmissionDecision, ProviderBudgetBinding, ProviderBudgetConfig, ProviderBudgetEnvelopeV1, ProviderBudgetPolicy, ProviderBudgetSource, ProviderBudgetSourceTrust } from './provider-budget.js';
export { RuntimeBudgetTracker, validateRuntimeBudgetSample } from './runtime-budget.js';
export type { RuntimeBudgetPolicy, RuntimeBudgetSample, RuntimeBudgetSignal, RuntimeBudgetView, WakeCategory } from './runtime-budget.js';
export type { CheckoutRef, ExecutionPlacementPort, ExecutionSurface, ExecutionSurfaceBinding, ExecutionSurfaceKind, ExecutionSurfaceRef, RepositoryLocator, RepositoryRef, RuntimeBinding, RuntimeBindingReceipt, RuntimeBindingRef, SurfaceArchiveAuthorization, SurfaceClaim, SurfaceRestoreEvidence, SurfaceRestoreReceipt, SurfaceSpec } from './execution-placement.js';
export type { StateStore } from './state-store.js';
export { DURABLE_PROGRESS_EVENT_KINDS, NON_PROGRESS_EVENT_KINDS, SUPERVISED_LIFECYCLES, evaluateSupervision, materialProgressAt } from './supervision.js';
export type { SupervisionBreach, SupervisionPolicy, SupervisionReview, SupervisionSignal, SupervisionView } from './supervision.js';

export type GoalState = 'active' | 'completed' | 'cancelled';
export type SessionState = 'launching' | 'running' | 'idle' | 'terminal' | 'attention' | 'placement_mismatch' | 'transport_indeterminate';
export type DeliveryState = 'queued' | 'held' | 'waiting_safe_point' | 'attempting' | 'delivered' | 'running' | 'processed' | 'acknowledged' | 'transport_indeterminate' | 'withdrawn';
/** A Goal Contract is the authoritative scope a runtime must hold before it
 * acts. It is bound in the launch itself; a contract that arrives as a later
 * delivery is fail-closed, never silently applied to a runtime that has acted. */
export type DeliveryPurpose = 'contract' | 'message';
/** The Task and fence a contract delivery is authoritative for. */
export interface DeliverySubject { taskId: string; fence: number; }
/** Urgency controls surfacing; it never changes what the recipient owes. */
export type ChannelPriority = 'normal' | 'important' | 'critical';
export type ConsumptionPolicy = 'consume_on_delivery' | 'ack_required' | 'decision_required';
export type ConsumptionState = 'open' | 'deferred' | 'consumed' | 'resolved' | 'withdrawn' | 'invalidated';
export interface ExpectedAction { kind: 'none' | 'ack' | 'resolve'; instruction: string; accountableRole?: string; deadlineAt?: string; }
export type RecipientDisposition =
  | { kind: 'ack'; reason: string }
  | { kind: 'defer'; reason: string; resume: { kind: 'at'; at: string } | { kind: 'after'; delayMs: number } | { kind: 'event'; eventId: string } | { kind: 'manual' } }
  | { kind: 'resolve'; verdict: DecisionVerdict; reason: string }
  | { kind: 'reroute'; reason: string; toMemberId: string };
export type RecipientDispositionReceipt = RecipientDisposition & { id: string; actorMemberId: string; targetGeneration?: number; at: string; nextVisibleAt?: string; };
export interface ChannelDeferralPolicy { maxDeferrals: number; maxDeferredMs: number; allowCriticalDeferral?: boolean; }

export interface Actor { id: string; clientIdentity: string; label: string; createdAt: string; }
export interface ActorBinding { id: string; actorId: string; channel: 'hermes' | 'local'; profileRef?: string; conversationRef?: string; generation: number; createdAt: string; }
export interface Goal { id: string; actorId: string; title: string; workspaceId?: string; state: GoalState; createdAt: string; updatedAt: string; }
export type DecisionVerdict = 'accept' | 'refuse';
export type ChannelEventKind = 'decision_required' | 'decision_resolved' | 'task_claimed' | 'task_candidate' | 'task_completed' | 'task_failed' | 'task_unknown' | 'phase_progress' | 'phase_completed' | 'blocker' | 'finding' | 'permission' | 'attention' | 'runtime_health' | 'transport_uncertainty' | 'material_progress' | 'workspace_analysis_required';
export interface ChannelEventContent { summary: string; evidenceRefs: string[]; contentHash: string; sensitivity: 'normal' | 'sensitive'; retention: 'standard' | 'bounded'; }
export interface ChannelTransition { state: 'queued' | 'delivered' | 'processed' | 'acknowledged' | 'transport_indeterminate' | 'undeliverable' | 'withdrawn'; at: string; }
export interface ChannelEvent { id: string; workspaceId?: string; goalId?: string; taskId?: string; resultId?: string; sourceMemberId?: string; sourceActorId?: string; targetMemberId?: string; targetActorId?: string; targetRole?: string; targetSubscription?: string; semanticKey?: string; reroutedToMemberId?: string; kind: ChannelEventKind; urgency: 'normal' | 'urgent'; priority: ChannelPriority; consumptionPolicy: ConsumptionPolicy; consumptionState: ConsumptionState; expectedAction: ExpectedAction; dispositions: RecipientDispositionReceipt[]; nextVisibleAt?: string; dependencyEventId?: string; decisionRequired: boolean; content: ChannelEventContent; deliveryState: ChannelTransition['state']; transitions: ChannelTransition[]; createdAt: string; deliveredAt?: string; processedAt?: string; acknowledgedAt?: string; consumedAt?: string; resolvedAt?: string; undeliverableReason?: string; relatedEventId?: string; verdict?: DecisionVerdict; decisionOptions?: string[]; }
type ChannelEventInput = { id?: string; workspaceId?: string; goalId?: string; taskId?: string; resultId?: string; sourceMemberId?: string; sourceActorId?: string; targetMemberId?: string; targetActorId?: string; targetRole?: string; targetSubscription?: string; semanticKey?: string; kind: ChannelEventKind; urgency: 'normal' | 'urgent'; priority?: ChannelPriority; consumptionPolicy: ConsumptionPolicy; expectedAction?: ExpectedAction; decisionRequired: boolean; summary: string; evidenceRefs: string[]; relatedEventId?: string; verdict?: DecisionVerdict; decisionOptions?: string[]; notify?: boolean };
export interface PaseoPlacement { requested: { projectId?: string; workspaceId?: string; agentId?: string }; observed?: { projectId?: string; workspaceId?: string; agentId?: string; lifecycle?: string }; status?: 'PLACEMENT_MATCH' | 'PLACEMENT_MISMATCH'; unresolved?: string; }
/** A durable Paseo execution surface.  A ControlWorkspace may have one for
 * each checkout, while agents remain Tabs inside that surface. */
export interface CanonicalPaseoPlacement { checkout: string; projectId: string; workspaceId: string; }
export interface RuntimeLaunchContext { workspaceId?: string; paseoProjectId?: string; paseoWorkspaceId?: string; taskId?: string; memberId?: string; runtimeId?: string; memberCredential?: string; clientStatePath?: string; contract?: string; reportingRoute?: ReportingRoute; taskHandoff?: boolean; }
/** Who a launched runtime reports to, recorded at launch and independent of
 * transport delivery. The primary handler alone owns acknowledgement and
 * action; cc recipients observe and must never create a second obligation. */
export interface ReportingRoute { launchedByMemberId?: string; primaryHandlerMemberId?: string; ccMemberIds: string[]; escalationMemberIds: string[]; }
export interface RuntimeSession { id: string; actorId: string; goalId: string; taskId?: string; reportingRoute?: ReportingRoute; executionSurfaceId?: string; bindingId: string; generation: number; runtimeKind: 'paseo' | 'external'; adapterId: string; workspaceId?: string; memberId?: string; profileId: string; provider: string; model: string; mode?: string; thinking?: string; selectionReceipt?: SelectionReceipt; observed?: Partial<RuntimeSettings>; placement?: PaseoPlacement; workspace?: string; externalId?: string; acpSessionId?: string; pid?: number; lastDeliveryId?: string; lastTurnState?: string; blockedOnEventId?: string; blockedSince?: string; blockedQuestion?: string; state: SessionState; lastObservedAt?: string; createdAt: string; }
export interface Delivery { id: string; fromActorId: string; runtimeSessionId: string; generation: number; body: string; command: 'normal' | 'interrupt'; purpose?: DeliveryPurpose; subject?: DeliverySubject; notAfter?: string; refusedReason?: string; handedOffAfterWithdrawal?: boolean; reason?: string; eventId?: string; consumptionEpisode?: number; state: DeliveryState; createdAt: string; cacheAuthorized?: true; safePointObservedAt?: string; safePointStatus?: string; attemptedAt?: string; deliveredAt?: string; processedAt?: string; acknowledgedAt?: string; }
export interface ControlWorkspace { id: string; purpose: string; lifecycle: 'active' | 'completed' | 'cancelled'; ownerActorId: string; ownerMemberId?: string; paseoPlacements?: CanonicalPaseoPlacement[]; channelDeferralPolicy?: ChannelDeferralPolicy; createdAt: string; updatedAt: string; }
export interface Member { id: string; workspaceId: string; actorId?: string; joinKind: 'managed' | 'native'; label: string; role: string; capabilities: string[]; lifecycle: 'invited' | 'joining' | 'active' | 'idle' | 'busy' | 'attention' | 'offline' | 'retired'; leaseExpiresAt?: string; lastHeartbeatAt?: string; createdAt: string; updatedAt: string; }
export type TaskScope = 'product' | 'steward_analysis';
export interface Task { id: string; workspaceId: string; title: string; lifecycle: 'proposed' | 'ready' | 'claimed' | 'running' | 'waiting' | 'candidate' | 'completed' | 'failed' | 'unknown' | 'cancelled'; ownerMemberId?: string; executionSurfaceId?: string; fence: number; createdAt: string; updatedAt: string; scope?: TaskScope; }
export interface KnowledgeEntry { id: string; workspaceId: string; authorMemberId: string; kind: 'problem' | 'learning' | 'decision' | 'evidence' | 'runbook' | 'blocker'; text: string; tags: string[]; taskId?: string; goalId?: string; createdAt: string; }
export interface Result { id: string; workspaceId: string; taskId: string; memberId: string; fence: number; status: 'candidate' | 'failed' | 'unknown'; summary: string; evidenceRefs: string[]; sourceId?: string; createdAt: string; }
export interface RuntimeSettings { provider: string; model: string; mode?: string; thinking?: string; }
export type SelectionExplanation = {
  roleIntent: string;
  selection: 'explicit-settings' | 'named-profile' | 'role-intent' | 'default-profile';
  selectedProfile: Pick<Profile, 'id' | 'provider' | 'model' | 'mode' | 'thinking' | 'role'>;
  alternatives: Array<Pick<Profile, 'id' | 'provider' | 'model' | 'mode' | 'thinking' | 'role'> & { reason: string }>;
};
/** The durable account of an ARCP provider choice. `quotaSnapshot` is the
 * exact provider-budget evidence available when ARCP made the choice. */
export type SelectionReceipt = { chosenRole: string; provider: string; model: string; thinking: string | null; mode: string | null; reason: string; quotaSnapshot: ProviderBudgetEnvelopeV1 | null; };
export interface ActionResult { action: 'launch' | 'route' | 'hold' | 'warn'; launchable: boolean; why: string; requested: RuntimeSettings; effective: RuntimeSettings; profileId: string; routingGuidance: string; selection: SelectionExplanation; selectionReceipt: SelectionReceipt; recommendedCommands: string[]; liveModes: string[]; admission?: AdmissionDecision; runtimeSignals?: RuntimeBudgetSignal[]; }
export interface RuntimeObservation { status: SessionState; activeTurn: boolean | 'unknown'; usage: { input: number | 'unknown'; cached: number | 'unknown'; output: number | 'unknown' }; context: { used: number | 'unknown'; max: number | 'unknown'; ratio: number | 'unknown'; quality: 'observed' | 'reported' | 'estimated' | 'unavailable' }; pendingPermissions: number | 'unknown'; attention: boolean | 'unknown'; attentionWhy?: string; compaction: { count: number | 'unknown'; status: 'completed' | 'loading' | 'none' | 'unavailable'; lastAt?: string }; cache: { activityAt?: string; ageMinutes: number | 'unknown'; state: 'fresh' | 'expiring' | 'expired' | 'unknown' }; burn: RuntimeBudgetView; lastObservedAt?: string; freshness: 'fresh' | 'stale' | 'unavailable' | 'unknown'; health: 'healthy' | 'degraded' | 'attention' | 'unavailable' | 'unknown'; requested: RuntimeSettings; observed: Partial<RuntimeSettings>; mismatch: boolean; }
export interface ManagedChild { id: string; provider?: string; title?: string; status: string; createdAt?: string; updatedAt?: string; source: 'paseo_parent' | 'provider_subagents'; }
export interface ChildObservation { source: 'provider_subagents' | 'paseo_parent' | 'unavailable' | 'none'; items: ManagedChild[]; }
export interface WorkSummary { latestCommit?: { sha: string; subject: string; time: string }; dirty: boolean | 'unknown'; diffstat: { files: number; insertions: number; deletions: number } | 'unknown'; }
export interface RuntimeAdapter {
  readonly adapterId: string;
  discover(): Promise<{ value: unknown; stdout: string; stderr: string }>;
  models(provider: string): Promise<{ value: unknown; stdout: string; stderr: string }>;
  modes(provider: string): Promise<string[] | undefined>;
  launch(profile: Profile, goalTitle: string, workspace?: string, context?: RuntimeLaunchContext): Promise<{ value: unknown; stdout: string; stderr: string }>;
  observe(externalId: string): Promise<{ value: unknown; stdout: string; stderr: string }>;
  snapshot(externalId: string): Promise<{ agent: Record<string, any>; timeline: unknown[]; source: 'sdk' | 'cli' }>;
  registry(): Promise<{ value: unknown; stdout: string; stderr: string }>;
  providerSubagents(parentAgentId: string): Promise<ChildObservation>;
  startTurn(externalId: string, body: string, deliveryId: string): Promise<unknown>;
  interrupt(externalId: string, body: string): Promise<unknown>;
  stop(externalId: string): Promise<unknown>;
}
interface Confirmation { tokenHash: string; kind: 'interrupt' | 'cache'; actorId: string; runtimeSessionId: string; generation: number; reason?: string; activeTurn: string; childSet: string; activityAt?: string; expiresAt: string; }
export interface State { actors: Actor[]; bindings: ActorBinding[]; credentials: Record<string, string>; workspaces: ControlWorkspace[]; members: Member[]; memberCredentials: Record<string, string>; tasks: Task[]; knowledge: KnowledgeEntry[]; results: Result[]; goals: Goal[]; sessions: RuntimeSession[]; deliveries: Delivery[]; channelEvents: ChannelEvent[]; confirmations: Confirmation[]; supervisionPolicies: SupervisionPolicy[]; supervisionReviews: SupervisionReview[]; supervisionSignals: SupervisionSignal[]; executionSurfaces: ExecutionSurface[]; surfaceClaims: SurfaceClaim[]; runtimeBindings: RuntimeBinding[]; }

const empty = (): State => ({ actors: [], bindings: [], credentials: {}, workspaces: [], members: [], memberCredentials: {}, tasks: [], knowledge: [], results: [], goals: [], sessions: [], deliveries: [], channelEvents: [], confirmations: [], supervisionPolicies: [], supervisionReviews: [], supervisionSignals: [], executionSurfaces: [], surfaceClaims: [], runtimeBindings: [] });
export const CLAUDE_CACHE_DEFAULTS = { expiringMinutes: 55, expiredMinutes: 60 } as const;
export const DEFAULT_SUPERVISION_COOLDOWN_MS = 900_000;
// codex-full-access is Codex Terra medium at mode full-access: it never blocks
// on a CodexBash approval prompt. An unattended Steward must never be handed a
// profile whose mode can prompt for permission (R3-B-D01/D02).
export const DEFAULT_STEWARD_PROFILE_ID = 'codex-full-access';
// The role an ephemeral Steward analysis Task/Runtime's managed member joins
// under. Supervision excludes any Task owned by a member with this role, so
// the Steward's own bookkeeping Task can never recurse into another breach.
export const STEWARD_ANALYSIS_ROLE = 'steward-analyst';
const idFor = (prefix: string, value: string) => `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
export const providerBudgetEpisodeKey = (workspaceId: string, providerId: string, windowIds: readonly string[], resetsAt?: string) => `provider-budget:${workspaceId}:${providerId}:${[...windowIds].sort().join(',')}:${resetsAt ?? 'unknown'}`;
const now = () => new Date().toISOString();
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const DEFAULT_CHANNEL_DEFERRAL_POLICY: ChannelDeferralPolicy = { maxDeferrals: 3, maxDeferredMs: 24 * 60 * 60 * 1000 };
/** Runtime compatibility only: typed producers must supply a policy, while
 * pre-contract persisted/direct callers receive the conservative legacy map. */
const legacyPolicyFor = (input: Pick<ChannelEventInput, 'kind' | 'decisionRequired'>): ConsumptionPolicy =>
  input.kind === 'decision_required' || input.decisionRequired && input.kind === 'permission' ? 'decision_required'
    : input.decisionRequired || ['blocker', 'attention', 'runtime_health', 'transport_uncertainty'].includes(input.kind) ? 'ack_required'
      : 'consume_on_delivery';
const priorityFor = (input: Pick<ChannelEventInput, 'urgency'>): ChannelPriority => input.urgency === 'urgent' ? 'important' : 'normal';
const expectedActionFor = (policy: ConsumptionPolicy, targetRole?: string): ExpectedAction => policy === 'consume_on_delivery'
  ? { kind: 'none', instruction: 'No reply required — this message is consumed when delivered.', ...(targetRole ? { accountableRole: targetRole } : {}) }
  : policy === 'ack_required'
    ? { kind: 'ack', instruction: 'ACK after handling, or defer with a reason if blocked.', ...(targetRole ? { accountableRole: targetRole } : {}) }
    : { kind: 'resolve', instruction: 'Resolve with an accept or refuse verdict and a reason.', ...(targetRole ? { accountableRole: targetRole } : {}) };
const boundedReason = (value: string, field = 'reason'): string => {
  const result = value.trim();
  if (!result || result.length > 240) throw new ArcpError('invalid_request', `${field} is required and must be at most 240 characters`, field);
  return result;
};
export const PASEO_TITLE_LIMIT = 200;
function unicodePrefix(value: string, limit: number): string { let result = ''; for (const character of value) { if (result.length + character.length > limit) break; result += character; } return result; }
/** Paseo tabs need a concise human label; the full Goal remains durable ARCP state and prompt content. */
export function paseoTitle(role: string, goalTitle: string): string {
  const roleLabel = unicodePrefix(role.trim().toUpperCase() || 'AGENT', 40);
  const prefix = `${roleLabel} · `;
  const goalLabel = goalTitle.trim().replace(/\s+/g, ' ') || 'Untitled goal';
  return `${prefix}${unicodePrefix(goalLabel, PASEO_TITLE_LIMIT - prefix.length)}`;
}
function isPaseoTitleRejected(error: unknown): boolean { const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase(); return message.includes('agent_create_failed') && (message.includes('too_big') || message.includes('maximum 200') || message.includes('config.title')); }
/** Resolve the packaged CLI from the runtime module, in both src and dist. */
export const packagedArcpCommand = (...args: string[]): string => [process.execPath, fileURLToPath(new URL('../../scripts/arcp', import.meta.url)), ...args].map(shellQuote).join(' ');

/**
 * Resolve whether a member is an intended event target. Owners can act on
 * every event in their workspace; authors get read visibility for their own
 * events, but do not gain acknowledgement or decision authority from authorship.
 */
function intendedTarget(event: ChannelEvent, member: Member, workspace: ControlWorkspace | undefined, visibilityOnly = false): boolean {
  if (workspace?.ownerMemberId === member.id) return true;
  if (visibilityOnly && (event.sourceMemberId === member.id || (event.sourceActorId !== undefined && event.sourceActorId === member.actorId))) return true;
  return (!event.reroutedToMemberId || event.reroutedToMemberId === member.id)
    && (!event.targetMemberId || event.targetMemberId === member.id)
    && (!event.targetActorId || event.targetActorId === member.actorId)
    && (!event.targetRole || event.targetRole === member.role)
    && (!event.targetSubscription || event.targetSubscription === '*' || event.targetSubscription === member.role || member.capabilities.includes(event.targetSubscription));
}

/** The durable records the one canonical projection builder is allowed to read. */
function projectionFacts(state: State): ChannelProjectionFacts {
  return { members: state.members, tasks: state.tasks, goals: state.goals, knowledge: state.knowledge, results: state.results, channelEvents: state.channelEvents };
}

/**
 * Whether human surfaces may use `<details>`. A Feishu-like target that cannot
 * expand a collapsible block sets `ARCP_CHANNEL_DETAILS=0` and gets the same
 * card with a plain final references list; nothing actionable moves.
 */
function markdownOptions(): ChannelMarkdownOptions {
  return { details: process.env.ARCP_CHANNEL_DETAILS !== '0' };
}

/** A durable event plus its canonical human projection and rendering. */
export type ProjectedChannelEvent = ChannelEvent & { projection: ChannelProjection; markdown: string };

/** A queued delivery plus the projection of the event that produced it. */
export type ProjectedDelivery = Delivery & { projection?: ChannelProjection; markdown?: string };
export interface ProjectedInboxItem {
  eventId: string;
  consumptionState: Extract<ConsumptionState, 'open' | 'deferred'>;
  facet: 'due' | 'deferred' | 'waiting_dependency' | 'manual';
  nextVisibleAt?: string;
  dependencyEventId?: string;
  deliveries: ProjectedDelivery[];
  projection: ChannelProjection;
  markdown: string;
  /** Compatibility convenience for delivery-oriented callers. */
  body?: string;
}

/** A compact, independently durable ARCP state file. It intentionally stores public IDs and
 * metadata only: provider handles, prompts, credentials, and host paths never enter it. */
export class ArcpStore implements StateStore {
  private state: State = empty();
  private write: Promise<unknown> = Promise.resolve();
  readonly file: string;
  constructor(dir: string) { this.file = path.join(dir, 'arcp-state.json'); }
  async init(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<State>;
      const legacyEvents = ((parsed as any).channelEvents ?? []) as Array<Record<string, unknown>>; const channelEvents = legacyEvents.map(normalizeChannelEvent);
      this.state = { actors: parsed.actors ?? [], bindings: parsed.bindings ?? [], credentials: parsed.credentials ?? {}, workspaces: parsed.workspaces ?? [], members: parsed.members ?? [], memberCredentials: parsed.memberCredentials ?? {}, tasks: parsed.tasks ?? [], knowledge: parsed.knowledge ?? [], results: parsed.results ?? [], goals: parsed.goals ?? [], sessions: (parsed.sessions ?? []).map((item) => ({ ...item, runtimeKind: item.runtimeKind ?? 'paseo', adapterId: item.adapterId ?? 'paseo' })), deliveries: parsed.deliveries ?? [], channelEvents, confirmations: parsed.confirmations ?? [], supervisionPolicies: parsed.supervisionPolicies ?? [], supervisionReviews: parsed.supervisionReviews ?? [], supervisionSignals: parsed.supervisionSignals ?? [], executionSurfaces: parsed.executionSurfaces ?? [], surfaceClaims: parsed.surfaceClaims ?? [], runtimeBindings: parsed.runtimeBindings ?? [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('ARCP durable state is unreadable');
    }
  }
  snapshot(): State { return structuredClone(this.state); }
  async mutate<T>(fn: (state: State) => T): Promise<T> {
    let result!: T;
    const next = this.write.catch(() => undefined).then(async () => {
      const candidate = structuredClone(this.state);
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        result = fn(candidate);
        await writeFile(temp, JSON.stringify(candidate, null, 2) + '\n', { mode: 0o600 });
        await rename(temp, this.file);
        this.state = candidate;
        return result;
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
    });
    this.write = next;
    await next;
    return result;
  }
  /** Channel history is append-only. Retention is a presentation concern, not deletion. */
  async prune(_maxRows = 200): Promise<void> {}
}

export const DEFAULT_PROFILES = [
  { id: 'claude-manager', provider: 'claude', model: 'claude-opus-5', mode: 'auto', thinking: 'medium', role: 'manager' },
  { id: 'claude-bypass-permissions', provider: 'claude', model: 'claude-opus-5', mode: 'bypassPermissions', thinking: 'medium', role: 'manager' },
  { id: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', mode: 'auto', thinking: 'medium', role: 'worker' },
  { id: 'codex-auto-review', provider: 'codex', model: 'gpt-5.6-terra', mode: 'auto-review', thinking: 'medium', role: 'worker' },
  { id: 'codex-full-access', provider: 'codex', model: 'gpt-5.6-terra', mode: 'full-access', thinking: 'medium', role: 'worker' },
  { id: 'claude-sonnet-worker', provider: 'claude', model: 'claude-sonnet-5', mode: 'auto', thinking: 'medium', role: 'worker' },
  { id: 'claude-sonnet-worker-bypass', provider: 'claude', model: 'claude-sonnet-5', mode: 'bypassPermissions', thinking: 'medium', role: 'worker' },
  { id: 'pi-grok-worker', provider: 'pi', model: 'grok-cli/grok-4.6', role: 'worker' },
] as const;

function normalized(value: unknown): string { return String(value ?? '').toLowerCase(); }
function capabilityText(value: unknown): string { return String(JSON.stringify(value ?? '')).toLowerCase(); }
function capabilityToken(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]/g, ''); }
/** Capabilities a member needs to satisfy the claim/submit handoff that a
 * launch prompt injects. A role that cannot hold these must never be handed a
 * Task, so the two are decided in one place. */
export const TASK_OWNER_CAPABILITIES = ['claim_task', 'write_knowledge', 'submit_result', 'read_context'];
/** Roles whose members are deliberately observers: they read and record, and
 * are separately refused product Tasks in claimTask/submitResult. */
const OBSERVER_ROLES = ['steward', STEWARD_ANALYSIS_ROLE];
function defaultMemberCapabilities(role: string): string[] {
  const normalizedRole = role.trim().toLowerCase();
  if (OBSERVER_ROLES.includes(normalizedRole)) return ['read_context', 'write_knowledge'];
  // Every other launchable role - worker, manager, reviewer, deputy, on-call -
  // is told to claim its Task and submit its own Result, so it holds the
  // capabilities to do so. Silent capability denial that only surfaces at
  // submit time forces a runtime to borrow someone else's credential.
  return [...TASK_OWNER_CAPABILITIES];
}
function canOwnHandoffTask(capabilities: readonly string[]): boolean {
  return ['claim_task', 'submit_result'].every((capability) => capabilities.includes(capability));
}
function sessionState(value: unknown): SessionState {
  const state = normalized(value);
  if (!state || state === 'unknown') return 'transport_indeterminate';
  if (['completed', 'failed', 'stopped', 'cancelled', 'archived', 'terminal'].includes(state)) return 'terminal';
  if (state === 'idle') return 'idle';
  return 'running';
}
function paseoPlacement(record: Record<string, any>): PaseoPlacement['observed'] {
  const projectId = setting(record.projectId ?? record.project?.id);
  const workspaceId = setting(record.workspaceId ?? record.workspace?.id);
  const agentId = setting(record.id ?? record.agentId);
  const lifecycle = setting(record.lifecycle ?? record.status);
  return { ...(projectId ? { projectId } : {}), ...(workspaceId ? { workspaceId } : {}), ...(agentId ? { agentId } : {}), ...(lifecycle ? { lifecycle } : {}) };
}
function placementMatches(placement: PaseoPlacement): boolean {
  const observed = placement.observed;
  return !observed || (['projectId', 'workspaceId', 'agentId'] as const).every((key) => !placement.requested[key] || !observed[key] || placement.requested[key] === observed[key]);
}
function normalizedTurnState(value: unknown): 'running' | 'requires_action' | 'idle' {
  const state = normalized(value);
  if (state.includes('permission') || state.includes('requires_action') || state.includes('attention') || state.includes('error')) return 'requires_action';
  if (state.includes('run') || state.includes('active') || state.includes('progress') || state.includes('turn_start') || state.includes('prompt_start')) return 'running';
  return 'idle';
}
const setting = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const sameSetting = (a: unknown, b: unknown) => !a || !b ? false : capabilityToken(String(a)) === capabilityToken(String(b));
function launchReceiptIdentity(value: Record<string, any>): string | undefined {
  const nested = asRecord(value.agent ?? value.runtime ?? value.result);
  return setting(value.id ?? value.agentId ?? value.sessionId ?? value.externalId ?? nested.id ?? nested.agentId ?? nested.sessionId);
}
/** An attached participant is bound by channel identity, not by a provider
 * plan. Its `provider`/`model` columns carry adapter identity, so comparing
 * them against observed provider settings manufactures a permanent mismatch
 * and wedges every safe-point delivery behind a phantom `attention` state. */
const ATTACHED_PARTICIPANT_PROFILE = 'attached-participant';
const isAttachedParticipant = (session: { profileId?: string }) => session.profileId === ATTACHED_PARTICIPANT_PROFILE;

const safeModeRank = (provider: string, value: unknown) => {
  const mode = capabilityToken(String(value ?? ''));
  if (['plan', 'readonly', 'read', 'ask'].includes(mode)) return 0;
  if (provider === 'codex') {
    if (mode === 'auto') return 1;
    if (mode === 'autoreview') return 2;
    if (mode === 'fullaccess') return 3;
    return 1;
  }
  if (provider === 'claude') {
    if (mode === 'auto') return 1;
    if (mode === 'bypasspermissions') return 2;
    return 1;
  }
  return 1;
};
const safeJson = (value: unknown): Record<string, any> => asRecord(value);
async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
function remoteProjectId(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const value = remote.trim().replace(/^ssh:\/\/git@/, '').replace(/^git@([^:]+):/, '$1/').replace(/^[a-z]+:\/\//i, '').replace(/\.git$/, '').replace(/^ssh\./, '');
  return value.includes('/') ? `remote:${value}` : undefined;
}
async function repositoryIdentity(checkout: string): Promise<{ root: string; projectId?: string }> {
  const root = path.resolve((await git(checkout, ['rev-parse', '--show-toplevel'])).trim());
  const commonRaw = await git(checkout, ['rev-parse', '--git-common-dir']).catch(() => undefined);
  const common = commonRaw?.trim() ? (path.isAbsolute(commonRaw.trim()) ? path.resolve(commonRaw.trim()) : path.resolve(checkout, commonRaw.trim())) : undefined;
  // Linked worktrees have their own checkout roots but share the main
  // worktree's .git directory. Paseo Projects represent that repository.
  const repositoryRoot = common && path.basename(common) === '.git' ? path.dirname(common) : root;
  const remote = await git(checkout, ['config', '--get', 'remote.origin.url']).then((value) => value.trim()).catch(() => undefined);
  return { root: repositoryRoot, projectId: remoteProjectId(remote) };
}
/** Paseo may own a Workspace's archival lifecycle more broadly than ARCP's
 * visibility policy. Capture enough Git identity before archiving a disposable
 * surface to restore the checkout if the provider removes it. */
async function worktreeRetention(checkout: CheckoutRef): Promise<{ repositoryRoot: string; branch?: string; revision: string } | undefined> {
  if (!existsSync(checkout.path)) return undefined;
  const common = (await git(checkout.path, ['rev-parse', '--git-common-dir'])).trim();
  const repositoryRoot = path.dirname(path.isAbsolute(common) ? common : path.resolve(checkout.path, common));
  const branch = (await git(checkout.path, ['branch', '--show-current'])).trim() || undefined;
  const revision = (await git(checkout.path, ['rev-parse', 'HEAD'])).trim();
  return { repositoryRoot, ...(branch ? { branch } : {}), revision };
}
class PlacementConflict extends Error {}
/** The V1 first-class runtime adapter. Provider choices stay in validated profiles;
 * this adapter owns only safe Paseo transport/discovery calls and never exposes native handles. */
type PaseoModeClient = { connect(): Promise<void>; close(): Promise<void>; providers: { listModes(provider: string): Promise<unknown> } };

/** Default budget for the discovery-plane calls (`provider ls`, `ls -g`,
 * `inspect`) that back preflight() and doctor's live/available verdicts.
 * These calls back a fail-closed decision, so the budget must stay generous:
 * the daemon's response time grows with agent count, and a fixed 5s budget
 * started reading a live daemon as unavailable once it carried ~100 agents
 * (measured ~5.8s for `provider ls --json`, ~5.4s for `ls -g --json`).
 * ARCP_DISCOVERY_TIMEOUT_MS lets an operator raise the budget without a code
 * change; a call that genuinely exceeds it still throws, so preflight/doctor
 * still fail closed to `hold`/`unavailable` rather than fabricate availability. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000;
function discoveryTimeoutMs(): number {
  const raw = Number(process.env.ARCP_DISCOVERY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DISCOVERY_TIMEOUT_MS;
}

export class PaseoAdapter implements RuntimeAdapter {
  readonly adapterId = 'paseo';
  constructor(private readonly cli: PaseoCli, private readonly modeClientFactory?: () => PaseoModeClient) {}
  discover() { return this.cli.run(['provider', 'ls', '--json'], { timeoutMs: discoveryTimeoutMs() }); }
  models(provider: string) { return this.cli.run(['provider', 'models', provider, '--json'], { timeoutMs: discoveryTimeoutMs() }); }
  launch(profile: Profile, goalTitle: string, workspace?: string, context?: RuntimeLaunchContext) {
    const handoff = context?.workspaceId && context.taskId && context.runtimeId && context.taskHandoff === false
      ? `\n\nARCP note: this runtime joins as an observer. It holds no claim_task or submit_result capability, so it must not attempt to claim task ${context.taskId} or submit a Result; report findings as Knowledge instead.`
      : context?.workspaceId && context.taskId && context.runtimeId
      ? `\n\nARCP Worker handoff: workspace ${context.workspaceId}, task ${context.taskId}, runtime ${context.runtimeId}. Use the packaged CLI through Node. Claim with \`${packagedArcpCommand('task', 'claim', context.taskId, '--expected-fence', '0')}\`. Report durable learning with \`${packagedArcpCommand('knowledge', 'add', context.workspaceId, '--kind', 'learning', '--text', '<learning>')}\` and submit the candidate with \`${packagedArcpCommand('result', 'submit', context.workspaceId, '--task', context.taskId, '--summary', '<summary>', '--expected-fence', '1', '--evidence', '<evidence-ref[,evidence-ref...]>')}\`.`
      : '';
    const contract = context?.contract?.trim() ? `\n\nARCP Goal Contract (authoritative scope; you hold it before you act):\n${context.contract.trim()}` : '';
    const route = context?.reportingRoute?.primaryHandlerMemberId
      ? `\n\nARCP ReportingRoute: report completion, blockers and your Result to primary handler ${context.reportingRoute.primaryHandlerMemberId}${context.reportingRoute.ccMemberIds.length ? ` (cc, observe-only: ${context.reportingRoute.ccMemberIds.join(', ')})` : ''}${context.reportingRoute.escalationMemberIds.length ? `; escalation chain ${context.reportingRoute.escalationMemberIds.join(' -> ')}` : ''}. The primary handler alone owns acknowledgement and the decision on your Result.`
      : '';
    const title = paseoTitle(profile.role, goalTitle);
    return this.cli.run(['run', '-d', '--json', '--title', title, '--provider', profile.provider, '--model', profile.model, ...(profile.mode ? ['--mode', profile.mode] : []), ...(profile.thinking ? ['--thinking', profile.thinking] : []), ...(context?.paseoWorkspaceId ? ['--workspace', context.paseoWorkspaceId] : []), ...(workspace ? ['--cwd', workspace] : []), ...(context?.runtimeId ? ['--label', `arcp-runtime=${context.runtimeId}`, '--label', `arcp-role=${profile.role}`] : []), ...(context?.clientStatePath ? ['--env', `ARCP_CLIENT_STATE=${context.clientStatePath}`] : []), `Work on ARCP Goal: ${goalTitle}${contract}${route}${handoff}`], { timeoutMs: 30_000 });
  }
  observe(externalId: string) { return this.cli.run(['inspect', externalId, '--json'], { timeoutMs: discoveryTimeoutMs() }); }
  registry() { return this.cli.run(['ls', '-g', '-a', '--json'], { timeoutMs: discoveryTimeoutMs() }); }
  async workspacePlacement(workspaceId: string): Promise<PaseoPlacement['observed']> {
    if (!(this.cli instanceof PaseoCli)) return {};
    const raw = process.env.PASEO_HOST || process.env.PASEO_COMPANION_PASEO_HOST || 'ws://127.0.0.1:6767/ws'; const url = raw.includes('://') ? raw : `ws://${raw}`;
    const client = createPaseoClient({ url, clientId: `arcp-placement-${process.pid}-${workspaceId.slice(-8)}`, reconnect: { enabled: false }, webSocketFactory: (target: string, options: any) => new WebSocket(target, options) } as any);
    try { await client.connect(); return paseoPlacement(asRecord(await client.workspaces.ref(workspaceId).refresh())); }
    finally { await client.close().catch(() => undefined); }
  }
  /** Resolve a stable Paseo Project without creating a repository-root
   * Workspace. Lane materialization needs the Project identity, not another
   * visible execution row for the source checkout. */
  async projectForCheckout(checkout: string): Promise<{ root: string; projectId: string }> {
    const repository = await repositoryIdentity(checkout);
    const projects = (await this.cli.run(['project', 'ls', '--json'], { timeoutMs: discoveryTimeoutMs() })).value;
    const listed = Array.isArray(projects) ? projects.map(asRecord) : [];
    const projectAtRoot = listed.find((item) => path.resolve(String(item.path ?? item.cwd ?? '')) === repository.root);
    const projectByRemote = repository.projectId ? listed.find((item) => setting(item.projectId ?? item.id ?? asRecord(item.project).id) === repository.projectId) : undefined;
    const existing = setting(projectAtRoot?.projectId ?? projectAtRoot?.id ?? asRecord(projectAtRoot?.project).id) ?? setting(projectByRemote?.projectId ?? projectByRemote?.id ?? asRecord(projectByRemote?.project).id);
    const projectId = existing ?? setting(asRecord((await this.cli.run(['project', 'create', repository.root, '--json'], { timeoutMs: discoveryTimeoutMs() })).value).projectId);
    if (!projectId) throw new ArcpError('placement_unresolved', 'Paseo did not materialize a Project identity');
    return { root: repository.root, projectId };
  }
  /** Resolve the repository root before asking Paseo to create anything.  This
   * prevents a runtime subdirectory from becoming a spurious Project. */
  async materializePlacement(input: { checkout: string; projectId?: string; workspaceId?: string; title: string }): Promise<CanonicalPaseoPlacement | undefined> {
    const checkout = path.resolve(input.checkout);
    if (input.workspaceId) {
      const observed = (await this.workspacePlacement(input.workspaceId)) ?? {};
      if (input.projectId && observed.projectId && observed.projectId !== input.projectId) throw new Error('requested Paseo Project does not own the selected Workspace');
      if (observed.workspaceId && observed.workspaceId !== input.workspaceId) throw new PlacementConflict('requested Paseo Workspace could not be resolved');
      const projectId = observed.projectId ?? input.projectId;
      return projectId ? { checkout, projectId, workspaceId: observed.workspaceId ?? input.workspaceId } : undefined;
    }
    const repository = await repositoryIdentity(checkout);
    const projects = (await this.cli.run(['project', 'ls', '--json'], { timeoutMs: discoveryTimeoutMs() })).value;
    const listedProjects = Array.isArray(projects) ? projects.map(asRecord) : [];
    const projectAtRoot = listedProjects.find((item) => path.resolve(String(item.path ?? item.cwd ?? '')) === repository.root);
    const projectByRemote = repository.projectId
      ? listedProjects.find((item) => setting(item.projectId ?? item.id ?? asRecord(item.project).id) === repository.projectId)
      : undefined;
    // A remote URL is only a lookup key. Never pass its synthetic value to
    // Paseo as a Project ID when the daemon has not returned a real one.
    const canonicalProject = input.projectId
      ?? setting(projectAtRoot?.projectId ?? projectAtRoot?.id ?? asRecord(projectAtRoot?.project).id)
      ?? setting(projectByRemote?.projectId ?? projectByRemote?.id ?? asRecord(projectByRemote?.project).id);
    const workspaces = (await this.cli.run(['workspace', 'ls', '--json'], { timeoutMs: discoveryTimeoutMs() })).value;
    const listed = Array.isArray(workspaces) ? workspaces.map(asRecord) : [];
    const requested = input.workspaceId ? listed.find((item) => setting(item.workspaceId ?? item.id) === input.workspaceId) : undefined;
    const placements = await Promise.all(listed.map(async (item) => ({ item, placement: await this.workspacePlacement(setting(item.workspaceId ?? item.id) ?? '').catch(() => undefined) })));
    const candidates = placements.filter(({ item, placement }) => {
      const listedProject = setting(item.projectId ?? asRecord(item.project).id);
      const workspaceProject = listedProject ?? placement?.projectId;
      return path.resolve(String(item.cwd ?? item.path ?? '')) === checkout && (!canonicalProject || workspaceProject === canonicalProject);
    });
    if (!requested && candidates.length > 1) throw new PlacementConflict(`PLACEMENT_CONFLICT: ${candidates.length} Paseo Workspaces match checkout ${checkout}; select the canonical Workspace explicitly`);
    const existing = requested ?? candidates[0]?.item;
    if (existing) {
      const workspaceId = setting(existing.workspaceId ?? existing.id);
      const projectId = setting(existing.projectId) ?? (workspaceId ? (await this.workspacePlacement(workspaceId))?.projectId : undefined);
      if (!workspaceId || !projectId) throw new Error('Paseo workspace listing omitted its stable placement identity');
      if (canonicalProject && projectId !== canonicalProject) throw new PlacementConflict(`PLACEMENT_CONFLICT: requested Workspace ${workspaceId} belongs to Paseo Project ${projectId}; canonical repository Project is ${canonicalProject}`);
      return { checkout, projectId, workspaceId };
    }
    let projectId = canonicalProject;
    if (!projectId) {
      projectId = setting(asRecord((await this.cli.run(['project', 'create', repository.root, '--json'], { timeoutMs: discoveryTimeoutMs() })).value).projectId);
    }
    if (!projectId) throw new Error('Paseo did not materialize a Project identity');
    const created = asRecord((await this.cli.run(['workspace', 'create', '--isolation', 'local', '--path', checkout, '--project', projectId, '--title', input.title, '--json'], { timeoutMs: discoveryTimeoutMs() })).value);
    const workspaceId = setting(created.workspaceId ?? created.id);
    const observedProjectId = setting(created.projectId ?? created.project) ?? projectId;
    if (!workspaceId) throw new Error('Paseo did not materialize a Workspace identity');
    if (observedProjectId !== projectId) throw new PlacementConflict(`Paseo materialized Workspace ${workspaceId} under unexpected Project ${observedProjectId}`);
    return { checkout, projectId: observedProjectId, workspaceId };
  }
  /** Paseo owns the sidebar row; archiving it never removes a Git worktree. */
  archiveWorkspace(workspaceId: string) { return this.cli.run(['workspace', 'archive', workspaceId, '--json'], { timeoutMs: 30_000 }); }
  /** Paseo currently has no documented unarchive command. Re-materializing the
   * same checkout under its existing Project is the provider-neutral fallback;
   * a returned replacement ID is surfaced as restore evidence by the service. */
  async restoreWorkspace(input: { checkout: string; binding: { projectId: string; workspaceId: string }; title: string }): Promise<{ binding: { projectId: string; workspaceId: string }; strategy: SurfaceRestoreEvidence['strategy'] }> {
    const placement = await this.materializePlacement({ checkout: input.checkout, projectId: input.binding.projectId, title: input.title });
    if (!placement || placement.projectId !== input.binding.projectId) throw new ArcpError('placement_unresolved', 'Paseo did not restore the archived surface under its original Project');
    return { binding: { projectId: placement.projectId, workspaceId: placement.workspaceId }, strategy: placement.workspaceId === input.binding.workspaceId ? 'provider_restore' : 'rematerialized' };
  }
  async providerSubagents(parentAgentId: string): Promise<ChildObservation> {
    if (!(this.cli instanceof PaseoCli)) return { source: 'unavailable', items: [] };
    const raw = process.env.PASEO_HOST || process.env.PASEO_COMPANION_PASEO_HOST || 'ws://127.0.0.1:6767/ws'; const url = raw.includes('://') ? raw : `ws://${raw}`;
    const client = new DaemonClient({ url, clientId: `arcp-subagents-${process.pid}-${parentAgentId.slice(0, 8)}`, clientType: 'cli', webSocketFactory: (target: string, options: any) => new WebSocket(target, options), reconnect: { enabled: false } } as any);
    try { await client.connect(); const payload = safeJson(await client.listProviderSubagents(parentAgentId, { timeout: 5_000 })); const rows = Array.isArray(payload.subagents) ? payload.subagents.map(safeJson) : []; return { source: 'provider_subagents', items: rows.map((item) => ({ id: String(item.id), ...(setting(item.provider) ? { provider: String(item.provider) } : {}), ...(setting(item.title) ? { title: String(item.title) } : {}), status: String(item.status ?? 'unknown'), ...(setting(item.createdAt) ? { createdAt: String(item.createdAt) } : {}), ...(setting(item.updatedAt) ? { updatedAt: String(item.updatedAt) } : {}), source: 'provider_subagents' as const })).filter((item) => item.id) }; }
    catch { return { source: 'unavailable', items: [] }; } finally { await client.close().catch(() => undefined); }
  }
  /** Public SDK mode ids are authoritative. CLI `provider ls` emits display
   * labels, which must never be treated as ids when the SDK is reachable. */
  async modes(provider: string): Promise<string[] | undefined> {
    if (!this.modeClientFactory && !(this.cli instanceof PaseoCli)) return undefined;
    const raw = process.env.PASEO_HOST || process.env.PASEO_COMPANION_PASEO_HOST || 'ws://127.0.0.1:6767/ws';
    const url = raw.includes('://') ? raw : `ws://${raw}`;
    const client = this.modeClientFactory?.() ?? createPaseoClient({ url, clientId: `arcp-modes-${process.pid}-${provider}`, reconnect: { enabled: false }, webSocketFactory: (target: string, options: any) => new WebSocket(target, options) } as any) as PaseoModeClient;
    try {
      await client.connect(); const payload = safeJson(await client.providers.listModes(provider));
      if (!Array.isArray(payload.modes)) return [];
      return payload.modes.map((mode) => setting(safeJson(mode).id)).filter((mode): mode is string => Boolean(mode));
    } catch { return undefined; } finally { await client.close().catch(() => undefined); }
  }
  /** The server protocol exposes provider.usage.list. Use it only if this
   * installed public SDK actually presents a callable method; no daemon internals
   * or UI scraping are a fallback. */
  async providerUsage(sourceId: string): Promise<ProviderBudgetEnvelopeV1 | undefined> {
    if (!(this.cli instanceof PaseoCli)) return undefined;
    const raw = process.env.PASEO_HOST || process.env.PASEO_COMPANION_PASEO_HOST || 'ws://127.0.0.1:6767/ws'; const url = raw.includes('://') ? raw : `ws://${raw}`;
    const client: any = createPaseoClient({ url, clientId: `arcp-provider-usage-${process.pid}`, reconnect: { enabled: false }, webSocketFactory: (target: string, options: any) => new WebSocket(target, options) } as any);
    try { await client.connect(); const list = typeof client.providerUsageList === 'function' ? client.providerUsageList.bind(client) : typeof client.providers?.listProviderUsage === 'function' ? client.providers.listProviderUsage.bind(client.providers) : undefined; return list ? translatePaseoProviderUsage(sourceId, await list()) : undefined; }
    catch { return undefined; } finally { await client.close().catch(() => undefined); }
  }
  /** Prefer the installed public SDK snapshot/timeline. CLI is retained for older
   * daemons and adapter facts which the public SDK cannot expose. */
  async snapshot(externalId: string): Promise<{ agent: Record<string, any>; timeline: unknown[]; source: 'sdk' | 'cli' }> {
    if (this.cli instanceof PaseoCli) {
      const raw = process.env.PASEO_HOST || process.env.PASEO_COMPANION_PASEO_HOST || 'ws://127.0.0.1:6767/ws';
      const url = raw.includes('://') ? raw : `ws://${raw}`;
      const client = createPaseoClient({ url, clientId: `arcp-observe-${process.pid}-${externalId.slice(0, 8)}`, reconnect: { enabled: false }, webSocketFactory: (target: string, options: any) => new WebSocket(target, options) } as any);
      await client.connect();
      try {
        const handle = client.agents.ref(externalId); const refreshed = await handle.refresh();
        if (!refreshed?.agent) throw new Error('Paseo public client did not return a snapshot');
        const page = await handle.timeline.refetch({ direction: 'tail', limit: 100 });
        const value = safeJson(page); const timeline = Array.isArray(value.items) ? value.items : Array.isArray(value.timeline) ? value.timeline : [];
        return { agent: safeJson(refreshed.agent), timeline, source: 'sdk' };
      } finally { await client.close(); }
    }
    const observed = safeJson((await this.observe(externalId)).value);
    return { agent: observed, timeline: Array.isArray(observed.timeline) ? observed.timeline : [], source: 'cli' };
  }
  /** Normal delivery uses the public client handle after a second idle/terminal check. */
  async startTurn(externalId: string, body: string, deliveryId: string) {
    if (!(this.cli instanceof PaseoCli)) return (this.cli as any).run(['start-turn', externalId, deliveryId, body], { timeoutMs: 10_000 });
    const raw = process.env.PASEO_HOST || process.env.PASEO_COMPANION_PASEO_HOST || 'ws://127.0.0.1:6767/ws';
    const url = raw.includes('://') ? raw : `ws://${raw}`;
    const client = createPaseoClient({ url, clientId: `arcp-${process.pid}-${deliveryId.slice(0, 8)}`, reconnect: { enabled: false }, webSocketFactory: (target: string, options: any) => new WebSocket(target, options) } as any);
    await client.connect();
    try {
      const handle = client.agents.ref(externalId); const refreshed = await handle.refresh(); const status = normalized(refreshed?.agent?.status);
      if (!['idle', 'terminal', 'completed', 'stopped'].includes(status)) throw new ArcpError('safe_point_lost', 'runtime changed before start turn');
      await handle.send(body, { messageId: deliveryId });
    } finally { await client.close(); }
  }
  interrupt(externalId: string, body: string) { return this.cli.run(['send', '--no-wait', externalId, body], { timeoutMs: 10_000 }); }
  stop(externalId: string) { return this.cli.run(['stop', externalId, '--json'], { timeoutMs: 10_000 }); }
}

export type Profile = { id: string; provider: string; model: string; mode?: string; thinking?: string; role: string };
export type LaunchInput = { profileId?: string; provider?: string; model?: string; mode?: string; thinking?: string; role?: string; unattended?: boolean; executionSurfaceId?: string };

export class ArcpService implements ExecutionPlacementPort {
  readonly store: StateStore;
  readonly adapter: RuntimeAdapter;
  private readonly adapters = new Map<string, RuntimeAdapter>();
  /** Actor channels are a different seam from runtime hosts: they wake a
   * conversation that already exists outside this Workspace. */
  readonly channels = new ActorChannelRegistry();
  private profileData: Profile[] = [...DEFAULT_PROFILES];
  /** Operator-authored plain text: returned verbatim, never interpreted. */
  private routingGuidanceText = '';
  private providerBudgetConfig: ProviderBudgetConfig = {};
  private providerBudgetSnapshot?: ProviderBudgetEnvelopeV1;
  private readonly runtimeBudget = new RuntimeBudgetTracker();
  private runtimeBudgetPolicy: RuntimeBudgetPolicy = { maxOutputTokensPerMinute: 3_000, maxTurnsPerMinute: 2, maxRepeatedWakeCount: 3, contextRatio: 0.85 };
  private pumpTimer?: NodeJS.Timeout;
  private pumping?: Promise<void>;
  private pumpAgain = false;
  private readonly pendingResultSubmissions = new Set<Promise<unknown>>();
  private readonly surfaceMaterializations = new Map<string, Promise<ExecutionSurfaceBinding>>();
  private readonly stewardCache = new Map<string, WorkspaceSteward>();
  private stewardFactory?: (service: ArcpService, workspaceId: string) => Promise<WorkspaceSteward>;
  private readonly startedAt = new Date().toISOString();
  private port = 0;
  constructor(readonly dataDir: string, readonly cli = new PaseoCli(), store?: StateStore, modeClientFactory?: () => PaseoModeClient, adapters: RuntimeAdapter[] = []) { this.store = store ?? (process.env.ARCP_STATE_STORE === 'sqlite' ? new SQLiteStateStore(dataDir) : new ArcpStore(dataDir)); this.adapter = new PaseoAdapter(cli, modeClientFactory); this.registerAdapter(this.adapter); this.registerAdapter(new HermesAcpAdapter()); for (const adapter of adapters) this.registerAdapter(adapter); }
  registerAdapter(adapter: RuntimeAdapter): void {
    this.adapters.set(adapter.adapterId, adapter);
    const onSafePoint = (adapter as RuntimeAdapter & { onSafePoint?: (listener: (event: SafePointEvent) => void) => () => void }).onSafePoint;
    if (onSafePoint) onSafePoint.call(adapter, () => { void this.pump(); });
    const onFact = (adapter as RuntimeAdapter & { onFact?: (listener: (fact: { externalId: string; kind: ChannelEventKind; urgency: 'normal' | 'urgent'; summary: string; sampleBucket?: number }) => void) => () => void }).onFact;
    if (onFact) onFact.call(adapter, (fact) => { const session = this.store.snapshot().sessions.find((item) => item.externalId === fact.externalId); if (session) void this.publishChannelEvent({ semanticKey: `observation:${fact.externalId}:${session.generation}:${fact.kind}:${session.workspaceId ?? ''}:${session.goalId}:${session.taskId ?? ''}:${session.memberId ?? ''}`, workspaceId: session.workspaceId, goalId: session.goalId, taskId: session.taskId, sourceMemberId: session.memberId, sourceActorId: session.actorId, targetRole: 'manager', kind: fact.kind, urgency: fact.urgency, consumptionPolicy: fact.kind === 'permission' ? 'decision_required' : 'ack_required', decisionRequired: fact.kind === 'permission' || fact.kind === 'attention', summary: fact.summary, evidenceRefs: [] }).catch(() => undefined); });
    const onResult = (adapter as RuntimeAdapter & { onResult?: (listener: (fact: { externalId: string; taskId: string; status: Result['status']; summary: string; evidenceRefs?: string[]; expectedFence?: number; sourceId: string }) => void) => () => void }).onResult;
    if (onResult) onResult.call(adapter, (fact) => { const session = this.store.snapshot().sessions.find((item) => item.externalId === fact.externalId); if (session?.memberId && fact.expectedFence !== undefined) { const submission = this.submitResult({ workspaceId: session.workspaceId!, taskId: fact.taskId, memberId: session.memberId, status: fact.status, summary: fact.summary, evidenceRefs: fact.evidenceRefs, expectedFence: fact.expectedFence, sourceId: fact.sourceId }); this.pendingResultSubmissions.add(submission); void submission.finally(() => this.pendingResultSubmissions.delete(submission)).catch(() => undefined); } });
  }
  /** Override the analyst only for deterministic local proof; production uses
   * the owner-selected Codex runtime through the same WorkspaceSteward object
   * used by manual requests. */
  setStewardFactory(factory: (service: ArcpService, workspaceId: string) => Promise<WorkspaceSteward>): void {
    this.stewardFactory = factory;
    this.stewardCache.clear();
  }
  async workspaceSteward(workspaceId: string): Promise<WorkspaceSteward> {
    const cached = this.stewardCache.get(workspaceId);
    if (cached) return cached;
    if (this.stewardFactory) {
      const steward = await this.stewardFactory(this, workspaceId);
      this.stewardCache.set(workspaceId, steward);
      return steward;
    }
    const state = this.store.snapshot();
    const workspace = state.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) throw new ArcpError('not_found', 'workspace not found');
    const existing = state.members.find((item) => item.workspaceId === workspaceId && item.role === 'steward');
    const member = existing ?? (await this.joinWorkspace({ workspaceId, label: 'workspace-steward', role: 'steward', capabilities: ['read_context', 'write_knowledge'] })).member;
    const configured = this.supervisionPolicy(workspaceId);
    const profileId = configured?.stewardProfileId ?? process.env.ARCP_STEWARD_PROFILE ?? DEFAULT_STEWARD_PROFILE_ID;
    const profile = this.profileData.find((item) => item.id === profileId);
    if (!profile || profile.provider !== 'codex' || capabilityToken(profile.mode ?? '') !== 'fullaccess') throw new ArcpError('invalid_request', 'Steward profile must be Codex full-access (non-prompting)', 'stewardProfileId');
    const policy = {
      workspaceId,
      stewardProfileId: profileId,
      stewardMemberId: member.id,
      cooldownMs: configured?.cooldownMs ?? Number(process.env.ARCP_STEWARD_COOLDOWN_MS ?? 900_000),
      automatic: configured?.automatic ?? process.env.ARCP_STEWARD_AUTOMATIC !== '0',
      manualProgressWindowMs: Number(process.env.ARCP_STEWARD_PROGRESS_WINDOW_MS ?? 1_800_000),
    };
    const analyst = new CodexRuntimeAnalyst(this, { profileId, actorId: workspace.ownerActorId, waitMs: Number(process.env.ARCP_STEWARD_WAIT_MS ?? 300_000) });
    const steward = new WorkspaceSteward(stewardViewOf(this), analyst, policy);
    this.stewardCache.set(workspaceId, steward);
    return steward;
  }
  /** Await ACP result ingestion and the pump it triggers. Intended for deterministic callers/tests. */
  async flushResultSubmissions(): Promise<void> {
    while (true) {
      const submissions = [...this.pendingResultSubmissions];
      if (submissions.length > 0) await Promise.allSettled(submissions);
      if (this.pumping) await this.pumping;
      if (this.pendingResultSubmissions.size === 0 && !this.pumping && !this.pumpAgain) return;
    }
  }
  private adapterFor(session: RuntimeSession): RuntimeAdapter { return this.adapters.get(session.adapterId || (session.runtimeKind === 'external' ? 'hermes-acp' : 'paseo')) ?? this.adapter; }
  /** The launch receipt is the sole native identity for a runtime. Keep the
   * session, placement, and all bindings converged even when older durable
   * state only recorded it in one of those records. */
  private async canonicalRuntimeIdentity(session: RuntimeSession): Promise<string | undefined> {
    const state = this.store.snapshot();
    const current = state.sessions.find((item) => item.id === session.id) ?? session;
    const identity = setting(current.externalId) ?? setting(state.runtimeBindings.find((item) => item.runtimeSessionId === current.id && item.nativeId)?.nativeId);
    if (!identity) return undefined;
    // A read path must not pay a durable store write. Repair runs only when a
    // record genuinely disagrees with the launch receipt identity.
    const agrees = current.externalId === identity
      && (!current.placement || current.placement.requested.agentId === identity)
      && state.runtimeBindings.filter((item) => item.runtimeSessionId === current.id).every((item) => item.nativeId === identity);
    if (agrees) return identity;
    await this.store.mutate((next) => {
      const item = next.sessions.find((value) => value.id === current.id);
      if (!item) return;
      item.externalId = identity;
      if (item.placement) item.placement.requested.agentId = identity;
      for (const binding of next.runtimeBindings.filter((value) => value.runtimeSessionId === item.id)) binding.nativeId = identity;
    });
    return identity;
  }
  /** A managed credential is issued before the runtime exists. When the launch
   * it was issued for never happens, retire the member and destroy both the
   * stored credential and the per-runtime client state file, so no orphan
   * credential outlives the launch attempt. */
  private async abandonManagedLaunch(input: { memberId?: string; runtimeId: string; goalId?: string; taskId?: string }): Promise<void> {
    await this.store.mutate((state) => {
      if (input.memberId) {
        // memberCredentials is keyed by credential hash, so the credential is
        // destroyed by locating every hash that resolves to this member.
        for (const [hash, id] of Object.entries(state.memberCredentials)) if (id === input.memberId) delete state.memberCredentials[hash];
        const member = state.members.find((item) => item.id === input.memberId);
        if (member) { member.lifecycle = 'retired'; member.updatedAt = now(); }
      }
      // A Goal and Task minted for a launch that never happened must not
      // accumulate as active work; retiring them also frees the goal_held
      // guard so the same Goal title can be retried.
      const goal = input.goalId ? state.goals.find((item) => item.id === input.goalId) : undefined;
      if (goal && goal.state !== 'completed') { goal.state = 'cancelled'; goal.updatedAt = now(); }
      const task = input.taskId ? state.tasks.find((item) => item.id === input.taskId) : undefined;
      if (task && ['proposed', 'ready'].includes(task.lifecycle)) { task.lifecycle = 'cancelled'; task.updatedAt = now(); }
      for (const session of state.sessions.filter((item) => item.id === input.runtimeId)) {
        session.state = 'terminal';
        for (const binding of state.runtimeBindings.filter((value) => value.runtimeSessionId === session.id)) binding.state = 'terminal';
        for (const claim of state.surfaceClaims.filter((value) => value.runtimeSessionId === session.id && value.active)) { claim.active = false; claim.releasedAt = now(); }
      }
    });
    await unlink(path.join(path.dirname(this.store.file), 'runtime-members', `${input.runtimeId}.json`)).catch(() => undefined);
  }
  /** Resolve the durable ReportingRoute for a launch. The launcher is the
   * default primary handler; an explicit primary hands accountability to
   * another member and demotes the launcher to an observe-only cc. */
  private resolveReportingRoute(input: { workspaceId: string; launchedByMemberId?: string; primaryHandlerMemberId?: string; ccMemberIds?: string[]; escalationMemberIds?: string[]; fallbackMemberId?: string }): ReportingRoute {
    const state = this.store.snapshot();
    const inWorkspace = (id?: string) => Boolean(id && state.members.some((item) => item.id === id && item.workspaceId === input.workspaceId));
    const named = [input.primaryHandlerMemberId, ...(input.ccMemberIds ?? []), ...(input.escalationMemberIds ?? [])].filter((id): id is string => Boolean(id));
    for (const id of named) if (!inWorkspace(id)) throw new ArcpError('unknown_recipient', `reporting route member ${id} is not in this workspace`);
    const launcher = inWorkspace(input.launchedByMemberId) ? input.launchedByMemberId : undefined;
    const primary = input.primaryHandlerMemberId ?? launcher;
    const cc = [...(input.ccMemberIds ?? []), ...(input.primaryHandlerMemberId && launcher && input.primaryHandlerMemberId !== launcher ? [launcher] : [])];
    return { ...(launcher ? { launchedByMemberId: launcher } : {}), ...(primary && primary !== input.fallbackMemberId ? { primaryHandlerMemberId: primary } : {}), ccMemberIds: [...new Set(cc)].filter((id) => id !== primary), escalationMemberIds: [...new Set(input.escalationMemberIds ?? [])] };
  }
  private async prepareRuntimeClientState(sessionId: string, workspaceId: string, memberId: string, credential: string): Promise<string> {
    const root = path.join(path.dirname(this.store.file), 'runtime-members'); const file = path.join(root, `${sessionId}.json`);
    // `arcp message ack …` is emitted inside the runtime's delivery envelope.
    // Keep the direct member credential in this already-private per-runtime
    // state file so that copy-paste acknowledgement is runnable without a
    // hidden operator credential or an extra selector flag.
    await mkdir(root, { recursive: true }); await writeFile(file, JSON.stringify({ workspaceId, memberId, memberCredential: credential, runtimeMemberCredentials: { [sessionId]: credential } }) + '\n', { mode: 0o600 }); return file;
  }
  async init(): Promise<void> {
    await this.store.init();
    if (this.store.prune) await this.store.prune();
    // Repair pre-R5 rows once at startup so every persisted reference points at
    // the same opaque Paseo launch receipt before any observation is attempted.
    await this.store.mutate((state) => {
      for (const session of state.sessions) {
        const identity = setting(session.externalId) ?? setting(state.runtimeBindings.find((binding) => binding.runtimeSessionId === session.id && binding.nativeId)?.nativeId);
        if (!identity) continue;
        session.externalId = identity;
        if (session.placement) session.placement.requested.agentId = identity;
        for (const binding of state.runtimeBindings.filter((item) => item.runtimeSessionId === session.id)) binding.nativeId = identity;
      }
      // A process can die after persisting `attempting` but before it learns
      // whether startTurn crossed the adapter boundary. Never retry that row:
      // preserve the uncertainty durably so it cannot strand forever or be
      // mistaken for a fresh safe-point delivery after restart.
      for (const delivery of state.deliveries.filter((item) => item.state === 'attempting')) {
        delivery.state = 'transport_indeterminate';
        const event = delivery.eventId ? state.channelEvents.find((item) => item.id === delivery.eventId) : undefined;
        if (event) this.transitionEvent(event, 'transport_indeterminate');
        const session = state.sessions.find((item) => item.id === delivery.runtimeSessionId);
        this.appendChannelEvent(state, { ...(session?.workspaceId ? { workspaceId: session.workspaceId } : {}), ...(session?.goalId ? { goalId: session.goalId } : {}), ...(delivery.subject?.taskId ? { taskId: delivery.subject.taskId } : {}), sourceActorId: delivery.fromActorId, targetRole: 'manager', kind: 'transport_uncertainty', urgency: 'urgent', consumptionPolicy: 'ack_required', decisionRequired: true, summary: `Delivery ${delivery.id} was attempting when ARCP restarted; runtime receipt is transport-indeterminate`, evidenceRefs: [], notify: false });
      }
    });
    try {
      const configPath = process.env.ARCP_CONFIG ?? fileURLToPath(new URL('../../config/default.json', import.meta.url));
      const config = JSON.parse(await readFile(configPath, 'utf8')) as { profiles?: Profile[]; providerBudget?: ProviderBudgetConfig; runtimeBudget?: Partial<RuntimeBudgetPolicy>; routing?: { guidance?: unknown } };
      if (Array.isArray(config.profiles) && config.profiles.every((item) => item?.id && item.provider && item.model && item.role)) this.profileData = config.profiles;
      if (typeof config.routing?.guidance === 'string') this.routingGuidanceText = config.routing.guidance;
      if (config.providerBudget && typeof config.providerBudget === 'object') this.providerBudgetConfig = config.providerBudget;
      if (config.runtimeBudget && Object.values(config.runtimeBudget).every((value) => typeof value === 'number' && Number.isFinite(value) && value > 0)) this.runtimeBudgetPolicy = { ...this.runtimeBudgetPolicy, ...config.runtimeBudget };
    } catch { /* fallback is intentional for a packaged skill with no local override */ }
    // The automatic supervision trigger rides the existing delivery pump rather
    // than introducing a scheduler. It is inert until a Workspace has a policy.
    this.pumpTimer = setInterval(() => { void this.pump(); void this.evaluateSupervision(); }, 2_000); this.pumpTimer.unref();
    // Startup is not complete until persisted safe-point deliveries have been
    // reconciled. Awaiting this makes restart behavior deterministic: delivered
    // rows are observed/processed, while waiting rows are eligible exactly once.
    await this.pump();
    // Startup also reconciles supervision budgets, so a breach that elapsed
    // while the control plane was down is recorded once rather than missed.
    await this.evaluateSupervision();
  }
  /** Provider-neutral repository lookup. Paseo Project IDs never escape this
   * placement boundary. */
  async resolveRepository(input: RepositoryLocator): Promise<RepositoryRef> {
    const identity = await repositoryIdentity(input.checkout);
    return { id: identity.projectId ?? `local:${identity.root}`, root: identity.root, ...(identity.projectId ? { remote: identity.projectId } : {}) };
  }
  /** Materialize exactly one surface per checkout identity. Paseo handles are
   * resolved only by the adapter and recorded behind its adapter id. */
  async materializeSurface(input: SurfaceSpec): Promise<ExecutionSurfaceBinding> {
    const requestedCheckout = checkoutIdentity(input.checkout);
    const existing = input.kind === 'lane' ? undefined : this.store.snapshot().executionSurfaces.find((item) => checkoutIdentity(item.checkout.path) === requestedCheckout);
    if (existing?.visibilityState === 'archived') throw new ArcpError('surface_archived', 'execution surface is archived; explicitly restore or unarchive it before reuse');
    if (existing) return { surface: existing, adapterId: 'paseo' };
    const repository = await this.resolveRepository({ checkout: requestedCheckout });
    let placement: CanonicalPaseoPlacement | undefined;
    let checkout = requestedCheckout;
    if (input.kind === 'lane') {
      const repositoryPlacement = await (this.adapter as PaseoAdapter).projectForCheckout(repository.root);
      const baseBranch = (await git(repository.root, ['branch', '--show-current'])).trim();
      if (!baseBranch) throw new ArcpError('placement_unresolved', 'Paseo lane creation requires a checked-out repository branch');
      const slug = `arcp-${randomUUID().slice(0, 8)}-${(input.slug ?? 'writer').replace(/[^a-z0-9]+/gi, '-').slice(0, 20)}`;
      const created = asRecord((await this.cli.run(['workspace', 'create', '--isolation', 'worktree', '--path', repository.root, '--project', repositoryPlacement.projectId, '--mode', 'branch-off', '--new-branch', `arcp/${slug}`, '--base', baseBranch, '--worktree-slug', slug, '--title', surfaceName('lane', input), '--json'], { timeoutMs: 30_000 })).value);
      const workspaceId = setting(created.workspaceId ?? created.id);
      if (!workspaceId) throw new ArcpError('placement_unresolved', 'Paseo did not materialize a lane Workspace');
      const listed = (await this.cli.run(['workspace', 'ls', '--json'], { timeoutMs: discoveryTimeoutMs() })).value;
      const row = Array.isArray(listed) ? listed.map(asRecord).find((item) => setting(item.workspaceId ?? item.id) === workspaceId) : undefined;
      const readback = await (this.adapter as PaseoAdapter).workspacePlacement(workspaceId).catch(() => undefined);
      const lanePath = row && setting(row.cwd ?? row.path);
      if (!row || !lanePath || !readback?.projectId || readback.projectId !== repositoryPlacement.projectId) throw new ArcpError('placement_unresolved', 'Paseo lane Workspace readback did not prove its Project and checkout');
      checkout = checkoutIdentity(lanePath);
      if (checkout === checkoutIdentity(repository.root)) throw new ArcpError('placement_unresolved', 'Paseo lane Workspace readback did not produce a distinct worktree checkout');
      placement = { checkout, projectId: repositoryPlacement.projectId, workspaceId };
    } else {
      placement = await (this.adapter as PaseoAdapter).materializePlacement({ checkout, title: surfaceName(input.kind, input) });
      if (!placement) throw new ArcpError('placement_unresolved', 'Paseo did not materialize an ExecutionSurface');
    }
    const at = now();
    const checkoutRef: CheckoutRef = { id: idFor('checkout', checkout), repositoryId: repository.id, path: checkout };
    const surface: ExecutionSurface = { id: idFor('surface', checkoutIdentity(checkout)), repositoryId: repository.id, checkout: checkoutRef, kind: input.kind, operationalState: 'active', visibilityState: 'visible', adapterBindings: { paseo: { projectId: placement.projectId, workspaceId: placement.workspaceId } }, createdAt: at, updatedAt: at };
    await this.store.mutate((state) => { state.executionSurfaces.push(surface); });
    return { surface, adapterId: 'paseo' };
  }
  /** One active writer is permitted on a surface; readers do not claim it. */
  async claimSurface(surface: ExecutionSurfaceRef, runtimeSessionId: string): Promise<SurfaceClaim> {
    return this.store.mutate((state) => {
      if (!state.executionSurfaces.some((item) => item.id === surface.id && item.visibilityState === 'visible')) throw new ArcpError('not_found', 'execution surface not found');
      if (!runtimeSessionId.trim() || !state.sessions.some((item) => item.id === runtimeSessionId)) throw new ArcpError('unknown_recipient', 'writer claim requires a persisted runtimeSessionId');
      const active = state.surfaceClaims.find((item) => item.executionSurfaceId === surface.id && item.active);
      if (active && active.runtimeSessionId !== runtimeSessionId) throw new ArcpError('task_held', 'execution surface already has an active writer claim');
      if (active) return active;
      const claim: SurfaceClaim = { id: `surface_claim_${randomUUID()}`, executionSurfaceId: surface.id, runtimeSessionId, holder: runtimeSessionId, mode: 'writer', active: true, createdAt: now() };
      state.surfaceClaims.push(claim); return claim;
    });
  }
  /** A Result/handoff calls this explicitly. It changes operations, not UI
   * visibility: completed Tabs and Workspaces remain auditable. */
  async releaseSurfaceClaim(surface: ExecutionSurfaceRef, operationalState: 'accepted' | 'parked' | 'abandoned' = 'accepted'): Promise<void> {
    await this.store.mutate((state) => {
      const item = state.executionSurfaces.find((value) => value.id === surface.id); if (!item) throw new ArcpError('not_found', 'execution surface not found');
      for (const claim of state.surfaceClaims.filter((value) => value.executionSurfaceId === surface.id && value.active)) { claim.active = false; claim.releasedAt = now(); }
      item.operationalState = operationalState; item.updatedAt = now();
    });
  }
  async launchRuntime(input: RuntimeLaunchSpec): Promise<RuntimeBindingReceipt> {
    if (input.writer) await this.claimSurface({ id: input.executionSurfaceId }, input.runtimeSessionId);
    return this.store.mutate((state) => {
      if (!state.executionSurfaces.some((item) => item.id === input.executionSurfaceId && item.visibilityState === 'visible')) throw new ArcpError('not_found', 'execution surface not found');
      const session = state.sessions.find((item) => item.id === input.runtimeSessionId);
      if (!session) throw new ArcpError('unknown_recipient', 'runtime binding requires a persisted runtimeSessionId');
      const existing = state.runtimeBindings.find((item) => item.executionSurfaceId === input.executionSurfaceId && item.runtimeSessionId === input.runtimeSessionId);
      const nativeId = setting(session.externalId) ?? setting(state.runtimeBindings.find((item) => item.runtimeSessionId === session.id && item.nativeId)?.nativeId);
      if (existing) {
        if (nativeId) existing.nativeId = nativeId;
        return { binding: existing };
      }
      const binding: RuntimeBinding = { id: `runtime_binding_${randomUUID()}`, executionSurfaceId: input.executionSurfaceId, runtimeSessionId: input.runtimeSessionId, adapterId: 'paseo', ...(nativeId ? { nativeId } : {}), generation: 1, state: 'launching', visibilityState: 'visible', createdAt: now() };
      state.runtimeBindings.push(binding); return { binding };
    });
  }
  async observeRuntime(binding: RuntimeBindingRef): Promise<{ state: string }> { const value = this.store.snapshot().runtimeBindings.find((item) => item.id === binding.id); if (!value) throw new ArcpError('not_found', 'runtime binding not found'); return { state: value.state }; }
  async retireRuntime(binding: RuntimeBindingRef): Promise<void> { await this.store.mutate((state) => { const value = state.runtimeBindings.find((item) => item.id === binding.id); if (!value) throw new ArcpError('not_found', 'runtime binding not found'); value.state = 'retired'; }); }
  /** Explicit owner/archive action only. Never invoke this from result,
   * consumption, idle, terminal, or acceptance transitions. */
  async archiveSurface(surface: ExecutionSurfaceRef, authorization: SurfaceArchiveAuthorization): Promise<void> {
    const current = this.store.snapshot().executionSurfaces.find((item) => item.id === surface.id); if (!current) throw new ArcpError('not_found', 'execution surface not found');
    const workspace = this.store.snapshot().workspaces.find((item) => item.id === authorization.controlWorkspaceId);
    const associated = this.store.snapshot().tasks.some((item) => item.workspaceId === authorization.controlWorkspaceId && item.executionSurfaceId === surface.id) || this.store.snapshot().sessions.some((item) => item.workspaceId === authorization.controlWorkspaceId && item.executionSurfaceId === surface.id);
    if (!workspace || workspace.ownerActorId !== authorization.actorId || !associated) throw new ArcpError('unauthorized', 'only the owning ControlWorkspace actor may archive its execution surface');
    if (current.visibilityState === 'archived') return;
    if (this.store.snapshot().surfaceClaims.some((item) => item.executionSurfaceId === surface.id && item.active)) throw new ArcpError('task_held', 'release the active writer claim before archiving');
    const paseo = current.adapterBindings.paseo; if (!paseo) throw new ArcpError('placement_unresolved', 'execution surface has no Paseo binding');
    const retention = ['lane', 'candidate'].includes(current.kind) ? await worktreeRetention(current.checkout).catch(() => undefined) : undefined;
    await (this.adapter as PaseoAdapter).archiveWorkspace(paseo.workspaceId);
    if (retention && !existsSync(current.checkout.path)) {
      try { await git(retention.repositoryRoot, retention.branch ? ['worktree', 'add', current.checkout.path, retention.branch] : ['worktree', 'add', '--detach', current.checkout.path, retention.revision]); }
      catch { throw new ArcpError('checkout_retention_failed', 'Paseo archived the surface but ARCP could not retain its Git worktree'); }
    }
    await this.store.mutate((state) => { const item = state.executionSurfaces.find((value) => value.id === surface.id)!; item.visibilityState = 'archived'; item.updatedAt = now(); for (const binding of state.runtimeBindings.filter((value) => value.executionSurfaceId === surface.id)) binding.visibilityState = 'archived'; });
  }
  /** Explicit Owner action only. Results and idle observations never restore
   * an archived row. Provider binding replacement remains scoped to this one
   * surface and is recorded with the returned evidence. */
  async restoreSurface(surface: ExecutionSurfaceRef, authorization: SurfaceArchiveAuthorization): Promise<SurfaceRestoreReceipt> {
    const state = this.store.snapshot(); const current = state.executionSurfaces.find((item) => item.id === surface.id); if (!current) throw new ArcpError('not_found', 'execution surface not found');
    const workspace = state.workspaces.find((item) => item.id === authorization.controlWorkspaceId);
    const associated = state.tasks.some((item) => item.workspaceId === authorization.controlWorkspaceId && item.executionSurfaceId === surface.id) || state.sessions.some((item) => item.workspaceId === authorization.controlWorkspaceId && item.executionSurfaceId === surface.id);
    if (!workspace || workspace.ownerActorId !== authorization.actorId || !associated) throw new ArcpError('unauthorized', 'only the owning ControlWorkspace actor may restore its execution surface');
    const previous = current.adapterBindings.paseo; if (!previous) throw new ArcpError('placement_unresolved', 'execution surface has no Paseo binding');
    const restored = await (this.adapter as PaseoAdapter).restoreWorkspace({ checkout: current.checkout.path, binding: previous, title: surfaceName(current.kind) });
    const evidence: SurfaceRestoreEvidence = { adapterId: 'paseo', strategy: restored.strategy, previous, current: restored.binding, observedAt: now() };
    const restoredSurface = await this.store.mutate((next) => {
      const item = next.executionSurfaces.find((value) => value.id === surface.id)!;
      item.adapterBindings.paseo = restored.binding; item.restoreEvidence = { ...(item.restoreEvidence ?? {}), paseo: evidence }; item.visibilityState = 'visible'; item.updatedAt = now();
      if (restored.strategy === 'provider_restore') for (const binding of next.runtimeBindings.filter((value) => value.executionSurfaceId === surface.id)) binding.visibilityState = 'visible';
      return item;
    });
    return { surface: restoredSurface, evidence };
  }
  close(): void { if (this.pumpTimer) clearInterval(this.pumpTimer); }
  /** Daemon liveness and identity for the launcher; not a ControlWorkspace surface. */
  setPort(port: number): void { this.port = port; }
  health(): Record<string, unknown> { return { status: 'ok', startedAt: this.startedAt, uptimeSeconds: Math.floor((Date.now() - Date.parse(this.startedAt)) / 1000) }; }
  runtime(): Record<string, unknown> { return { pid: process.pid, cwd: process.cwd(), dataDir: this.dataDir, port: this.port || Number(process.env.PORT || 18787) }; }
  registerActor(input: { clientIdentity: string; label?: string; channel?: 'hermes' | 'local'; profileRef?: string; conversationRef?: string }): Promise<{ actor: Actor; binding: ActorBinding; credential?: string }> {
    const clientIdentity = input.clientIdentity?.trim();
    if (!clientIdentity) throw new ArcpError('invalid_request', 'clientIdentity is required');
    return this.store.mutate((state) => {
      let actor = state.actors.find((item) => item.clientIdentity === clientIdentity);
      let credential: string | undefined;
      if (!actor) { actor = { id: idFor('actor', clientIdentity), clientIdentity, label: input.label?.trim() || 'ARCP client', createdAt: now() }; state.actors.push(actor); credential = randomBytes(32).toString('base64url'); state.credentials[createHash('sha256').update(credential).digest('hex')] = actor.id; }
      const channel = input.channel ?? 'local'; const profileRef = input.profileRef?.trim(); const conversationRef = input.conversationRef?.trim();
      let binding = state.bindings.find((item) => item.actorId === actor!.id && item.channel === channel && item.profileRef === profileRef && item.conversationRef === conversationRef);
      if (!binding) { binding = { id: idFor('binding', `${actor.id}:${channel}:${profileRef ?? ''}:${conversationRef ?? ''}:1`), actorId: actor.id, channel, ...(profileRef ? { profileRef } : {}), ...(conversationRef ? { conversationRef } : {}), generation: 1, createdAt: now() }; state.bindings.push(binding); }
      return { actor, binding, ...(credential ? { credential } : {}) };
    });
  }
  actorForCredential(credential: string): Actor {
    const snapshot = this.store.snapshot(); const id = snapshot.credentials[createHash('sha256').update(credential).digest('hex')];
    const actor = snapshot.actors.find((item) => item.id === id);
    if (!actor) throw new ArcpError('unknown_sender', 'API key is not bound to an actor');
    return actor;
  }
  async bindActor(input: { actorId: string; remoteActorId?: string }): Promise<ActorBinding> {
    return this.store.mutate((state) => {
      if (!state.actors.some((item) => item.id === input.actorId)) throw new ArcpError('unknown_recipient', 'actor is not registered');
      throw new ArcpError('invalid_request', 'actor bindings are channel bindings and are created by actor register');
    });
  }
  async createGoal(input: { actorId: string; title: string; workspaceId?: string }): Promise<Goal> {
    if (!input.title?.trim()) throw new ArcpError('invalid_request', 'title is required');
    return this.store.mutate((state) => {
      if (!state.actors.some((item) => item.id === input.actorId)) throw new ArcpError('unknown_recipient', 'actor is not registered');
      const at = now(); const goal = { id: `goal_${randomUUID()}`, actorId: input.actorId, title: input.title.trim(), ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), state: 'active' as const, createdAt: at, updatedAt: at };
      state.goals.push(goal); return goal;
    });
  }
  /** One placement gate for every Paseo launch entry point.  A caller without
   * an explicit placement may continue when discovery is unavailable; an
   * explicit or already-canonical placement never silently degrades. */
  /** Compatibility bridge for existing wire fields. It records their resolved
   * adapter binding on the provider-neutral surface instead of making the
   * ControlWorkspace placement list the source of execution identity. */
  private async recordCompatibilitySurface(checkout: string, kind: ExecutionSurfaceKind, placement: CanonicalPaseoPlacement): Promise<ExecutionSurface> {
    const existing = this.store.snapshot().executionSurfaces.find((surface) => checkoutIdentity(surface.checkout.path) === checkoutIdentity(checkout));
    if (existing) return existing;
    // Compatibility callers historically passed synthetic paths in deterministic
    // tests. Real placement still resolves Git identity, while this bridge keeps
    // those persisted wire records readable until their callers migrate.
    const repository = await this.resolveRepository({ checkout }).catch(() => ({ id: `local:${checkout}`, root: checkout })); const at = now();
    const surface: ExecutionSurface = { id: idFor('surface', checkoutIdentity(checkout)), repositoryId: repository.id, checkout: { id: idFor('checkout', checkout), repositoryId: repository.id, path: checkout }, kind, operationalState: 'active', visibilityState: 'visible', adapterBindings: { paseo: { projectId: placement.projectId, workspaceId: placement.workspaceId } }, createdAt: at, updatedAt: at };
    await this.store.mutate((state) => { if (!state.executionSurfaces.some((item) => item.id === surface.id)) state.executionSurfaces.push(surface); });
    return surface;
  }
  private async resolvePaseoPlacement<T extends { workspace?: string; workspaceId?: string; paseoProjectId?: string; paseoWorkspaceId?: string; placementUnresolved?: string; title?: string; executionSurfaceId?: string }>(input: T): Promise<T> {
    if (!(this.adapter instanceof PaseoAdapter) || !input.workspaceId) return input;
    const state = this.store.snapshot();
    const requestedSurface = input.executionSurfaceId ? state.executionSurfaces.find((surface) => surface.id === input.executionSurfaceId) : undefined;
    if (input.executionSurfaceId && !requestedSurface) throw new ArcpError('not_found', 'execution surface not found');
    if (requestedSurface?.visibilityState === 'archived') throw new ArcpError('surface_archived', 'execution surface is archived; explicitly restore or unarchive it before reuse');
    const checkout = path.resolve(requestedSurface?.checkout.path ?? input.workspace ?? process.cwd());
    const controlWorkspace = state.workspaces.find((item) => item.id === input.workspaceId);
    if (requestedSurface) {
      const paseo = requestedSurface.adapterBindings.paseo;
      if (!paseo) throw new ArcpError('placement_unresolved', 'execution surface has no Paseo binding');
      if ((input.paseoProjectId && input.paseoProjectId !== paseo.projectId) || (input.paseoWorkspaceId && input.paseoWorkspaceId !== paseo.workspaceId)) throw new ArcpError('placement_conflict', `PLACEMENT_CONFLICT: requested placement differs from execution surface ${requestedSurface.id}`);
      return { ...input, workspace: checkout, paseoProjectId: paseo.projectId, paseoWorkspaceId: paseo.workspaceId, executionSurfaceId: requestedSurface.id };
    }
    const persisted = controlWorkspace?.paseoPlacements?.find((item) => item.checkout === checkout);
    if (input.paseoProjectId && input.paseoWorkspaceId) {
      const observed = await this.adapter.workspacePlacement(input.paseoWorkspaceId).catch(() => undefined);
      if (observed?.projectId && observed.projectId !== input.paseoProjectId) throw new ArcpError('placement_mismatch', 'PLACEMENT_MISMATCH: requested Paseo Project does not own the selected Workspace');
    }
    if (persisted && ((input.paseoProjectId && input.paseoProjectId !== persisted.projectId) || (input.paseoWorkspaceId && input.paseoWorkspaceId !== persisted.workspaceId))) throw new ArcpError('placement_conflict', `PLACEMENT_CONFLICT: checkout already uses Paseo Project ${persisted.projectId} and Workspace ${persisted.workspaceId}; reuse that canonical placement`);
    let canonical = persisted; let unresolved: string | undefined;
    if (!canonical) try { canonical = await this.adapter.materializePlacement({ checkout, projectId: input.paseoProjectId, workspaceId: input.paseoWorkspaceId, title: `ARCP · ${input.title?.trim() || 'runtime'}` }); }
    catch (error) {
      if (error instanceof PlacementConflict) throw new ArcpError('placement_conflict', error.message.startsWith('PLACEMENT_CONFLICT:') ? error.message : `PLACEMENT_CONFLICT: ${error.message}`);
      unresolved = 'PLACEMENT_UNRESOLVED: canonical Paseo placement could not be materialized before launch';
    }
    if (canonical) {
      if ((input.paseoProjectId && canonical.projectId !== input.paseoProjectId) || (input.paseoWorkspaceId && canonical.workspaceId !== input.paseoWorkspaceId)) throw new ArcpError('placement_conflict', `PLACEMENT_CONFLICT: requested placement differs from canonical Paseo Project ${canonical.projectId} and Workspace ${canonical.workspaceId}`);
      if (!persisted && controlWorkspace) await this.store.mutate((next) => { const workspace = next.workspaces.find((item) => item.id === input.workspaceId)!; workspace.paseoPlacements = [...(workspace.paseoPlacements ?? []), canonical!]; workspace.updatedAt = now(); });
      const surface = await this.recordCompatibilitySurface(checkout, 'working', canonical);
      return { ...input, paseoProjectId: canonical.projectId, paseoWorkspaceId: canonical.workspaceId, workspace: checkout, executionSurfaceId: surface.id };
    }
    if (input.paseoProjectId || input.paseoWorkspaceId || persisted) throw new ArcpError('placement_unresolved', unresolved ?? 'PLACEMENT_UNRESOLVED: requested Paseo placement could not be resolved before launch');
    return { ...input, workspace: checkout, ...(unresolved ? { placementUnresolved: unresolved } : {}) };
  }
  async startManaged(input: LaunchInput & { actorId: string; workspaceId: string; title: string; contract?: string; paseoProjectId?: string; paseoWorkspaceId?: string; workspace?: string; taskScope?: TaskScope; executionSurfaceId?: string; launchedByMemberId?: string; primaryHandlerMemberId?: string; ccMemberIds?: string[]; escalationMemberIds?: string[] }): Promise<ActionResult | { goal: Goal; task: Task; member: Member; session: RuntimeSession; credential: string; routingGuidance: string; selection: SelectionExplanation; selectionReceipt: SelectionReceipt }> {
    const state = this.store.snapshot(); if (!state.workspaces.some((item) => item.id === input.workspaceId && item.lifecycle === 'active')) throw new ArcpError('workspace_closed', 'team workspace is unavailable');
    const preflight = await this.preflight(input);
    if (!preflight.launchable) { await this.recordProviderBudgetEpisode(input.workspaceId, preflight.admission); return preflight; }
    try { input = await this.resolvePaseoPlacement(input); }
    catch (error) { return { ...preflight, action: 'hold', launchable: false, why: error instanceof ArcpError ? error.message : 'PLACEMENT_UNRESOLVED: canonical Paseo placement could not be resolved before launch' }; }
    // Resolve the profile through the same path used by preflight and launch.
    // Explicit provider/model requests intentionally do not become configured
    // profile entries, but they still carry the requested role into the member.
    const profile = this.requestedProfile(input);
    const role = input.role?.trim() || (profile.id === 'explicit' ? 'worker' : profile.role || 'worker');
    const capabilities = input.taskScope === 'steward_analysis' ? [...TASK_OWNER_CAPABILITIES] : defaultMemberCapabilities(role);
    // ARCP never tells a runtime to claim a Task it cannot claim. Roles that
    // can own work hold the capabilities to satisfy the handoff; a deliberate
    // observer role is told plainly that it owns no Task, instead of being
    // handed instructions that only fail at claim time.
    const taskHandoff = canOwnHandoffTask(capabilities);
    const goal = await this.createGoal({ actorId: input.actorId, title: input.title, workspaceId: input.workspaceId });
    const task = await this.createTask({ workspaceId: input.workspaceId, title: input.title, scope: input.taskScope, executionSurfaceId: input.executionSurfaceId });
    // Every failure after the Goal and Task exist retires the whole attempt:
    // the credential is issued before the runtime exists, so a launch that
    // never happens must leave neither an orphan credential nor an orphan
    // Goal/Task pair. `launch` reuses this already-admitted preflight rather
    // than running a second, divergent one.
    const runtimeId = `runtime_${randomUUID()}`; const writer = role.toLowerCase() === 'worker';
    let joinedMemberId: string | undefined;
    try {
      const joined = await this.joinWorkspace({ workspaceId: input.workspaceId, label: `managed-${preflight.profileId}`, role, joinKind: 'managed', actorId: input.actorId, capabilities });
      joinedMemberId = joined.member.id;
      if (!joined.credential) throw new ArcpError('internal_error', 'managed member credential was not issued');
      const reportingRoute = this.resolveReportingRoute({ workspaceId: input.workspaceId, launchedByMemberId: input.launchedByMemberId, primaryHandlerMemberId: input.primaryHandlerMemberId, ccMemberIds: input.ccMemberIds, escalationMemberIds: input.escalationMemberIds, fallbackMemberId: joined.member.id });
      const clientStatePath = await this.prepareRuntimeClientState(runtimeId, input.workspaceId, joined.member.id, joined.credential);
      const session = await this.launchOrRefuse({ ...input, actorId: input.actorId, goalId: goal.id, workspaceId: input.workspaceId, memberId: joined.member.id, taskId: task.id, taskHandoff, runtimeId, memberCredential: joined.credential, clientStatePath, writer, admittedPreflight: preflight, reportingRoute, ...(input.contract ? { contract: input.contract } : {}) } as LaunchInput & { actorId: string; goalId: string; workspace?: string; workspaceId?: string; placementUnresolved?: string; executionSurfaceId?: string; writer?: boolean; memberId?: string; taskId?: string; runtimeId?: string; memberCredential?: string; clientStatePath?: string; paseoProjectId?: string; paseoWorkspaceId?: string; admittedPreflight?: ActionResult; contract?: string; reportingRoute?: ReportingRoute });
      return { goal, task, member: joined.member, session, credential: joined.credential, routingGuidance: preflight.routingGuidance, selection: preflight.selection, selectionReceipt: preflight.selectionReceipt };
    } catch (error) { await this.abandonManagedLaunch({ memberId: joinedMemberId, runtimeId, goalId: goal.id, taskId: task.id }); throw error; }
  }
  private async recordProviderBudgetEpisode(workspaceId: string, admission?: AdmissionDecision): Promise<void> {
    if (!admission || !['drain', 'hard_drain'].includes(admission.action)) return;
    const snapshot = this.providerBudgetSnapshot; const provider = snapshot?.providers.find((item) => item.providerId === admission.providerId); const reset = provider?.windows.find((item) => admission.relevantWindows.includes(item.id))?.resetsAt ?? undefined; const id = idFor('event', providerBudgetEpisodeKey(workspaceId, admission.providerId, admission.relevantWindows, reset));
    if (this.store.snapshot().channelEvents.some((event) => event.id === id)) return;
    await this.publishChannelEvent({ id, workspaceId, targetRole: 'manager', kind: 'attention', urgency: admission.action === 'hard_drain' ? 'urgent' : 'normal', consumptionPolicy: 'ack_required', decisionRequired: false, summary: `Provider budget ${admission.providerId} is ${admission.action}`, evidenceRefs: [] });
  }
  /** Register one stable sibling Hermes ACP on-call Runtime. This is a new
   * external process sharing ARCP Workspace/Knowledge/Delivery; it does not
   * attach to the operator's Feishu Hermes conversation, which remains Owner. */
  /** Attach an ALREADY-RUNNING participant to an existing Member.
   *
   * `registerExternal` mints a new Member and launches a Hermes ACP process,
   * so it cannot represent a participant that is already alive and already
   * accountable — the Claude Manager of this Workspace is exactly that case.
   * Without an attach path such a participant has a Member but no
   * RuntimeSession, and every obligation addressed to it dead-letters with
   * "no live target runtime session" even though a human is sitting there.
   *
   * This never mints a Member, never launches anything, and never invents an
   * adapter: the caller names the participant channel and an opaque external
   * ref. Re-attaching is idempotent so a reconnect resumes one accountable
   * session instead of forking a second one at a new generation. */
  async attachParticipant(input: { workspaceId: string; memberId: string; adapterId: string; externalId: string; workspace?: string }): Promise<RuntimeSession> {
    const trimmedExternal = input.externalId?.trim();
    if (!trimmedExternal) throw new ArcpError('invalid_request', 'participant attach requires an external reference', 'externalId');
    if (!input.adapterId?.trim()) throw new ArcpError('invalid_request', 'participant attach requires an adapter id', 'adapterId');
    return this.store.mutate((state) => {
      const workspace = state.workspaces.find((item) => item.id === input.workspaceId && item.lifecycle === 'active');
      if (!workspace) throw new ArcpError('workspace_closed', 'team workspace is unavailable');
      const member = state.members.find((item) => item.id === input.memberId && item.workspaceId === input.workspaceId);
      if (!member) throw new ArcpError('unknown_recipient', 'member is not in this workspace');
      const existing = state.sessions.find((item) => item.memberId === member.id && item.runtimeKind === 'external' && item.state !== 'terminal');
      if (existing) {
        // An attach must be repeatable. Changing the adapter or the external
        // ref under a live session would silently redirect delivery, so that
        // is a conflict rather than an update.
        if (existing.adapterId !== input.adapterId || existing.externalId !== trimmedExternal) throw new ArcpError('placement_conflict', `member ${member.id} is already attached to ${existing.adapterId} session ${existing.externalId ?? 'unknown'}`);
        return existing;
      }
      const binding = member.actorId ? state.bindings.find((item) => item.actorId === member.actorId) : undefined;
      const session: RuntimeSession = {
        id: `runtime_${randomUUID()}`,
        actorId: member.actorId ?? workspace.ownerActorId,
        goalId: `goal_attached_${member.id}`,
        bindingId: binding?.id ?? `binding_attached_${member.id}`,
        generation: 1,
        runtimeKind: 'external',
        adapterId: input.adapterId,
        workspaceId: input.workspaceId,
        memberId: member.id,
        profileId: 'attached-participant',
        provider: input.adapterId,
        model: 'attached',
        externalId: trimmedExternal,
        workspace: input.workspace,
        // An attached participant is reachable but its safe points are only as
        // good as its channel's observation; it starts idle and is corrected by
        // whatever observation the adapter can actually provide.
        state: 'idle',
        lastTurnState: 'idle',
        createdAt: now(),
      };
      state.sessions.push(session);
      return session;
    });
  }
  async registerExternal(input: { actorId: string; workspaceId: string; label?: string; role?: string; workspace?: string }): Promise<{ member: Member; session: RuntimeSession; credential?: string }> {
    const state = this.store.snapshot();
    if (!state.workspaces.some((item) => item.id === input.workspaceId && item.lifecycle === 'active')) throw new ArcpError('workspace_closed', 'team workspace is unavailable');
    const label = input.label?.trim() || 'hermes-acp-on-call';
    const prior = state.sessions.find((item) => item.runtimeKind === 'external' && item.adapterId === 'hermes-acp' && item.workspaceId === input.workspaceId && item.memberId && state.members.find((member) => member.id === item.memberId)?.label === label && item.state !== 'terminal');
    if (prior) { const adapter = this.adapters.get('hermes-acp') as RuntimeAdapter & { reconcileExternal?: (externalId: string) => Promise<boolean> } | undefined; if (adapter?.reconcileExternal && !(await adapter.reconcileExternal(prior.externalId ?? ''))) { await this.store.mutate((next) => { next.sessions.find((item) => item.id === prior.id)!.state = 'transport_indeterminate'; }); } const member = state.members.find((item) => item.id === prior.memberId)!; return { member, session: this.store.snapshot().sessions.find((item) => item.id === prior.id)! }; }
    const goal = await this.createGoal({ actorId: input.actorId, title: `External Hermes ACP ${label}`, workspaceId: input.workspaceId });
    const task = await this.createTask({ workspaceId: input.workspaceId, title: `External Hermes ACP ${label}` });
    const binding = this.store.snapshot().bindings.find((item) => item.actorId === input.actorId); if (!binding) throw new ArcpError('unknown_recipient', 'actor or binding is not registered');
    const runtimeId = `runtime_${randomUUID()}`;
    let joinedMemberId: string | undefined;
    try {
      const joined = await this.joinWorkspace({ workspaceId: input.workspaceId, label, role: input.role?.trim() || 'on-call', joinKind: 'managed', actorId: input.actorId, capabilities: [...TASK_OWNER_CAPABILITIES] });
      joinedMemberId = joined.member.id;
      if (!joined.credential) throw new ArcpError('internal_error', 'external member credential was not issued');
      const session: RuntimeSession = { id: runtimeId, actorId: input.actorId, goalId: goal.id, taskId: task.id, bindingId: binding.id, generation: 1, runtimeKind: 'external', adapterId: 'hermes-acp', workspaceId: input.workspaceId, memberId: joined.member.id, profileId: 'hermes-acp', provider: 'hermes', model: 'hermes-agent', workspace: input.workspace, state: 'launching', createdAt: now() };
      await this.store.mutate((next) => { next.sessions.push(session); });
      const clientStatePath = await this.prepareRuntimeClientState(session.id, input.workspaceId, joined.member.id, joined.credential);
      const launched = asRecord((await this.adapters.get('hermes-acp')!.launch({ id: 'hermes-acp', provider: 'hermes', model: 'hermes-agent', role: 'worker' }, goal.title, input.workspace, { workspaceId: input.workspaceId, taskId: task.id, memberId: joined.member.id, runtimeId: session.id, memberCredential: joined.credential, clientStatePath })).value);
      const externalId = String(launched.id ?? launched.sessionId ?? launched.acpSessionId ?? ''); if (!externalId) throw new Error('Hermes ACP did not return a session identity');
      await this.store.mutate((next) => { const item = next.sessions.find((value) => value.id === session.id)!; item.externalId = externalId; item.acpSessionId = String(launched.acpSessionId ?? externalId); item.pid = typeof launched.pid === 'number' ? launched.pid : undefined; item.lastTurnState = 'idle'; item.state = 'idle'; return item; });
      return { member: joined.member, session: this.store.snapshot().sessions.find((item) => item.id === session.id)!, credential: joined.credential };
    } catch (error) {
      await this.abandonManagedLaunch({ memberId: joinedMemberId, runtimeId, goalId: goal.id, taskId: task.id });
      throw error;
    }
  }
  async stopRuntime(id: string): Promise<RuntimeSession> {
    const session = this.store.snapshot().sessions.find((item) => item.id === id); if (!session) throw new ArcpError('not_found', 'runtime session not found');
    if (session.externalId) await this.adapterFor(session).stop(session.externalId).catch(() => undefined);
    return this.store.mutate((state) => { const item = state.sessions.find((value) => value.id === id)!; item.state = 'terminal'; item.lastTurnState = 'idle'; return item; });
  }
  async setGoalState(id: string, stateValue: GoalState): Promise<Goal> {
    if (!['active', 'completed', 'cancelled'].includes(stateValue)) throw new ArcpError('invalid_request', 'invalid goal state');
    return this.store.mutate((state) => { const goal = state.goals.find((item) => item.id === id); if (!goal) throw new ArcpError('not_found', 'goal not found'); goal.state = stateValue; goal.updatedAt = now(); return goal; });
  }
  profiles() { return this.profileData.map((profile) => ({ ...profile, paidModelAutoSelection: false, permissionStrategy: profile.provider === 'pi' ? 'provider-managed' : 'arcp-mode' })); }
  providerBudget() { return this.providerBudgetSnapshot; }
  recordRuntimeBudgetSample(sample: RuntimeBudgetSample): boolean { return this.runtimeBudget.record(sample); }
  runtimeBudgetView(runtimeSessionId: string): RuntimeBudgetView { return this.runtimeBudget.view(runtimeSessionId, this.runtimeBudgetPolicy); }
  async refreshProviderBudget(sourceId?: string): Promise<{ snapshot?: ProviderBudgetEnvelopeV1; status: 'ok' | 'source_unavailable'; error?: string }> {
    const configured = this.providerBudgetConfig.sources ?? []; const sources = sourceId ? configured.filter((item) => item.id === sourceId) : [...configured].sort((a, b) => Number(b.automaticAdmissionEligible) - Number(a.automaticAdmissionEligible));
    if (!sources.length) return { status: 'source_unavailable', error: 'no provider budget source is configured' };
    for (const source of sources) try { const snapshot = source.kind === 'codexbar' ? await collectCodexbar(source.id) : source.kind === 'command' ? await runCommandCollector(source) : source.kind === 'pi-grok-cache' ? await collectPiGrokCache(source) : source.kind === 'paseo' && this.adapter instanceof PaseoAdapter ? await this.adapter.providerUsage(source.id) : undefined; if (snapshot) { this.providerBudgetSnapshot = snapshot; return { status: 'ok', snapshot }; } } catch { /* try the next configured source without retaining diagnostics */ }
    return { status: 'source_unavailable', error: 'provider budget source failed without a safe snapshot' };
  }
  async discovery(): Promise<{ available: boolean; profiles: Array<Record<string, unknown>> }> {
    try {
      const providers = (await this.adapter.discover()).value;
      if (!Array.isArray(providers)) throw new Error('provider listing is not an array');
      const profiles = await Promise.all(this.profiles().map(async (profile) => {
        const provider = providers.map(asRecord).find((item) => String(item.provider).toLowerCase() === profile.provider);
        const providerAvailable = normalized(provider?.status) === 'available' && normalized(provider?.enabled) !== 'disabled';
        const sdkModes = await this.adapter.modes(profile.provider);
        const modes = sdkModes?.length ? sdkModes : this.cliModeIds(provider?.modes);
        try {
          const models = (await this.adapter.models(profile.provider)).value;
          const model = Array.isArray(models) ? models.map(asRecord).find((item) => String(item.id).toLowerCase() === profile.model.toLowerCase()) : undefined;
          const thinking = !profile.thinking || (Array.isArray(model?.thinkingOptionIds) && model.thinkingOptionIds.map(String).includes(profile.thinking));
          const mode = !profile.mode || modes.some((item) => sameSetting(item, profile.mode));
          return { ...profile, available: providerAvailable && Boolean(model) && thinking && mode };
        } catch { return { ...profile, available: false }; }
      }));
      return { available: true, profiles };
    } catch { return { available: false, profiles: this.profiles().map((profile) => ({ ...profile, available: false })) }; }
  }
  private cliModeIds(value: unknown): string[] {
    const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
    return values.map((item) => {
      const raw = typeof item === 'string' ? item.trim() : setting(safeJson(item).id);
      const token = capabilityToken(raw ?? '');
      // Paseo's public provider listing sometimes exposes human labels rather
      // than IDs. Canonicalize only exact known labels; never substring-match.
      if (token === 'automode' || token === 'defaultpermissions') return 'auto';
      if (token === 'autoreview') return 'auto-review';
      if (token === 'fullaccess') return 'full-access';
      if (token === 'bypass') return 'bypassPermissions';
      if (token === 'planmode') return 'plan';
      return raw;
    }).filter((item): item is string => Boolean(item));
  }
  private requestedProfile(input: LaunchInput): Profile {
    const explicit = [input.provider, input.model, input.mode, input.thinking].some((value) => value !== undefined);
    if (input.profileId && explicit) throw new ArcpError('invalid_request', 'use either a named profile or explicit provider/model/mode/thinking');
    if (input.profileId || !explicit) {
      const roleIntent = input.role?.trim();
      const selectedProfileId = input.profileId ?? (roleIntent ? this.profileData.find((item) => sameSetting(item.role, roleIntent))?.id : 'codex-worker');
      const profile = this.profileData.find((item) => item.id === selectedProfileId);
      if (!profile) throw new ArcpError('invalid_request', roleIntent ? `no launch profile matches role intent ${roleIntent}` : 'unknown launch profile', roleIntent ? 'role' : 'profileId');
      if (capabilityToken(profile.provider) === 'pi' && profile.mode) throw new ArcpError('invalid_request', 'Pi/Grok has no ARCP mode; omit --mode');
      return profile;
    }
    if (!input.provider?.trim() || !input.model?.trim()) throw new ArcpError('invalid_request', 'explicit launch requires provider and model');
    if (capabilityToken(input.provider) === 'pi' && input.mode) throw new ArcpError('invalid_request', 'Pi/Grok has no ARCP mode; omit --mode');
    const mode = setting(input.mode); const thinking = setting(input.thinking);
    return { id: 'explicit', provider: input.provider.trim(), model: input.model.trim(), ...(mode ? { mode } : {}), ...(thinking ? { thinking } : {}), role: 'explicit' };
  }
  private selectionExplanation(input: LaunchInput, profile: Profile): SelectionExplanation {
    const explicitSettings = [input.provider, input.model, input.mode, input.thinking].some((value) => value !== undefined);
    const selection: SelectionExplanation['selection'] = explicitSettings ? 'explicit-settings' : input.profileId ? 'named-profile' : input.role?.trim() ? 'role-intent' : 'default-profile';
    const roleIntent = input.role?.trim() || profile.role;
    const selectedProfile = { id: profile.id, provider: profile.provider, model: profile.model, ...(profile.mode ? { mode: profile.mode } : {}), ...(profile.thinking ? { thinking: profile.thinking } : {}), role: profile.role };
    // A role narrows the configured choices; it never authorizes a silent
    // provider or permission-mode substitution. Operators choose an
    // alternative profile explicitly after seeing this guidance.
    const alternatives = selection === 'role-intent'
      ? this.profileData.filter((item) => item.id !== profile.id && sameSetting(item.role, roleIntent)).map((item) => ({ id: item.id, provider: item.provider, model: item.model, ...(item.mode ? { mode: item.mode } : {}), ...(item.thinking ? { thinking: item.thinking } : {}), role: item.role, reason: 'matches the same role intent; select it explicitly to change provider or mode' }))
      : [];
    return { roleIntent, selection, selectedProfile, alternatives };
  }
  private selectionReceipt(input: LaunchInput, profile: Profile, selection: SelectionExplanation): SelectionReceipt {
    const chosenRole = input.role?.trim() || (profile.id === 'explicit' ? 'worker' : profile.role);
    const reason = selection.selection === 'role-intent'
      ? `role intent ${chosenRole} selected configured profile ${profile.id}`
      : selection.selection === 'named-profile'
        ? `explicit profile ${profile.id} was requested`
        : selection.selection === 'explicit-settings'
          ? 'explicit provider and model settings were requested'
          : `default profile ${profile.id} was selected`;
    return { chosenRole, provider: profile.provider, model: profile.model, thinking: profile.thinking ?? null, mode: profile.mode ?? null, reason, quotaSnapshot: this.providerBudgetSnapshot ? structuredClone(this.providerBudgetSnapshot) : null };
  }
  async preflight(input: LaunchInput): Promise<ActionResult> {
    const profile = this.requestedProfile(input); const selection = this.selectionExplanation(input, profile); const selectionReceipt = this.selectionReceipt(input, profile, selection); const requested: RuntimeSettings = { provider: profile.provider, model: profile.model, ...(profile.mode ? { mode: profile.mode } : {}), ...(profile.thinking ? { thinking: profile.thinking } : {}) };
    const discovered = await this.discovery();
    let live = discovered.profiles.find((item) => item.id === profile.id)?.available === true;
    let liveModes: string[] = [];
    try {
      const providers = (await this.adapter.discover()).value; const provider = Array.isArray(providers) ? providers.map(asRecord).find((item) => normalized(item.provider) === normalized(profile.provider)) : undefined;
      const sdkModes = await this.adapter.modes(profile.provider); liveModes = sdkModes?.length ? sdkModes : this.cliModeIds(provider?.modes);
      if (profile.id === 'explicit') {
        const models = (await this.adapter.models(profile.provider)).value; const model = Array.isArray(models) ? models.map(asRecord).find((item) => sameSetting(item.id, profile.model)) : undefined;
        live = normalized(provider?.status) === 'available' && normalized(provider?.enabled) !== 'disabled' && Boolean(model) && (!profile.mode || liveModes.some((mode) => sameSetting(mode, profile.mode))) && (!profile.thinking || (Array.isArray(model?.thinkingOptionIds) && model.thinkingOptionIds.some((value: unknown) => sameSetting(value, profile.thinking))));
      }
    } catch { /* discovery receipt remains truthful */ }
    // An operator refresh makes quota admission authoritative. Until then,
    // interactive launches remain governed by their normal live validation;
    // unattended work still asks the fail-closed evaluator for a verdict.
    const quotaAdmissionRequired = Boolean(input.unattended || (profile.provider === 'pi' && profile.model.startsWith('grok-cli/')));
    const admission = this.providerBudgetSnapshot || quotaAdmissionRequired ? evaluateAdmission({ envelope: this.providerBudgetSnapshot, bindings: this.providerBudgetConfig.bindings ?? [], policies: this.providerBudgetConfig.policies ?? [], providerId: profile.provider, model: profile.model, unattended: input.unattended, activeRuntimeCount: this.store.snapshot().sessions.filter((session) => session.provider === profile.provider && session.state !== 'terminal').length }) : undefined;
    const runtimeSignals = this.store.snapshot().sessions.filter((session) => session.provider === profile.provider && session.state !== 'terminal').flatMap((session) => this.runtimeBudget.view(session.id, this.runtimeBudgetPolicy).signals);
    const admissionHold = admission ? ['drain', 'hard_drain', 'hold_stale', 'hold_unknown', 'route'].includes(admission.action) : false;
    const action = (value: Omit<ActionResult, 'routingGuidance' | 'selection' | 'selectionReceipt'>): ActionResult => ({ ...value, routingGuidance: this.routingGuidanceText, selection, selectionReceipt });
    if (!live) return action({ action: 'hold', launchable: false, why: 'requested provider, model, thinking, or mode is not live-validated', requested, effective: requested, profileId: profile.id, recommendedCommands: [], liveModes, admission });
    if (runtimeSignals.length) return action({ action: 'hold', launchable: false, why: `runtime budget signals: ${[...new Set(runtimeSignals)].join(', ')}`, requested, effective: requested, profileId: profile.id, recommendedCommands: [], liveModes, admission, runtimeSignals: [...new Set(runtimeSignals)] });
    if (admission?.action === 'drain' && admission.recommendedProviderProfile) { const target = this.profileData.find((item) => item.id === admission.recommendedProviderProfile); const bound = target && this.providerBudgetConfig.bindings?.some((item) => item.providerId === target.provider && item.sourceId === this.providerBudgetSnapshot?.source.id && (!item.modelPatterns?.length || item.modelPatterns.some((pattern) => matchesModel(pattern, target.model)))); if (target && bound) return action({ action: 'route', launchable: false, why: 'provider budget requires explicit route approval', requested, effective: requested, profileId: profile.id, recommendedCommands: [`arcp start --profile ${target.id} --title '<goal>'`], liveModes, admission }); }
    if (admission && admissionHold) return action({ action: admission.action === 'route' ? 'route' : 'hold', launchable: false, why: `provider budget admission is ${admission.action}`, requested, effective: requested, profileId: profile.id, recommendedCommands: [], liveModes, admission });
    const requiredRank = Boolean(input.unattended) ? 2 : 1;
    const needsElevation = ['claude', 'codex'].includes(profile.provider) && safeModeRank(profile.provider, profile.mode) < requiredRank;
    const recommendationRank = input.unattended ? requiredRank : profile.provider === 'codex' ? 3 : 2;
    // An elevation recommendation may change the permission mode and nothing
    // else. Offering a different role or model would push the caller across a
    // role boundary or a price tier to satisfy a permission requirement, which
    // is the coupling that role-as-intent exists to break. An explicit
    // provider/model request declares no role intent, so only its model binds.
    const providerRecommendations = this.profileData.filter((item) => item.provider === profile.provider && item.id !== profile.id && sameSetting(item.model, profile.model) && (profile.role === 'explicit' || sameSetting(item.role, profile.role)) && safeModeRank(item.provider, item.mode) >= recommendationRank && liveModes.some((mode) => sameSetting(mode, item.mode))).sort((a, b) => safeModeRank(a.provider, a.mode) - safeModeRank(b.provider, b.mode)).map((item) => `arcp start --profile ${item.id} --title '<goal>'${input.unattended ? ' --unattended' : ''}`);
    if (needsElevation && providerRecommendations.length) return action({ action: 'hold', launchable: false, why: input.unattended ? 'unattended work requires an explicit stronger live mode' : 'requested mode is below the provider default auto', requested, effective: requested, profileId: profile.id, recommendedCommands: providerRecommendations, liveModes });
    if (needsElevation) return action({ action: 'warn', launchable: true, why: 'requested mode is weaker than the provider default and no stronger live mode is available; ARCP will not substitute one', requested, effective: requested, profileId: profile.id, recommendedCommands: providerRecommendations, liveModes });
    return action({ action: 'launch', launchable: true, why: 'requested settings are live-validated without substitution', requested, effective: requested, profileId: profile.id, recommendedCommands: [], liveModes, admission });
  }
  /** `launch` reports a classified adapter refusal by returning a session
   * rather than throwing. A managed start cannot accept that: without an
   * adapter receipt no runtime exists to hold the credential, Goal and Task,
   * so an unusable session is turned back into a raised launch failure. */
  private async launchOrRefuse(input: Parameters<ArcpService['launch']>[0]): Promise<RuntimeSession> {
    const session = await this.launch(input);
    if (!session.externalId) throw new ArcpError('launch_failed', `runtime launch returned no usable session (state ${session.state})`);
    return session;
  }
  async launch(input: LaunchInput & { actorId: string; goalId: string; workspace?: string; workspaceId?: string; paseoProjectId?: string; paseoWorkspaceId?: string; placementUnresolved?: string; executionSurfaceId?: string; writer?: boolean; memberId?: string; taskId?: string; runtimeId?: string; memberCredential?: string; clientStatePath?: string; admittedPreflight?: ActionResult; contract?: string; reportingRoute?: ReportingRoute; taskHandoff?: boolean }): Promise<RuntimeSession> {
    const preflight = input.admittedPreflight ?? await this.preflight(input); if (!preflight.launchable) throw new ArcpError(preflight.why.startsWith('requested provider') ? 'profile_unavailable' : 'launch_held', preflight.why);
    const profile = this.requestedProfile(input);
    const state = this.store.snapshot();
    const goal = state.goals.find((item) => item.id === input.goalId && item.actorId === input.actorId);
    const binding = state.bindings.find((item) => item.actorId === input.actorId);
    if (!goal || !binding) throw new ArcpError('unknown_recipient', 'actor or goal is not registered');
    if (input.memberId && !state.members.some((item) => item.id === input.memberId && (!input.workspaceId || item.workspaceId === input.workspaceId))) throw new ArcpError('unknown_recipient', 'managed member is not in workspace');
    input = await this.resolvePaseoPlacement(input);
    if (state.sessions.some((item) => item.goalId === goal.id && item.state !== 'terminal')) {
      throw new ArcpError('goal_held', 'goal already has a primary runtime session');
    }
    const generation = Math.max(0, ...state.sessions.filter((item) => item.goalId === goal.id).map((item) => item.generation)) + 1;
    const session: RuntimeSession = { id: input.runtimeId ?? `runtime_${randomUUID()}`, actorId: input.actorId, goalId: goal.id, ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.reportingRoute ? { reportingRoute: input.reportingRoute } : {}), ...(input.executionSurfaceId ? { executionSurfaceId: input.executionSurfaceId } : {}), bindingId: binding.id, generation, runtimeKind: 'paseo', adapterId: 'paseo', ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), ...(input.memberId ? { memberId: input.memberId } : {}), profileId: profile.id, provider: profile.provider, model: profile.model, ...(profile.mode ? { mode: profile.mode } : {}), ...(profile.thinking ? { thinking: profile.thinking } : {}), selectionReceipt: preflight.selectionReceipt, placement: { requested: { ...(input.paseoProjectId ? { projectId: input.paseoProjectId } : {}), ...(input.paseoWorkspaceId ? { workspaceId: input.paseoWorkspaceId } : {}) }, ...(input.placementUnresolved ? { unresolved: input.placementUnresolved } : {}) }, workspace: input.workspace, state: 'launching', createdAt: now() };
    await this.store.mutate((next) => { next.sessions.push(session); });
    if (input.executionSurfaceId) await this.launchRuntime({ executionSurfaceId: input.executionSurfaceId, runtimeSessionId: session.id, writer: input.writer });
    try {
      const result = asRecord((await this.adapter.launch(profile, goal.title, input.workspace, { workspaceId: input.workspaceId, paseoProjectId: input.paseoProjectId, paseoWorkspaceId: input.paseoWorkspaceId, taskId: input.taskId, memberId: input.memberId, runtimeId: session.id, memberCredential: input.memberCredential, clientStatePath: input.clientStatePath, ...(input.taskHandoff === false ? { taskHandoff: false } : {}), ...(input.reportingRoute ? { reportingRoute: input.reportingRoute } : {}), ...(input.contract ? { contract: input.contract } : {}) })).value);
      const externalId = launchReceiptIdentity(result);
      if (!externalId) throw new Error('Paseo did not return a runtime identity');
      // Persist the opaque handle before postflight: reconcile must remain possible
      // when launch succeeded but the immediate observation timed out.
      await this.store.mutate((next) => { const item = next.sessions.find((value) => value.id === session.id)!; item.externalId = externalId; item.placement!.requested.agentId = externalId; for (const runtimeBinding of next.runtimeBindings.filter((value) => value.runtimeSessionId === session.id)) runtimeBinding.nativeId = externalId; });
      const snapshot = await this.adapterFor(session).snapshot(externalId); const inspected = snapshot.agent;
      const workspacePlacement = input.paseoWorkspaceId && this.adapter instanceof PaseoAdapter ? await this.adapter.workspacePlacement(input.paseoWorkspaceId) : undefined;
      const observed = [inspected.provider ?? inspected.Provider, inspected.model ?? inspected.Model, inspected.currentModeId ?? inspected.mode ?? inspected.Mode, inspected.effectiveThinkingOptionId ?? inspected.thinkingOptionId ?? inspected.thinking ?? inspected.Thinking];
      const expected = [profile.provider, profile.model, profile.mode, profile.thinking];
      const matchesPlan = expected.every((expectedValue, index) => !expectedValue || sameSetting(expectedValue, observed[index]));
      return this.store.mutate((next) => { const stored = next.sessions.find((item) => item.id === session.id)!; stored.observed = { ...(setting(observed[0]) ? { provider: String(observed[0]) } : {}), ...(setting(observed[1]) ? { model: String(observed[1]) } : {}), ...(setting(observed[2]) ? { mode: String(observed[2]) } : {}), ...(setting(observed[3]) ? { thinking: String(observed[3]) } : {}) }; stored.placement!.observed = { ...workspacePlacement, ...paseoPlacement(inspected) }; stored.placement!.status = placementMatches(stored.placement!) ? 'PLACEMENT_MATCH' : 'PLACEMENT_MISMATCH'; stored.state = stored.placement!.status === 'PLACEMENT_MISMATCH' ? 'placement_mismatch' : matchesPlan ? sessionState(inspected.status ?? inspected.Status) : 'attention'; stored.lastObservedAt = now(); for (const runtimeBinding of next.runtimeBindings.filter((value) => value.runtimeSessionId === session.id)) runtimeBinding.state = stored.state; return stored; });
    } catch (error) {
      // A failure before any adapter receipt means no runtime exists: there is
      // no opaque handle to reconcile later, so the session is terminal and the
      // failure is raised rather than dressed up as transport uncertainty.
      // Only a failure after the receipt was persisted is genuinely
      // indeterminate, because reconcile can still resolve it.
      // A launch with no adapter receipt is genuinely uncertain rather than
      // known-failed - the CLI may have created an agent whose identity ARCP
      // never learned - so the session keeps its uncertainty. `launchOrRefuse`
      // is what turns an unusable session back into a raised failure for the
      // callers that issued a credential against it.
      return this.store.mutate((next) => { const stored = next.sessions.find((item) => item.id === session.id)!; stored.state = isPaseoTitleRejected(error) ? 'attention' : 'transport_indeterminate'; for (const runtimeBinding of next.runtimeBindings.filter((value) => value.runtimeSessionId === session.id)) runtimeBinding.state = stored.state; return stored; });
    }
  }
  async observe(id: string): Promise<RuntimeSession> {
    const prior = this.store.snapshot().sessions.find((item) => item.id === id);
    if (!prior) throw new ArcpError('not_found', 'runtime session not found');
    const externalId = await this.canonicalRuntimeIdentity(prior);
    if (!externalId) return this.store.snapshot().sessions.find((item) => item.id === id)!;
    try {
      const snapshot = await this.adapterFor(prior).snapshot(externalId); const observed = snapshot.agent;
      const updated = await this.store.mutate((state) => {
        const item = state.sessions.find((value) => value.id === id)!;
        item.observed = { ...(setting(observed.provider ?? observed.Provider) ? { provider: String(observed.provider ?? observed.Provider) } : {}), ...(setting(observed.model ?? observed.Model) ? { model: String(observed.model ?? observed.Model) } : {}), ...(setting(observed.currentModeId ?? observed.mode ?? observed.Mode) ? { mode: String(observed.currentModeId ?? observed.mode ?? observed.Mode) } : {}), ...(setting(observed.effectiveThinkingOptionId ?? observed.thinkingOptionId ?? observed.thinking ?? observed.Thinking) ? { thinking: String(observed.effectiveThinkingOptionId ?? observed.thinkingOptionId ?? observed.thinking ?? observed.Thinking) } : {}) };
        if (item.placement) { item.placement.observed = paseoPlacement(observed); item.placement.status = placementMatches(item.placement) ? 'PLACEMENT_MATCH' : 'PLACEMENT_MISMATCH'; }
        if (setting(observed.lastDeliveryId)) item.lastDeliveryId = String(observed.lastDeliveryId);
        if (setting(observed.lastTurnState)) item.lastTurnState = normalizedTurnState(observed.lastTurnState);
        // An attached participant declares no plan of its own, so observation is
        // the only truth there is: adopt it rather than diffing against the
        // adapter identity it was attached with.
        if (isAttachedParticipant(item)) { if (item.observed.provider) item.provider = item.observed.provider; if (item.observed.model) item.model = item.observed.model; if (item.observed.mode) item.mode = item.observed.mode; if (item.observed.thinking) item.thinking = item.observed.thinking; }
        const requested = isAttachedParticipant(item) ? [] : [item.provider, item.model, item.mode, item.thinking]; const actual = [item.observed.provider, item.observed.model, item.observed.mode, item.observed.thinking];
        item.state = item.placement?.status === 'PLACEMENT_MISMATCH' ? 'placement_mismatch' : requested.every((value, index) => !value || sameSetting(value, actual[index])) ? sessionState(observed.status ?? observed.Status) : 'attention'; item.lastObservedAt = now();
        for (const delivery of state.deliveries.filter((value) => value.runtimeSessionId === id && value.generation === item.generation && ['delivered', 'running'].includes(value.state))) {
          if (item.state === 'running') delivery.state = 'running';
          else if (item.state === 'idle' || item.state === 'terminal') { delivery.state = 'processed'; delivery.processedAt = now(); const event = delivery.eventId ? state.channelEvents.find((value) => value.id === delivery.eventId) : undefined; if (event) this.transitionEvent(event, 'processed', delivery.processedAt); }
        }
        return item;
      });
      if (!this.pumping) void this.pump(); return updated;
    } catch { const uncertain = await this.store.mutate((state) => { const item = state.sessions.find((value) => value.id === id)!; item.state = 'transport_indeterminate'; return item; }); await this.emitTransportUncertainty(uncertain); return uncertain; }
  }
  async reconcile(id: string): Promise<RuntimeSession> {
    const prior = this.store.snapshot().sessions.find((item) => item.id === id);
    if (!prior) throw new ArcpError('not_found', 'runtime session not found');
    const externalId = await this.canonicalRuntimeIdentity(prior);
    try {
      if (prior.runtimeKind === 'external') {
        const adapter = this.adapterFor(prior) as RuntimeAdapter & { reconcileExternal?: (externalId: string) => Promise<boolean> };
        const valid = adapter.reconcileExternal ? await adapter.reconcileExternal(externalId ?? '') : false;
        if (!valid) { const uncertain = await this.store.mutate((state) => { const item = state.sessions.find((value) => value.id === id)!; item.state = 'transport_indeterminate'; return item; }); await this.emitTransportUncertainty(uncertain); return uncertain; }
      }
      const agents = (await this.adapterFor(prior).registry()).value;
      const match = Array.isArray(agents) ? agents.map(asRecord).find((item) => launchReceiptIdentity(item) === externalId) : undefined;
      if (!match) {
        // The registry is Paseo's active-membership source. A known Agent ID
        // absent from that registry is parked/archived, not an indeterminate
        // transport; retain the durable ARCP row and placement history.
        if (externalId) return this.store.mutate((state) => { const item = state.sessions.find((value) => value.id === id)!; item.state = 'terminal'; item.lastTurnState = 'idle'; item.lastObservedAt = now(); return item; });
        const uncertain = await this.store.mutate((state) => { const item = state.sessions.find((value) => value.id === id)!; item.state = 'transport_indeterminate'; return item; }); await this.emitTransportUncertainty(uncertain); return uncertain;
      }
      return this.store.mutate((state) => { const item = state.sessions.find((value) => value.id === id)!; if (item.placement) { item.placement.observed = paseoPlacement(match); item.placement.status = placementMatches(item.placement) ? 'PLACEMENT_MATCH' : 'PLACEMENT_MISMATCH'; } item.state = item.placement?.status === 'PLACEMENT_MISMATCH' ? 'placement_mismatch' : sessionState(match.status ?? match.Status ?? match.lifecycle); item.lastObservedAt = now(); return item; });
    } catch { const uncertain = await this.store.mutate((state) => { const item = state.sessions.find((value) => value.id === id)!; item.state = 'transport_indeterminate'; return item; }); await this.emitTransportUncertainty(uncertain); return uncertain; }
  }
  private cacheThresholds() { return { expiringMinutes: Number(process.env.ARCP_CACHE_EXPIRING_MINUTES ?? CLAUDE_CACHE_DEFAULTS.expiringMinutes), expiredMinutes: Number(process.env.ARCP_CACHE_EXPIRED_MINUTES ?? CLAUDE_CACHE_DEFAULTS.expiredMinutes) }; }
  private cacheState(agent: Record<string, any>, timeline: unknown[] = []) {
    const turn = safeJson(agent.activeTurn); const times = [agent.lastUserMessageAt, agent.lastActivityAt, turn.startedAt, ...timeline.map((item) => safeJson(item).timestamp ?? safeJson(item).at ?? safeJson(item).createdAt)].map(setting).filter((value): value is string => Boolean(value && Number.isFinite(Date.parse(value))));
    const activityAt = times.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    const ageMinutes = activityAt && Number.isFinite(Date.parse(activityAt)) ? Math.max(0, (Date.now() - Date.parse(activityAt)) / 60_000) : undefined;
    const thresholds = this.cacheThresholds(); const state = ageMinutes === undefined ? 'unknown' as const : ageMinutes < thresholds.expiringMinutes ? 'fresh' as const : ageMinutes < thresholds.expiredMinutes ? 'expiring' as const : 'expired' as const;
    return { activityAt, ageMinutes, state };
  }
  private async facts(session: RuntimeSession) {
    const externalId = await this.canonicalRuntimeIdentity(session);
    if (!externalId) throw new ArcpError('unknown_recipient', 'recipient is not registered');
    const adapter = this.adapterFor(session); const snapshot = await adapter.snapshot(externalId); const children = await this.children(externalId, adapter); const turn = safeJson(snapshot.agent.activeTurn);
    return { agent: snapshot.agent, activeTurn: `${turn.turnId ?? turn.id ?? ''}:${turn.startedAt ?? ''}:${Boolean(turn.turnId ?? turn.id)}`, childSet: `${children.source}:${children.items.map((child) => `${child.id}:${child.status}`).sort().join(',')}`, cache: this.cacheState(snapshot.agent, snapshot.timeline) };
  }
  private async confirmationReceipt(kind: Confirmation['kind'], session: RuntimeSession, input: { actorId: string; reason?: string }, facts: Awaited<ReturnType<ArcpService['facts']>>, why: string) {
    const token = randomBytes(24).toString('base64url'); const expiresAt = new Date(Date.now() + Number(process.env.ARCP_CONFIRMATION_SECONDS ?? 300) * 1000).toISOString();
    const record: Confirmation = { tokenHash: createHash('sha256').update(token).digest('hex'), kind, actorId: input.actorId, runtimeSessionId: session.id, generation: session.generation, ...(input.reason ? { reason: input.reason } : {}), activeTurn: facts.activeTurn, childSet: facts.childSet, ...(facts.cache.activityAt ? { activityAt: facts.cache.activityAt } : {}), expiresAt };
    const receipt = await this.store.mutate((state) => { state.confirmations = state.confirmations.filter((item) => Date.parse(item.expiresAt) > Date.now() && !(item.kind === kind && item.actorId === input.actorId && item.runtimeSessionId === session.id)); state.confirmations.push(record); return { action: 'hold' as const, why, confirmation: token, expiresAt, activeTurn: facts.activeTurn.endsWith(':true'), childCount: facts.childSet ? facts.childSet.split(',').length : 0, recommendedCommands: kind === 'cache' ? [`arcp start --workspace ${session.workspaceId ?? '<workspace>'} --profile claude-manager --title 'Handoff from ${session.id}'`, `arcp reuse ${session.id} --confirm ${token} --body '<message>'`] : [`arcp interrupt ${session.id} --reason '${input.reason ?? 'reason'}' --confirm ${token} --body '<message>'`] }; });
    if (kind !== 'cache') return receipt;
    const state = this.store.snapshot(); const goal = state.goals.find((item) => item.id === session.goalId); const task = state.tasks.find((item) => item.workspaceId === session.workspaceId && item.title === goal?.title); const knowledge = state.knowledge.filter((item) => item.workspaceId === session.workspaceId).at(-1); const result = state.results.filter((item) => item.workspaceId === session.workspaceId).at(-1);
    return { ...receipt, handoff: { ...(goal ? { goalId: goal.id } : {}), ...(task ? { taskId: task.id } : {}), ...(knowledge ? { latestKnowledgeRef: knowledge.id } : {}), ...(result ? { latestResultRef: result.id } : {}), workSummary: await this.workSummary(session.workspace) } };
  }
  private async validateConfirmation(kind: Confirmation['kind'], token: string, session: RuntimeSession, input: { actorId: string; reason?: string }, facts: Awaited<ReturnType<ArcpService['facts']>>) {
    const tokenHash = createHash('sha256').update(token).digest('hex'); const record = this.store.snapshot().confirmations.find((item) => item.tokenHash === tokenHash && item.kind === kind);
    const valid = Boolean(record && Date.parse(record.expiresAt) > Date.now() && record.actorId === input.actorId && record.runtimeSessionId === session.id && record.generation === session.generation && record.reason === input.reason && record.activeTurn === facts.activeTurn && record.childSet === facts.childSet && record.activityAt === facts.cache.activityAt);
    await this.store.mutate((state) => { state.confirmations = state.confirmations.filter((item) => item.tokenHash !== tokenHash && Date.parse(item.expiresAt) > Date.now()); });
    return valid;
  }
  private async cacheGuard(session: RuntimeSession, actorId: string, confirmation?: string) {
    if (session.provider !== 'claude') return { allow: true as const };
    const facts = await this.facts(session);
    if (facts.cache.state === 'fresh') return { allow: true as const };
    if (facts.cache.state === 'unknown') return this.confirmationReceipt('cache', session, { actorId }, facts, 'Claude provider activity is unavailable; reuse is held');
    if (confirmation && await this.validateConfirmation('cache', confirmation, session, { actorId }, facts)) return { allow: true as const, cacheAuthorized: true as const };
    return this.confirmationReceipt('cache', session, { actorId }, facts, `Claude cache is ${facts.cache.state}; reuse requires confirmation`);
  }
  async interrupt(input: { fromActorId: string; runtimeSessionId: string; body: string; reason: string; confirmation?: string }): Promise<Delivery | Record<string, unknown>> {
    if (!input.reason?.trim() || !input.body?.trim()) throw new ArcpError('invalid_request', 'interrupt reason and body are required');
    const session = this.store.snapshot().sessions.find((item) => item.id === input.runtimeSessionId); if (!session || !session.externalId || !this.store.snapshot().actors.some((item) => item.id === input.fromActorId)) throw new ArcpError('unknown_recipient', 'recipient is not registered');
    if (session.provider === 'claude') {
      const facts = await this.facts(session);
      if (!input.confirmation || !(await this.validateConfirmation('interrupt', input.confirmation, session, { actorId: input.fromActorId, reason: input.reason.trim() }, facts))) {
        return this.confirmationReceipt('interrupt', session, { actorId: input.fromActorId, reason: input.reason.trim() }, facts, input.confirmation ? 'Claude interrupt confirmation is stale; no interrupt was sent' : 'Claude interrupt requires confirmation; no interrupt was sent');
      }
    }
    const deliveryId = `delivery_${randomUUID()}`;
    const event = await this.publishChannelEvent({ workspaceId: session.workspaceId, goalId: session.goalId, sourceActorId: input.fromActorId, targetActorId: session.actorId, kind: 'attention', urgency: 'urgent', consumptionPolicy: 'consume_on_delivery', decisionRequired: false, summary: `Channel interrupt ${deliveryId} queued`, evidenceRefs: [], notify: false });
    const delivery: Delivery = { id: deliveryId, fromActorId: input.fromActorId, runtimeSessionId: session.id, generation: session.generation, body: input.body.trim(), command: 'interrupt', reason: input.reason.trim(), eventId: event.id, state: 'queued', createdAt: now() };
    await this.store.mutate((state) => { state.deliveries.push(delivery); });
    try { await this.adapterFor(session).interrupt(session.externalId, delivery.body); return this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id)!; const event = item.eventId ? state.channelEvents.find((value) => value.id === item.eventId) : undefined; item.state = 'delivered'; item.deliveredAt = now(); if (event) this.transitionEvent(event, 'delivered', item.deliveredAt); return item; }); }
    catch { return this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id)!; const event = item.eventId ? state.channelEvents.find((value) => value.id === item.eventId) : undefined; item.state = 'transport_indeterminate'; if (event) this.transitionEvent(event, 'transport_indeterminate'); return item; }); }
  }
  /** Why a contract delivery must be refused rather than applied, or undefined
   * when the runtime provably still holds the scope this contract describes. */
  private contractRefusal(state: State, session: RuntimeSession, subject: DeliverySubject, notAfter?: string, excludeDeliveryId?: string): string | undefined {
    const task = state.tasks.find((item) => item.id === subject.taskId && item.workspaceId === session.workspaceId);
    if (!task) return 'contract subject task is not in this workspace';
    if (notAfter && Date.parse(notAfter) <= Date.now()) return `contract expired at ${notAfter}`;
    if (task.fence !== subject.fence) return `contract subject fence ${subject.fence} no longer matches task fence ${task.fence}`;
    if (state.results.some((item) => item.taskId === task.id)) return 'task already has a submitted Result';
    if (!['proposed', 'ready'].includes(task.lifecycle)) return `task is already ${task.lifecycle}; the runtime has acted without this contract`;
    // Fail-closed on uncertainty: `attempting` means a turn is already in flight
    // and `transport_indeterminate` means ARCP does not know whether the runtime
    // received one, which is exactly when a late contract must not be applied.
    if (state.deliveries.some((item) => item.id !== excludeDeliveryId && item.runtimeSessionId === session.id && item.generation === session.generation && ['attempting', 'delivered', 'running', 'processed', 'acknowledged', 'transport_indeterminate'].includes(item.state))) return 'runtime has already been handed a delivery in this generation, or its delivery state is indeterminate';
    return undefined;
  }
  /** Record a contract withdrawal decided by the pump, with the Manager-visible
   * refusal event that makes it auditable. */
  private async withdrawContractDelivery(deliveryId: string, refusal: string): Promise<void> {
    await this.store.mutate((state) => {
      const item = state.deliveries.find((value) => value.id === deliveryId); if (!item || ['withdrawn', 'delivered', 'processed', 'acknowledged'].includes(item.state)) return undefined;
      const session = state.sessions.find((value) => value.id === item.runtimeSessionId);
      item.state = 'withdrawn'; item.refusedReason = refusal; item.reason = refusal;
      const event = item.eventId ? state.channelEvents.find((value) => value.id === item.eventId) : undefined; if (event) this.transitionEvent(event, 'withdrawn');
      this.appendChannelEvent(state, { ...(session?.workspaceId ? { workspaceId: session.workspaceId } : {}), ...(session?.goalId ? { goalId: session.goalId } : {}), ...(item.subject?.taskId ? { taskId: item.subject.taskId } : {}), sourceActorId: item.fromActorId, targetRole: 'manager', kind: 'attention', urgency: 'urgent', consumptionPolicy: 'ack_required', decisionRequired: false, summary: `Late Goal Contract for task ${item.subject?.taskId ?? 'unknown'} was refused: ${refusal}`, evidenceRefs: [], notify: false });
      return undefined;
    });
  }
  async deliver(input: { fromActorId: string; runtimeSessionId: string; body: string; command?: 'normal' | 'interrupt'; reason?: string; cacheConfirmation?: string; purpose?: DeliveryPurpose; subject?: DeliverySubject; notAfter?: string }): Promise<Delivery | Record<string, unknown>> {
    if (!input.body?.trim()) throw new ArcpError('invalid_request', 'body is required');
    const snapshot = this.store.snapshot(); const session = snapshot.sessions.find((item) => item.id === input.runtimeSessionId);
    if (!snapshot.actors.some((item) => item.id === input.fromActorId) || !session || !session.externalId) throw new ArcpError('unknown_recipient', 'recipient is not registered');
    const command = input.command ?? 'normal';
    if (!['normal', 'interrupt'].includes(command)) throw new ArcpError('invalid_request', 'command must be normal or interrupt');
    if (command === 'interrupt') return this.interrupt({ fromActorId: input.fromActorId, runtimeSessionId: input.runtimeSessionId, body: input.body, reason: input.reason ?? '', confirmation: input.cacheConfirmation });
    if (input.purpose === 'contract') {
      // The authoritative scope belongs in the launch itself. A contract that
      // arrives as a later delivery is fail-closed: refused, durably recorded,
      // and never handed to a runtime that has already begun acting.
      if (!input.subject?.taskId || typeof input.subject.fence !== 'number') throw new ArcpError('invalid_request', 'a contract delivery requires --subject-task and --subject-fence', 'subject');
      const refusal = this.contractRefusal(snapshot, session, input.subject, input.notAfter);
      if (refusal) {
        const refused: Delivery = { id: `delivery_${randomUUID()}`, fromActorId: input.fromActorId, runtimeSessionId: session.id, generation: session.generation, body: input.body.trim(), command, purpose: 'contract', subject: input.subject, ...(input.notAfter ? { notAfter: input.notAfter } : {}), refusedReason: refusal, reason: refusal, state: 'withdrawn', createdAt: now() };
        await this.store.mutate((state) => { state.deliveries.push(refused); });
        await this.publishChannelEvent({ workspaceId: session.workspaceId, goalId: session.goalId, taskId: input.subject.taskId, sourceActorId: input.fromActorId, targetRole: 'manager', kind: 'attention', urgency: 'urgent', consumptionPolicy: 'ack_required', decisionRequired: false, summary: `Late Goal Contract for task ${input.subject.taskId} was refused: ${refusal}`, evidenceRefs: [], notify: false }).catch(() => undefined);
        return refused;
      }
    }
    const cache = await this.cacheGuard(session, input.fromActorId, input.cacheConfirmation);
    const deliveryId = `delivery_${randomUUID()}`;
    const event = await this.publishChannelEvent({ workspaceId: session.workspaceId, goalId: session.goalId, sourceActorId: input.fromActorId, targetActorId: session.actorId, kind: 'material_progress', urgency: 'normal', consumptionPolicy: 'consume_on_delivery', decisionRequired: false, summary: `Channel delivery ${deliveryId} queued`, evidenceRefs: [], notify: false });
    const held = !('allow' in cache);
    const delivery: Delivery = { id: deliveryId, fromActorId: input.fromActorId, runtimeSessionId: session.id, generation: session.generation, body: input.body.trim(), command, ...(input.purpose ? { purpose: input.purpose } : {}), ...(input.subject ? { subject: input.subject } : {}), ...(input.notAfter ? { notAfter: input.notAfter } : {}), eventId: event.id, ...('allow' in cache && cache.cacheAuthorized ? { cacheAuthorized: true as const } : {}), ...(held ? { reason: cache.why } : input.reason ? { reason: input.reason.trim() } : {}), state: held ? 'held' : command === 'normal' ? 'waiting_safe_point' : 'queued', createdAt: now() };
    await this.store.mutate((state) => { state.deliveries.push(delivery); });
    if (held) return { ...cache, deliveryId };
    await this.pump(); return this.store.snapshot().deliveries.find((item) => item.id === delivery.id)!;
  }
  async reuse(input: { fromActorId: string; runtimeSessionId: string; body: string; cacheConfirmation?: string }) { return this.deliver({ ...input, command: 'normal' }); }
  private async pump(): Promise<void> {
    if (this.pumping) { this.pumpAgain = true; return this.pumping; }
    this.pumping = (async () => {
      await this.scheduleDueChannelEvents();
      // Reconcile accepted history before starting new safe-point work. A
      // delivery started in this pass must not be immediately turned into
      // `processed` merely because a later row observes the same idle runtime.
      const deliveries = this.store.snapshot().deliveries
        .filter((item) => item.command === 'normal' && ['waiting_safe_point', 'delivered', 'running', 'processed'].includes(item.state))
        .sort((a, b) => Number(a.state === 'waiting_safe_point') - Number(b.state === 'waiting_safe_point') || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      for (const delivery of deliveries) {
        const session = this.store.snapshot().sessions.find((item) => item.id === delivery.runtimeSessionId);
        if (!session?.externalId || session.state === 'terminal' || session.generation !== delivery.generation) {
          await this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id); const event = item?.eventId ? state.channelEvents.find((value) => value.id === item.eventId) : undefined; if (item && ['waiting_safe_point', 'attempting'].includes(item.state)) { item.state = 'withdrawn'; item.reason = 'target generation ended'; } if (item && event) this.rerouteTerminalEvent(state, event, item); return undefined; });
          continue;
        }
        let observed: RuntimeSession;
        try { observed = await this.observe(session.id); } catch { continue; }
        // A post-dispatch observation advances delivered → running → processed in observe().
        // Only waiting_safe_point is eligible to begin a turn; indeterminate is deliberately excluded.
        const currentDelivery = this.store.snapshot().deliveries.find((item) => item.id === delivery.id);
        if (!currentDelivery || currentDelivery.state !== 'waiting_safe_point') continue;
        // A subject-bound delivery is only authoritative while the Task it names
        // still stands at the fence it was written against. Revalidate here so a
        // contract queued before the runtime acted is never delivered after.
        if (currentDelivery.subject) {
          const refusal = this.contractRefusal(this.store.snapshot(), session, currentDelivery.subject, currentDelivery.notAfter);
          if (refusal) {
            await this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id); if (!item || item.state !== 'waiting_safe_point') return undefined; item.state = 'withdrawn'; item.refusedReason = refusal; item.reason = refusal; const event = item.eventId ? state.channelEvents.find((value) => value.id === item.eventId) : undefined; if (event) this.transitionEvent(event, 'withdrawn'); this.appendChannelEvent(state, { workspaceId: session.workspaceId, goalId: session.goalId, taskId: item.subject!.taskId, sourceActorId: item.fromActorId, targetRole: 'manager', kind: 'attention', urgency: 'urgent', consumptionPolicy: 'ack_required', decisionRequired: false, summary: `Late Goal Contract for task ${item.subject!.taskId} was refused: ${refusal}`, evidenceRefs: [], notify: false }); return undefined; });
            continue;
          }
        }
        // A competing target may have delivered this informational episode
        // first. Re-read the event before every wake; a stale snapshot must
        // never turn one consumed Event into several agent turns.
        const currentEvent = currentDelivery.eventId ? this.store.snapshot().channelEvents.find((item) => item.id === currentDelivery.eventId) : undefined;
        if (currentEvent && currentEvent.consumptionState !== 'open') {
          await this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id); if (item?.state === 'waiting_safe_point') item.state = 'withdrawn'; return undefined; });
          continue;
        }
        if (observed.state !== 'idle') continue;
        if (session.provider === 'claude') {
          const facts = await this.facts(session);
          if (facts.cache.state !== 'fresh' && !delivery.cacheAuthorized) { await this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id)!; item.safePointStatus = `cache_${facts.cache.state}`; return item; }); continue; }
        }
        await this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id)!; const runtime = state.sessions.find((value) => value.id === session.id)!; item.state = 'attempting'; item.safePointObservedAt = now(); item.safePointStatus = observed.state; item.attemptedAt = now(); runtime.lastDeliveryId = delivery.id; runtime.lastTurnState = 'running'; return item; });
        try {
          // The last read before the irreversible start-turn. Contract validity
          // is re-checked here, not only before the observe()/facts() awaits
          // above, so a claim or Result landing in that window still refuses.
          const lateRefusal = currentDelivery.subject ? this.contractRefusal(this.store.snapshot(), session, currentDelivery.subject, currentDelivery.notAfter, delivery.id) : undefined;
          const eligible = !lateRefusal && this.store.snapshot().deliveries.find((item) => item.id === delivery.id)?.state === 'attempting' && (!currentDelivery.eventId || this.store.snapshot().channelEvents.find((item) => item.id === currentDelivery.eventId)?.consumptionState === 'open');
          if (!eligible) {
            if (lateRefusal) await this.withdrawContractDelivery(delivery.id, lateRefusal);
            continue;
          }
          // Adapter rechecks immediately before its non-steering start-turn operation.
          await this.adapterFor(session).startTurn(session.externalId, delivery.body, delivery.id);
          await this.store.mutate((state) => {
            const item = state.deliveries.find((value) => value.id === delivery.id)!; const event = item.eventId ? state.channelEvents.find((value) => value.id === item.eventId) : undefined;
            // The withdrawal that landed while this turn was in flight could not
            // cancel it. Keep the withdrawal truthful, record that the runtime
            // nevertheless received the body, and surface it to the Manager
            // rather than overwriting the row with `delivered`.
            if (item.state === 'withdrawn') {
              item.handedOffAfterWithdrawal = true; item.deliveredAt = now();
              if (event) this.transitionEvent(event, 'withdrawn');
              this.appendChannelEvent(state, { workspaceId: session.workspaceId, goalId: session.goalId, ...(item.subject?.taskId ? { taskId: item.subject.taskId } : {}), sourceActorId: item.fromActorId, targetRole: 'manager', kind: 'attention', urgency: 'urgent', consumptionPolicy: 'ack_required', decisionRequired: false, summary: `Delivery ${item.id} was withdrawn (${item.refusedReason ?? item.reason ?? 'withdrawn'}) but its turn had already been handed to runtime ${session.id}`, evidenceRefs: [], notify: false });
              return item;
            }
            item.state = 'delivered'; item.deliveredAt = now(); if (event) this.transitionEvent(event, 'delivered', item.deliveredAt); return item;
          });
        } catch { await this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id)!; const event = item.eventId ? state.channelEvents.find((value) => value.id === item.eventId) : undefined; if (item.state === 'withdrawn') return item; item.state = 'transport_indeterminate'; if (event) this.transitionEvent(event, 'transport_indeterminate'); return item; }); }
      }
      if (this.store.prune) await this.store.prune();
    })().finally(() => { this.pumping = undefined; if (this.pumpAgain) { this.pumpAgain = false; void this.pump(); } });
    return this.pumping;
  }
  async acknowledge(id: string, generation?: number): Promise<Delivery> {
    const delivery = this.store.snapshot().deliveries.find((item) => item.id === id);
    if (!delivery) throw new ArcpError('not_found', 'delivery not found');
    if (generation !== undefined && generation !== delivery.generation) throw new ArcpError('stale_generation', 'delivery generation is stale');
    if (!['delivered', 'running', 'processed'].includes(delivery.state)) throw new ArcpError('invalid_request', 'delivery has not been processed');
    return this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === id)!; item.state = 'acknowledged'; item.acknowledgedAt = now(); const event = item.eventId ? state.channelEvents.find((value) => value.id === item.eventId) : undefined; if (event) { if (event.deliveryState === 'delivered') this.transitionEvent(event, 'processed', item.acknowledgedAt); this.transitionEvent(event, 'acknowledged', item.acknowledgedAt); } return item; });
  }
  /** Release a cache-held Companion delivery after a fresh observation or an
   * explicit one-use cache confirmation. */
  async release(id: string, memberId?: string, cacheConfirmation?: string): Promise<Delivery | Record<string, unknown>> {
    const snapshot = this.store.snapshot(); const delivery = snapshot.deliveries.find((item) => item.id === id);
    if (!delivery) throw new ArcpError('not_found', 'delivery not found');
    if (delivery.state !== 'held') throw new ArcpError('invalid_request', 'delivery is not held');
    const session = snapshot.sessions.find((item) => item.id === delivery.runtimeSessionId);
    if (!session || !session.externalId) throw new ArcpError('unknown_recipient', 'recipient is not registered');
    if (memberId && session.memberId !== memberId) throw new ArcpError('unauthorized', 'delivery release is not authorized');
    const cache = await this.cacheGuard(session, delivery.fromActorId, cacheConfirmation);
    if (!('allow' in cache)) return { ...cache, deliveryId: delivery.id };
    await this.store.mutate((state) => {
      const item = state.deliveries.find((value) => value.id === id)!;
      item.state = 'waiting_safe_point';
      if (cache.cacheAuthorized) item.cacheAuthorized = true;
      item.reason = 'cache hold released';
      return item;
    });
    await this.pump();
    return this.store.snapshot().deliveries.find((item) => item.id === id)!;
  }
  deliveryStatus(id: string): { state: string } | undefined {
    const delivery = this.store.snapshot().deliveries.find((item) => item.id === id);
    return delivery ? { state: delivery.state } : undefined;
  }
  async withdraw(id: string, reason = 'withdrawn', memberId?: string): Promise<Delivery> {
    const snapshot = this.store.snapshot();
    const delivery = snapshot.deliveries.find((item) => item.id === id);
    if (!delivery) throw new ArcpError('not_found', 'delivery not found');
    if (['delivered', 'running', 'processed', 'acknowledged'].includes(delivery.state)) throw new ArcpError('invalid_request', 'delivered delivery cannot be withdrawn');
    if (memberId) {
      const member = snapshot.members.find((item) => item.id === memberId);
      const session = snapshot.sessions.find((item) => item.id === delivery.runtimeSessionId);
      const workspace = session?.workspaceId ? snapshot.workspaces.find((item) => item.id === session.workspaceId) : undefined;
      const sameWorkspace = Boolean(member && session?.workspaceId && member.workspaceId === session.workspaceId && workspace?.id === member.workspaceId);
      if (!member || !session || !workspace || !sameWorkspace) throw new ArcpError('unauthorized', 'delivery withdrawal is not authorized');
      const authorized = (
        delivery.fromActorId === member.actorId
        || workspace.ownerMemberId === member.id
        || member.role === 'manager'
        || session.memberId === member.id
      );
      if (!authorized) throw new ArcpError('unauthorized', 'delivery withdrawal is not authorized');
    }
    return this.store.mutate((state) => {
      const item = state.deliveries.find((value) => value.id === id)!;
      item.state = 'withdrawn'; item.reason = reason.trim() || 'withdrawn';
      const event = item.eventId ? state.channelEvents.find((value) => value.id === item.eventId) : undefined;
      if (event) this.transitionEvent(event, 'withdrawn');
      return item;
    });
  }
  private appendChannelEvent(state: State, input: ChannelEventInput): ChannelEvent {
    const summary = input.summary.trim(); const evidenceRefs = input.evidenceRefs ?? [];
    const prohibitedAssignment = /(?:credential|authorization|bearer|api[_-]?(?:key|secret)|access[_-]?token|token|secret|password|passwd|private[_-]?key)\s*[:=]\s*[^\s]+/i;
    const prohibitedPath = /(?:^|[\s=:])(?:file:\/\/\/|\/Users\/|\/private\/|\/tmp\/|\/var\/|\/home\/|[A-Za-z]:\\)/i;
    // Reject recognizable transcript/reasoning structures, while allowing
    // ordinary prose such as "reason: delayed dependency" in a finding.
    const prohibitedTranscript = /(?:<\/?(?:thinking|assistant|user)(?:\s[^>]*)?>|chain[- ]of[- ]thought|internal\s+reasoning|(?:^|\n)\s*(?:assistant|user|thinking)\s*:\s*)/i;
    if (prohibitedAssignment.test(summary) || prohibitedPath.test(summary) || prohibitedTranscript.test(summary) || evidenceRefs.some((ref) => prohibitedPath.test(ref) || prohibitedAssignment.test(ref) || /path\s*=/i.test(ref))) throw new ArcpError('invalid_request', 'channel event content contains prohibited private data', 'summary');
    const decisionOptions = input.decisionOptions?.map((option) => option.trim()).filter((option) => option.length > 0);
    if (decisionOptions?.some((option) => prohibitedAssignment.test(option) || prohibitedPath.test(option) || prohibitedTranscript.test(option))) throw new ArcpError('invalid_request', 'channel event content contains prohibited private data', 'decisionOptions');
    const taskNotification = ['task_candidate', 'task_failed', 'task_unknown', 'task_completed'].includes(input.kind);
    const targetRole = input.targetRole ?? (taskNotification ? 'manager' : undefined);
    const consumptionPolicy = input.consumptionPolicy ?? legacyPolicyFor(input);
    const priority = input.priority ?? priorityFor(input);
    const expectedAction = input.expectedAction ?? expectedActionFor(consumptionPolicy, targetRole);
    if ((consumptionPolicy === 'consume_on_delivery') !== (expectedAction.kind === 'none') || (consumptionPolicy === 'ack_required') !== (expectedAction.kind === 'ack') || (consumptionPolicy === 'decision_required') !== (expectedAction.kind === 'resolve')) throw new ArcpError('invalid_request', 'expected action does not match consumption policy', 'expectedAction');
    const notifying = input.notify !== false || taskNotification;
    if (notifying && !input.targetMemberId && !input.targetActorId && !targetRole && !input.targetSubscription) throw new ArcpError('invalid_request', 'notifying channel events require an explicit target', 'target');
    const contentHash = contentAddress(summary, evidenceRefs);
    if (input.semanticKey) {
      const open = state.channelEvents.find((item) => item.semanticKey === input.semanticKey && ['open', 'deferred'].includes(item.consumptionState));
      if (open) return open;
    }
    const stablePayload = { workspaceId: input.workspaceId, goalId: input.goalId, taskId: input.taskId, resultId: input.resultId, sourceMemberId: input.sourceMemberId, sourceActorId: input.sourceActorId, targetMemberId: input.targetMemberId, targetActorId: input.targetActorId, targetRole, targetSubscription: input.targetSubscription, semanticKey: input.semanticKey, kind: input.kind, urgency: input.urgency, priority, consumptionPolicy, expectedAction, decisionRequired: input.decisionRequired, relatedEventId: input.relatedEventId, summary, evidenceRefs, verdict: input.verdict, decisionOptions };
    const semanticEpisode = input.semanticKey ? state.channelEvents.filter((item) => item.semanticKey === input.semanticKey).length : 0;
    const id = input.id ?? (input.semanticKey ? idFor('event', `${input.semanticKey}:${semanticEpisode}`) : `event_${createHash('sha256').update(JSON.stringify(stablePayload)).digest('hex').slice(0, 20)}`);
    const existing = state.channelEvents.find((item) => item.id === id);
    if (existing) {
      const existingPayload = { workspaceId: existing.workspaceId, goalId: existing.goalId, taskId: existing.taskId, resultId: existing.resultId, sourceMemberId: existing.sourceMemberId, sourceActorId: existing.sourceActorId, targetMemberId: existing.targetMemberId, targetActorId: existing.targetActorId, targetRole: existing.targetRole, targetSubscription: existing.targetSubscription, semanticKey: existing.semanticKey, kind: existing.kind, urgency: existing.urgency, priority: existing.priority, consumptionPolicy: existing.consumptionPolicy, expectedAction: existing.expectedAction, decisionRequired: existing.decisionRequired, relatedEventId: existing.relatedEventId, summary: existing.content.summary, evidenceRefs: existing.content.evidenceRefs, verdict: existing.verdict, decisionOptions: existing.decisionOptions }; const conflict = JSON.stringify(existingPayload) !== JSON.stringify(stablePayload);
      if (conflict) throw new ArcpError('invalid_request', 'channel event id conflicts with its durable payload', 'id');
      return existing;
    }
    const { notify: _notify, decisionOptions: _decisionOptions, ...publicInput } = { ...input, ...(targetRole ? { targetRole } : {}) };
    const { summary: _summary, evidenceRefs: _evidenceRefs, ...envelope } = publicInput;
    const event: ChannelEvent = { ...envelope, ...(decisionOptions?.length ? { decisionOptions } : {}), id, priority, consumptionPolicy, consumptionState: 'open', expectedAction, dispositions: [], content: { summary, evidenceRefs, contentHash, sensitivity: 'normal', retention: 'standard' }, deliveryState: 'queued', transitions: [{ state: 'queued', at: now() }], createdAt: now() };
    state.channelEvents.push(event);
    if (notifying && event.workspaceId) {
      const targetMembers = state.members.filter((member) => member.workspaceId === event.workspaceId && (!event.targetMemberId || member.id === event.targetMemberId) && (!event.targetActorId || member.actorId === event.targetActorId) && (!event.targetRole || member.role === event.targetRole) && (!event.targetSubscription || event.targetSubscription === '*' || member.role === event.targetSubscription || member.capabilities.includes(event.targetSubscription)));
      const targetMemberIds = new Set(targetMembers.map((member) => member.id));
      const targetSessions = state.sessions.filter((session) => session.workspaceId === event.workspaceId && session.externalId && session.memberId && session.memberId !== event.sourceMemberId && targetMemberIds.has(session.memberId) && ['launching', 'running', 'idle', 'attention'].includes(session.state));
      if (targetSessions.length === 0) {
        event.undeliverableReason = targetMembers.length === 0 ? 'no matching target member' : 'no live target runtime session';
        this.transitionEvent(event, 'undeliverable');
      }
      for (const session of targetSessions.sort((a, b) => a.id.localeCompare(b.id)).slice(0, 1)) this.queueEventDelivery(state, event, session, 0);
    }
    return event;
  }
  private transitionEvent(event: ChannelEvent, state: ChannelTransition['state'], at = now()): void {
    if (event.transitions.at(-1)?.state === state) return;
    event.transitions.push({ state, at }); event.deliveryState = state;
    if (state === 'delivered') {
      event.deliveredAt = at;
      // A successful informational transport closes the semantic obligation in
      // the same durable mutation. Delivery retry must never resurrect it.
      if (event.consumptionPolicy === 'consume_on_delivery' && event.consumptionState === 'open') { event.consumptionState = 'consumed'; event.consumedAt = at; }
    } else if (state === 'processed') event.processedAt = at; else if (state === 'acknowledged') event.acknowledgedAt = at;
  }
  /** The Inbox is derived from ChannelEvent state. This is the one place an
   * open episode may gain a safe-point delivery, which prevents duplicate wakes. */
  private queueEventDelivery(state: State, event: ChannelEvent, session: RuntimeSession, episode: number): void {
    if (event.consumptionState !== 'open' || session.state === 'terminal' || !session.externalId) return;
    const deliveryId = idFor('delivery', `event:${event.id}:${session.id}:episode:${episode}`);
    if (state.deliveries.some((delivery) => delivery.id === deliveryId || delivery.eventId === event.id && delivery.runtimeSessionId === session.id && delivery.generation === session.generation && delivery.consumptionEpisode === episode && ['waiting_safe_point', 'attempting', 'delivered', 'running'].includes(delivery.state))) return;
    state.deliveries.push({ id: deliveryId, fromActorId: event.sourceActorId ?? session.actorId, runtimeSessionId: session.id, generation: session.generation, body: renderChannelMarkdown(projectChannelEvent(event, projectionFacts(state)), markdownOptions()), command: 'normal', eventId: event.id, consumptionEpisode: episode, state: 'waiting_safe_point', createdAt: now() });
  }
  private rerouteTerminalEvent(state: State, event: ChannelEvent, delivery: Delivery): void {
    if (event.consumptionState !== 'open') return;
    const workspace = state.workspaces.find((item) => item.id === event.workspaceId);
    const owner = workspace?.ownerMemberId ? state.members.find((item) => item.id === workspace.ownerMemberId) : undefined;
    if (!owner) { event.consumptionState = 'invalidated'; return; }
    event.reroutedToMemberId = owner.id;
    this.appendDisposition(event, { kind: 'reroute', reason: `Target generation ${delivery.generation} ended before this obligation closed`, toMemberId: owner.id }, owner.id);
    const episode = Math.max(-1, ...state.deliveries.filter((item) => item.eventId === event.id).map((item) => item.consumptionEpisode ?? 0)) + 1;
    const target = state.sessions.filter((session) => session.workspaceId === event.workspaceId && session.memberId === owner.id && session.externalId && ['launching', 'running', 'idle', 'attention'].includes(session.state)).sort((a, b) => a.id.localeCompare(b.id))[0];
    if (target) this.queueEventDelivery(state, event, target, episode);
  }
  private async scheduleDueChannelEvents(): Promise<void> {
    await this.store.mutate((state) => {
      const current = Date.now();
      for (const event of state.channelEvents) {
        if (event.consumptionState !== 'deferred') continue;
        const dependency = event.dependencyEventId ? state.channelEvents.find((item) => item.id === event.dependencyEventId) : undefined;
        const due = Boolean(event.nextVisibleAt && Date.parse(event.nextVisibleAt) <= current);
        const dependencyResolved = Boolean(dependency && ['consumed', 'resolved', 'invalidated'].includes(dependency.consumptionState));
        if (!due && !dependencyResolved) continue;
        event.consumptionState = 'open'; delete event.nextVisibleAt; delete event.dependencyEventId;
        const episode = Math.max(-1, ...state.deliveries.filter((item) => item.eventId === event.id).map((item) => item.consumptionEpisode ?? 0)) + 1;
        const targetSessions = state.sessions.filter((session) => session.workspaceId === event.workspaceId && session.memberId && session.memberId !== event.sourceMemberId && (!(event.reroutedToMemberId ?? event.targetMemberId) || session.memberId === (event.reroutedToMemberId ?? event.targetMemberId)) && (!event.reroutedToMemberId && (!event.targetActorId || session.actorId === event.targetActorId)) && (!event.reroutedToMemberId && (!event.targetRole || state.members.find((member) => member.id === session.memberId)?.role === event.targetRole) || Boolean(event.reroutedToMemberId)) && ['launching', 'running', 'idle', 'attention'].includes(session.state)).sort((a, b) => a.id.localeCompare(b.id));
        if (targetSessions[0]) this.queueEventDelivery(state, event, targetSessions[0], episode);
      }
    });
  }
  private async emitTransportUncertainty(session: RuntimeSession): Promise<void> {
    await this.store.mutate((state) => { this.appendChannelEvent(state, { workspaceId: session.workspaceId, goalId: session.goalId, taskId: session.taskId, sourceMemberId: session.memberId, sourceActorId: session.actorId, targetRole: 'manager', kind: 'runtime_health', urgency: 'urgent', consumptionPolicy: 'ack_required', decisionRequired: true, summary: `Runtime ${session.id} health is uncertain`, evidenceRefs: [] }); this.appendChannelEvent(state, { workspaceId: session.workspaceId, goalId: session.goalId, taskId: session.taskId, sourceMemberId: session.memberId, sourceActorId: session.actorId, targetRole: 'manager', kind: 'transport_uncertainty', urgency: 'urgent', consumptionPolicy: 'ack_required', decisionRequired: true, summary: `Runtime ${session.id} transport is uncertain`, evidenceRefs: [] }); });
    if (!this.pumping) await this.pump();
  }
  async publishChannelEvent(input: ChannelEventInput): Promise<ChannelEvent> {
    if (!input.summary?.trim()) throw new ArcpError('invalid_request', 'channel event summary is required');
    const event = await this.store.mutate((state) => this.appendChannelEvent(state, input));
    await this.pump(); return event;
  }
  private accountableGeneration(state: State, event: ChannelEvent, memberId: string): number | undefined {
    const delivery = state.deliveries.find((item) => item.eventId === event.id && ['delivered', 'running', 'processed', 'acknowledged'].includes(item.state));
    if (!delivery) return undefined;
    const session = state.sessions.find((item) => item.id === delivery.runtimeSessionId);
    // Workspace Owners may discharge an obligation without impersonating the
    // target runtime. Generation fencing applies when the accountable member
    // is the delivered-to member.
    if (session?.memberId !== memberId) return undefined;
    if (session.generation !== delivery.generation || session.state === 'terminal') throw new ArcpError('stale_generation', 'event target runtime generation is no longer accountable');
    return delivery.generation;
  }
  private appendDisposition(event: ChannelEvent, input: RecipientDisposition, memberId: string, targetGeneration?: number, id?: string): RecipientDispositionReceipt {
    const receiptId = id ?? idFor('disposition', JSON.stringify({ eventId: event.id, memberId, input, targetGeneration }));
    const existing = event.dispositions.find((item) => item.id === receiptId);
    if (existing) return existing;
    const receipt: RecipientDispositionReceipt = { ...input, id: receiptId, actorMemberId: memberId, ...(targetGeneration === undefined ? {} : { targetGeneration }), at: now() };
    event.dispositions.push(receipt);
    return receipt;
  }
  async acknowledgeEvent(eventId: string, memberId: string, reason = 'acknowledged', dispositionId?: string): Promise<ChannelEvent> {
    return this.store.mutate((state) => {
      const event = state.channelEvents.find((item) => item.id === eventId);
      const member = state.members.find((item) => item.id === memberId);
      if (!event) throw new ArcpError('not_found', 'channel event not found');
      if (!member || member.workspaceId !== event.workspaceId) throw new ArcpError('unauthorized', 'event acknowledgement is not authorized');
      const workspace = state.workspaces.find((item) => item.id === event.workspaceId);
      if (!intendedTarget(event, member, workspace)) throw new ArcpError('unauthorized', 'event acknowledgement is not authorized');
      if (event.consumptionPolicy !== 'ack_required') throw new ArcpError('invalid_request', 'decision-required events must be resolved, not acknowledged');
      // deliveryState only advances through the runtime delivery pump, so a
      // role-targeted obligation with no matching managed runtime never gets a
      // Delivery and could never be discharged. The precondition is therefore
      // about an in-flight transport, not about transport having happened: an
      // authorized accountable member may acknowledge an event that has no
      // Delivery row at all, and the transition list keeps recording that it
      // was never runtime-delivered. Authorization above is unchanged.
      const pendingTransport = state.deliveries.some((item) => item.eventId === event.id && !['withdrawn', 'undeliverable'].includes(item.state));
      if (pendingTransport && !['delivered', 'processed', 'acknowledged'].includes(event.deliveryState)) throw new ArcpError('invalid_request', 'channel event delivery is still in flight');
      if (event.consumptionState === 'consumed') return event;
      const targetGeneration = this.accountableGeneration(state, event, member.id);
      const receipt = this.appendDisposition(event, { kind: 'ack', reason: boundedReason(reason) }, member.id, targetGeneration, dispositionId);
      event.consumptionState = 'consumed'; event.consumedAt = receipt.at;
      this.transitionEvent(event, 'acknowledged', receipt.at); return event;
    });
  }
  async deferEvent(eventId: string, memberId: string, input: Extract<RecipientDisposition, { kind: 'defer' }> & { id?: string }): Promise<ChannelEvent> {
    return this.store.mutate((state) => {
      const event = state.channelEvents.find((item) => item.id === eventId); const member = state.members.find((item) => item.id === memberId);
      if (!event) throw new ArcpError('not_found', 'channel event not found');
      if (!member || member.workspaceId !== event.workspaceId) throw new ArcpError('unauthorized', 'event defer is not authorized');
      const workspace = state.workspaces.find((item) => item.id === event.workspaceId);
      if (!intendedTarget(event, member, workspace)) throw new ArcpError('unauthorized', 'event defer is not authorized');
      if (['consumed', 'resolved', 'invalidated'].includes(event.consumptionState)) throw new ArcpError('invalid_request', 'closed channel obligations cannot be deferred');
      const policy = workspace?.channelDeferralPolicy ?? DEFAULT_CHANNEL_DEFERRAL_POLICY;
      if (event.priority === 'critical' && !policy.allowCriticalDeferral) throw new ArcpError('invalid_request', 'critical events require explicit Owner deferral policy');
      const reason = boundedReason(input.reason);
      const targetGeneration = this.accountableGeneration(state, event, member.id);
      const receiptId = input.id ?? idFor('disposition', JSON.stringify({ eventId: event.id, memberId: member.id, input: { kind: 'defer', reason, resume: input.resume }, targetGeneration }));
      if (event.dispositions.some((item) => item.id === receiptId)) return event;
      const priorDeferrals = event.dispositions.filter((item) => item.kind === 'defer');
      if (priorDeferrals.length >= policy.maxDeferrals) throw new ArcpError('invalid_request', 'channel deferral limit reached');
      let nextVisibleAt: string | undefined; let dependencyEventId: string | undefined; const resume = input.resume;
      if (resume.kind === 'at') { if (!Number.isFinite(Date.parse(resume.at))) throw new ArcpError('invalid_request', 'defer until must be an ISO time', 'until'); nextVisibleAt = new Date(Date.parse(resume.at)).toISOString(); }
      else if (resume.kind === 'after') { if (!Number.isFinite(resume.delayMs) || resume.delayMs <= 0) throw new ArcpError('invalid_request', 'defer delay must be positive', 'for'); nextVisibleAt = new Date(Date.now() + resume.delayMs).toISOString(); }
      else if (resume.kind === 'event') { if (!state.channelEvents.some((item) => item.id === resume.eventId)) throw new ArcpError('not_found', 'defer dependency event not found'); dependencyEventId = resume.eventId; }
      if (nextVisibleAt && Date.parse(nextVisibleAt) - Date.now() > policy.maxDeferredMs) throw new ArcpError('invalid_request', 'channel deferral exceeds workspace limit');
      const receipt = this.appendDisposition(event, { kind: 'defer', reason, resume }, member.id, targetGeneration, receiptId);
      if (receipt.nextVisibleAt) return event;
      if (nextVisibleAt) receipt.nextVisibleAt = nextVisibleAt;
      for (const delivery of state.deliveries) if (delivery.eventId === event.id && ['waiting_safe_point', 'attempting'].includes(delivery.state)) { delivery.state = 'withdrawn'; delivery.reason = 'event deferred'; }
      event.consumptionState = 'deferred'; event.nextVisibleAt = nextVisibleAt; event.dependencyEventId = dependencyEventId;
      return event;
    });
  }
  async resumeEvent(eventId: string, memberId: string, dispositionId?: string): Promise<ChannelEvent> {
    const event = await this.store.mutate((state) => {
      const item = state.channelEvents.find((value) => value.id === eventId); const member = state.members.find((value) => value.id === memberId);
      if (!item) throw new ArcpError('not_found', 'channel event not found'); const workspace = state.workspaces.find((value) => value.id === item.workspaceId);
      if (!member || !intendedTarget(item, member, workspace)) throw new ArcpError('unauthorized', 'event resume is not authorized');
      if (item.consumptionState !== 'deferred') return item;
      // Route explicit resume through the same due scheduler as elapsed and
      // dependency deferrals, so it gets exactly one fresh episode.
      item.nextVisibleAt = now(); delete item.dependencyEventId; return item;
    });
    await this.scheduleDueChannelEvents(); await this.pump(); return event;
  }
  /**
   * Channel events for a workspace, each carrying its canonical human
   * projection. The projection is computed here, at read time, from durable
   * facts; the append-only journal is never rewritten, so events recorded
   * before the projection existed are just as readable as new ones.
   */
  channelEvents(workspaceId: string, memberId?: string): ProjectedChannelEvent[] {
    const state = this.store.snapshot();
    const member = memberId ? state.members.find((item) => item.id === memberId) : undefined;
    const workspace = state.workspaces.find((item) => item.id === workspaceId);
    const facts = projectionFacts(state);
    return state.channelEvents
      .filter((event) => event.workspaceId === workspaceId && (!member || intendedTarget(event, member, workspace, true)))
      .map((event) => { const projection = projectChannelEvent(event, facts); return { ...event, projection, markdown: renderChannelMarkdown(projection, markdownOptions()) }; });
  }
  /**
   * Answer a `decision_required` event with an explicit verdict.
   *
   * The verdict is the judgement, not the prose: only `accept` may complete the
   * Task the decision was holding. A `refuse` records the same durable
   * `decision_resolved` event and clears the outstanding flag, but deliberately
   * leaves the Task open so the refused work can be reworked or reassigned.
   * Before this existed, resolving any decision completed its Task
   * unconditionally, so "resolved" meant "marked complete" rather than "judged".
   */
  async resolveDecision(eventId: string, sourceMemberId: string, summary: string, verdict: DecisionVerdict, dispositionId?: string): Promise<ChannelEvent> {
    if (verdict !== 'accept' && verdict !== 'refuse') throw new ArcpError('invalid_request', 'decision verdict must be accept or refuse', 'verdict');
    const reason = boundedReason(summary, 'summary');
    const resolved = await this.store.mutate((state) => {
      const triggering = state.channelEvents.find((event) => event.id === eventId && event.kind === 'decision_required');
      const resolver = state.members.find((member) => member.id === sourceMemberId);
      if (!triggering) throw new ArcpError('not_found', 'decision event not found');
      if (!resolver || resolver.workspaceId !== triggering.workspaceId) throw new ArcpError('unauthorized', 'decision resolver is not in the event workspace');
      const workspace = state.workspaces.find((item) => item.id === triggering.workspaceId);
      if (!intendedTarget(triggering, resolver, workspace)) throw new ArcpError('unauthorized', 'decision resolver is not an intended target');
      if (triggering.consumptionPolicy !== 'decision_required') throw new ArcpError('invalid_request', 'event does not require a decision');
      const existing = state.channelEvents.find((event) => event.kind === 'decision_resolved' && event.relatedEventId === eventId);
      if (existing) return existing;
      const targetGeneration = this.accountableGeneration(state, triggering, resolver.id);
      const receipt = this.appendDisposition(triggering, { kind: 'resolve', verdict, reason }, resolver.id, targetGeneration, dispositionId);
      triggering.decisionRequired = false;
      triggering.verdict = verdict;
      triggering.consumptionState = 'resolved'; triggering.resolvedAt = receipt.at;
      if (verdict === 'accept' && triggering.taskId) {
        const task = state.tasks.find((item) => item.id === triggering.taskId);
        if (task) {
          task.lifecycle = 'completed'; task.updatedAt = now();
          this.appendChannelEvent(state, { workspaceId: triggering.workspaceId, goalId: triggering.goalId, taskId: task.id, resultId: triggering.resultId, sourceMemberId, targetRole: 'manager', kind: 'task_completed', urgency: 'normal', consumptionPolicy: 'consume_on_delivery', decisionRequired: false, summary: `Task ${task.id} completed by durable Result`, evidenceRefs: [], notify: false });
        }
      }
      this.releaseBlockedRuntimes(state, eventId);
      return this.appendChannelEvent(state, { workspaceId: triggering.workspaceId, goalId: triggering.goalId, taskId: triggering.taskId, resultId: triggering.resultId, sourceMemberId, targetMemberId: triggering.sourceMemberId, targetActorId: triggering.sourceActorId, ...(triggering.sourceMemberId || triggering.sourceActorId ? {} : { targetRole: 'owner' }), kind: 'decision_resolved', urgency: 'normal', priority: 'normal', consumptionPolicy: 'consume_on_delivery', decisionRequired: false, verdict, summary: reason, evidenceRefs: [], relatedEventId: eventId });
    });
    await this.pump(); return resolved;
  }

  /** Manager ACK SLA defaults. Configurable rather than a hardcoded promise:
   * these are the design's starting local targets, not a product guarantee. */
  static readonly DEFAULT_ACK_SLA_MS = { urgent: 120_000, normal: 900_000 };

  /** Turn an unhandled Manager obligation into an Owner escalation automatically.
   *
   * Two triggers, deliberately distinct. An obligation can be overdue because
   * nobody acted on it within its SLA, or because the accountable Member is no
   * longer reachable at all — a lapsed lease means the handler is gone, and
   * waiting out the remaining SLA would only delay the escalation. Both funnel
   * through the same exactly-once escalation, so a repeated sweep re-derives
   * the same durable row instead of waking anyone twice. */
  async escalateOverdueObligations(input: { nowMs?: number; slaMs?: { urgent: number; normal: number } } = {}): Promise<Array<{ eventId: string; reason: 'ack_sla_expired' | 'handler_lease_expired' }>> {
    const now = input.nowMs ?? Date.now();
    const sla = input.slaMs ?? ArcpService.DEFAULT_ACK_SLA_MS;
    const state = this.store.snapshot();
    const due: Array<{ eventId: string; reason: 'ack_sla_expired' | 'handler_lease_expired' }> = [];
    for (const event of state.channelEvents) {
      if (!['ack_required', 'decision_required'].includes(event.consumptionPolicy)) continue;
      if (event.consumptionState !== 'open') continue;
      // An escalation must never escalate itself into a loop.
      if (event.id.endsWith(':owner-escalation')) continue;
      if (state.channelEvents.some((item) => item.id === `${event.id}:owner-escalation`)) continue;
      const handler = event.targetMemberId ? state.members.find((item) => item.id === event.targetMemberId) : undefined;
      const leaseLapsed = Boolean(handler?.leaseExpiresAt && Date.parse(handler.leaseExpiresAt) < now);
      const since = Date.parse(event.deliveredAt ?? event.createdAt);
      const budget = event.urgency === 'urgent' ? sla.urgent : sla.normal;
      const overdue = Number.isFinite(since) && now - since > budget;
      if (!leaseLapsed && !overdue) continue;
      due.push({ eventId: event.id, reason: leaseLapsed ? 'handler_lease_expired' : 'ack_sla_expired' });
    }
    const escalated: Array<{ eventId: string; reason: 'ack_sla_expired' | 'handler_lease_expired' }> = [];
    for (const item of due) {
      const reason = item.reason === 'handler_lease_expired'
        ? `accountable handler lease expired with obligation ${item.eventId} still open`
        : `Manager ACK SLA expired on obligation ${item.eventId}`;
      try { const result = await this.escalateToOwnerActor({ eventId: item.eventId, reason }); if (!result.alreadyEscalated) escalated.push(item); }
      catch { /* an obligation that cannot escalate stays visibly open rather than being dropped */ }
    }
    return escalated;
  }

  /** Resolve the Owner Actor's CURRENT channel binding. Identity is the Actor;
   * the binding is replaceable, so the newest generation wins and the caller
   * always names an exact binding rather than scanning for a plausible one. */
  private currentOwnerBinding(state: State, ownerActorId: string): ChannelBindingRef | undefined {
    const bindings = state.bindings.filter((item) => item.actorId === ownerActorId && this.channels.has(item.channel));
    if (!bindings.length) return undefined;
    const current = bindings.reduce((best, item) => (item.generation > best.generation ? item : best));
    if (!current.conversationRef) return undefined;
    return { actorId: ownerActorId, bindingId: current.id, generation: current.generation, adapterId: current.channel, recipientRef: current.conversationRef };
  }

  /** Escalate one unhandled Manager obligation to the Owner Deputy.
   *
   * Exactly-once is structural, not best-effort: the escalation event id is
   * derived from the triggering event, so a retry, a restart, or a second SLA
   * tick all resolve to the same durable row and the adapter sees the same
   * idempotency key. A missing or superseded binding is a durable
   * `undeliverable` escalation, never a silent drop. */
  async escalateToOwnerActor(input: { eventId: string; reason: string }): Promise<{ event: ChannelEvent; receipt?: TransportReceipt; alreadyEscalated: boolean }> {
    const escalationId = `${input.eventId}:owner-escalation`;
    const prepared = await this.store.mutate((state) => {
      const triggering = state.channelEvents.find((item) => item.id === input.eventId);
      if (!triggering) throw new ArcpError('not_found', 'event not found');
      if (triggering.consumptionState === 'resolved') throw new ArcpError('invalid_request', 'event is already resolved');
      const workspace = state.workspaces.find((item) => item.id === triggering.workspaceId);
      if (!workspace) throw new ArcpError('not_found', 'workspace not found');
      const existing = state.channelEvents.find((item) => item.id === escalationId);
      if (existing) return { event: existing, binding: undefined, alreadyEscalated: true };
      const binding = this.currentOwnerBinding(state, workspace.ownerActorId);
      const event = this.appendChannelEvent(state, {
        id: escalationId,
        workspaceId: triggering.workspaceId,
        ...(triggering.goalId ? { goalId: triggering.goalId } : {}),
        ...(triggering.taskId ? { taskId: triggering.taskId } : {}),
        ...(triggering.resultId ? { resultId: triggering.resultId } : {}),
        ...(triggering.sourceMemberId ? { sourceMemberId: triggering.sourceMemberId } : {}),
        targetActorId: workspace.ownerActorId,
        kind: 'decision_required',
        urgency: 'urgent',
        consumptionPolicy: 'decision_required',
        decisionRequired: true,
        summary: input.reason,
        evidenceRefs: [input.eventId],
        relatedEventId: input.eventId,
        notify: false,
      });
      if (!binding) { this.transitionEvent(event, 'undeliverable'); event.undeliverableReason = 'owner actor has no current channel binding'; }
      return { event, binding, alreadyEscalated: false };
    });
    if (prepared.alreadyEscalated || !prepared.binding) return { event: prepared.event, alreadyEscalated: prepared.alreadyEscalated };
    const adapter = this.channels.get(prepared.binding.adapterId) as ActorChannelAdapter;
    const receipt = await adapter.deliver(prepared.binding, {
      idempotencyKey: escalationId,
      recipientRef: prepared.binding.recipientRef,
      kind: 'decision_required',
      urgency: 'urgent',
      summary: input.reason,
      refs: [input.eventId],
    });
    await this.store.mutate((state) => {
      const event = state.channelEvents.find((item) => item.id === escalationId);
      if (!event) return undefined;
      // A transport receipt says the wire accepted an envelope. It never says a
      // human read it, so the obligation stays open until an explicit verdict.
      if (receipt.state === 'refused') { this.transitionEvent(event, 'undeliverable'); event.undeliverableReason = 'owner channel refused the envelope'; }
      else if (event.deliveryState !== 'delivered') this.transitionEvent(event, 'delivered');
      return undefined;
    });
    return { event: prepared.event, receipt, alreadyEscalated: false };
  }
  /**
   * Raise a provider question as a durable `decision_required` event and record
   * that this runtime is blocked on it.
   *
   * The blocked record is WRITTEN here, at the moment the prompt is raised,
   * because it cannot be recovered later: a runtime waiting on an in-turn
   * question reports `state=running, lastTurnState=running`, which is exactly
   * what a healthy runtime reports, so no amount of polling distinguishes them.
   * The existing permission/attention observation path is deliberately not
   * reused: it reads Paseo's host permission queue, which is empty by
   * construction for the unattended runtimes ARCP supervises, and is gated to
   * the paseo adapter, so it cannot see an in-turn question at all.
   *
   * Raising the same question again while it is still unanswered returns the
   * same event, so an agent that retries does not multiply prompts.
   */
  async raiseDecision(input: { runtimeSessionId: string; question: string; options?: string[]; evidenceRefs?: string[] }): Promise<{ event: ChannelEvent; session: RuntimeSession }> {
    const question = input.question?.trim();
    if (!question) throw new ArcpError('invalid_request', 'decision question is required', 'question');
    const raised = await this.store.mutate((state) => {
      const session = state.sessions.find((item) => item.id === input.runtimeSessionId);
      if (!session) throw new ArcpError('not_found', 'runtime session not found');
      if (!session.workspaceId) throw new ArcpError('invalid_request', 'runtime session is not attached to a workspace');
      if (session.blockedOnEventId) {
        const pending = state.channelEvents.find((event) => event.id === session.blockedOnEventId);
        if (pending && session.blockedQuestion !== question) throw new ArcpError('invalid_request', 'runtime is already blocked on an unanswered decision');
        if (pending) return { event: pending, session };
      }
      const event = this.appendChannelEvent(state, { workspaceId: session.workspaceId, goalId: session.goalId, taskId: session.taskId, sourceMemberId: session.memberId, sourceActorId: session.actorId, targetRole: 'owner', kind: 'decision_required', urgency: 'urgent', consumptionPolicy: 'decision_required', decisionRequired: true, summary: question, evidenceRefs: input.evidenceRefs ?? [], ...(input.options?.length ? { decisionOptions: input.options } : {}) });
      session.blockedOnEventId = event.id; session.blockedSince = now(); session.blockedQuestion = question;
      return { event, session };
    });
    await this.pump();
    const session = this.store.snapshot().sessions.find((item) => item.id === input.runtimeSessionId)!;
    return { event: raised.event, session };
  }
  /**
   * Runtimes currently parked on an unanswered decision, oldest first, with the
   * age measured from the moment the prompt was raised. This is the only honest
   * source for that age; provider status carries no trace of the wait.
   */
  blockedRuntimes(workspaceId?: string, at = Date.now()): Array<{ runtimeSessionId: string; memberId?: string; taskId?: string; eventId: string; question: string; options: string[]; since: string; ageMs: number }> {
    const state = this.store.snapshot();
    return state.sessions
      .filter((session) => session.blockedOnEventId && session.blockedSince && (!workspaceId || session.workspaceId === workspaceId))
      .map((session) => {
        const event = state.channelEvents.find((item) => item.id === session.blockedOnEventId);
        return { runtimeSessionId: session.id, ...(session.memberId ? { memberId: session.memberId } : {}), ...(session.taskId ? { taskId: session.taskId } : {}), eventId: session.blockedOnEventId!, question: session.blockedQuestion ?? event?.content.summary ?? '', options: event?.decisionOptions ?? [], since: session.blockedSince!, ageMs: Math.max(0, at - Date.parse(session.blockedSince!)) };
      })
      .sort((a, b) => b.ageMs - a.ageMs || a.runtimeSessionId.localeCompare(b.runtimeSessionId));
  }
  /**
   * Clear the blocked-on-decision record from every runtime that was parked on
   * this event. The record is written when the prompt is raised, so it is
   * cleared here rather than re-derived from provider status: a runtime waiting
   * on a tool prompt reports the same `state=running, lastTurnState=running` as
   * a healthy one, and nothing observable distinguishes them.
   */
  private releaseBlockedRuntimes(state: State, eventId: string): void {
    for (const session of state.sessions) {
      if (session.blockedOnEventId !== eventId) continue;
      delete session.blockedOnEventId; delete session.blockedSince; delete session.blockedQuestion;
    }
  }
  async createWorkspace(input: { ownerActorId: string; purpose: string }): Promise<{ workspace: ControlWorkspace; member: Member; credential: string }> {
    if (!input.purpose?.trim()) throw new ArcpError('invalid_request', 'workspace purpose is required');
    return this.store.mutate((state) => { const owner = state.actors.find((item) => item.id === input.ownerActorId); if (!owner) throw new ArcpError('unknown_recipient', 'owner actor is not registered'); const at = now(); const ownerMember = { id: `member_${randomUUID()}`, workspaceId: `workspace_pending`, actorId: owner.id, joinKind: 'native' as const, label: owner.label, role: 'owner', capabilities: ['claim_task','write_knowledge','submit_result','read_context'], lifecycle: 'active' as Member['lifecycle'], leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(), lastHeartbeatAt: at, createdAt: at, updatedAt: at }; const workspace = { id: `workspace_${randomUUID()}`, purpose: input.purpose.trim(), lifecycle: 'active' as const, ownerActorId: input.ownerActorId, ownerMemberId: ownerMember.id, createdAt: at, updatedAt: at }; ownerMember.workspaceId = workspace.id; const credential = randomBytes(32).toString('base64url'); state.memberCredentials[createHash('sha256').update(credential).digest('hex')] = ownerMember.id; state.workspaces.push(workspace); state.members.push(ownerMember); return { workspace, member: ownerMember, credential }; });
  }
  async joinWorkspace(input: { workspaceId: string; label: string; role: string; capabilities?: string[]; actorId?: string; joinKind?: 'managed' | 'native'; credential?: string }): Promise<{ member: Member; credential?: string }> {
    if (!input.label?.trim() || !input.role?.trim()) throw new ArcpError('invalid_request', 'member label and role are required');
    return this.store.mutate((state) => {
      if (!state.workspaces.some((item) => item.id === input.workspaceId)) throw new ArcpError('not_found', 'workspace not found');
      const credentialHash = input.credential ? createHash('sha256').update(input.credential).digest('hex') : undefined;
      let member = credentialHash ? state.members.find((item) => state.memberCredentials[credentialHash] === item.id) : undefined; let credential: string | undefined;
      if (!member) { credential = randomBytes(32).toString('base64url'); const at = now(); const hash = createHash('sha256').update(credential).digest('hex'); member = { id: `member_${randomUUID()}`, workspaceId: input.workspaceId, ...(input.actorId ? { actorId: input.actorId } : {}), joinKind: input.joinKind ?? 'native', label: input.label.trim(), role: input.role.trim(), capabilities: input.capabilities ?? defaultMemberCapabilities(input.role), lifecycle: 'active', leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(), lastHeartbeatAt: at, createdAt: at, updatedAt: at }; state.members.push(member); state.memberCredentials[hash] = member.id; }
      return { member, ...(credential ? { credential } : {}) };
    });
  }
  memberForCredential(credential: string): Member { const state = this.store.snapshot(); const id = state.memberCredentials[createHash('sha256').update(credential).digest('hex')]; const member = state.members.find((item) => item.id === id); if (!member) throw new ArcpError('unknown_sender', 'member credential is unknown'); return member; }
  async createTask(input: { workspaceId: string; title: string; scope?: TaskScope; executionSurfaceId?: string }): Promise<Task> { return this.store.mutate((state) => { if (!state.workspaces.some((item) => item.id === input.workspaceId)) throw new ArcpError('not_found', 'workspace not found'); if (input.executionSurfaceId && !state.executionSurfaces.some((surface) => surface.id === input.executionSurfaceId)) throw new ArcpError('not_found', 'execution surface not found'); if (!input.title?.trim()) throw new ArcpError('invalid_request', 'task title is required'); const at = now(); const task = { id: `task_${randomUUID()}`, workspaceId: input.workspaceId, title: input.title.trim(), lifecycle: 'ready' as const, fence: 0, createdAt: at, updatedAt: at, ...(input.scope ? { scope: input.scope } : {}), ...(input.executionSurfaceId ? { executionSurfaceId: input.executionSurfaceId } : {}) }; state.tasks.push(task); return task; }); }
  async heartbeat(memberId: string, presence: 'idle' | 'busy' | 'attention' = 'idle'): Promise<Member> { return this.store.mutate((state) => { const member = state.members.find((item) => item.id === memberId); if (!member) throw new ArcpError('unknown_sender', 'member is unknown'); const at = now(); member.lifecycle = presence; member.lastHeartbeatAt = at; member.leaseExpiresAt = new Date(Date.now() + 300_000).toISOString(); member.updatedAt = at; return member; }); }
  /** ARCP issues one managed member credential per launched runtime and ships
   * it to that runtime alone. Attribution is only trustworthy while the acting
   * member is that identity, so a Task already bound to a launched runtime
   * refuses a different presenter and records the mismatch durably. A borrowed
   * but otherwise valid credential is therefore detectable and refusable
   * instead of silently accepted. */
  private async enforceRuntimeIdentityBinding(taskId: string, memberId: string, action: 'claim' | 'result'): Promise<void> {
    const state = this.store.snapshot();
    const bound = state.sessions.filter((item) => item.taskId === taskId && item.memberId && item.state !== 'terminal' && state.members.some((member) => member.id === item.memberId && member.joinKind === 'managed'));
    if (!bound.length || bound.some((item) => item.memberId === memberId)) return;
    const session = bound[0];
    const why = `member ${memberId} is not the runtime identity ARCP issued for task ${taskId} (runtime ${session.id} acts as ${session.memberId})`;
    // A task/session binding applies equally to the state transition that
    // claims work and the state transition that settles it. Even corrupted
    // durable task ownership must not turn a borrowed valid credential into a
    // valid Result for another runtime.
    await this.publishChannelEvent({ ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}), taskId, sourceMemberId: memberId, targetRole: 'manager', kind: 'attention', urgency: 'urgent', consumptionPolicy: 'ack_required', decisionRequired: false, summary: `Borrowed-credential ${action} refused: ${why}`, evidenceRefs: [], notify: false }).catch(() => undefined);
    throw new ArcpError('unauthorized', `task ${action} refused: ${why}`);
  }
  async claimTask(taskId: string, memberId: string, expectedFence?: number): Promise<Task> { await this.enforceRuntimeIdentityBinding(taskId, memberId, 'claim'); const claimed = await this.store.mutate((state) => { const task = state.tasks.find((item) => item.id === taskId); const member = state.members.find((item) => item.id === memberId); if (!task || !member || task.workspaceId !== member.workspaceId) throw new ArcpError('unknown_recipient', 'task or member is unknown'); if (!member.capabilities.includes('claim_task')) throw new ArcpError('unauthorized', 'member lacks claim_task capability'); if (member.role === 'steward' || (member.role === STEWARD_ANALYSIS_ROLE && task.scope !== 'steward_analysis')) throw new ArcpError('unauthorized', 'Steward credentials cannot claim product Tasks'); if (expectedFence === undefined) throw new ArcpError('invalid_request', 'expectedFence is required; pass --expected-fence', 'expectedFence'); if (task.fence !== expectedFence) throw new ArcpError('stale_generation', `task claim fence is stale; current fence is ${task.fence}`); if (task.ownerMemberId === memberId && ['claimed', 'running', 'waiting'].includes(task.lifecycle)) return task; if (task.ownerMemberId && ['claimed', 'running', 'waiting'].includes(task.lifecycle)) throw new ArcpError('task_held', 'task already has an active claim'); task.ownerMemberId = memberId; task.fence += 1; task.lifecycle = 'claimed'; task.updatedAt = now(); member.lifecycle = 'busy'; member.updatedAt = now(); return task; }); await this.publishChannelEvent({ workspaceId: claimed.workspaceId, taskId: claimed.id, sourceMemberId: claimed.ownerMemberId, targetRole: 'manager', kind: 'task_claimed', urgency: 'normal', consumptionPolicy: 'consume_on_delivery', decisionRequired: false, summary: `Task ${claimed.id} claimed at fence ${claimed.fence}`, evidenceRefs: [] }); return claimed; }
  async addKnowledge(input: { workspaceId: string; authorMemberId: string; kind: KnowledgeEntry['kind']; text: string; tags?: string[]; taskId?: string; goalId?: string; targetMemberId?: string }): Promise<KnowledgeEntry> { const entry = await this.store.mutate((state) => { const member = state.members.find((item) => item.id === input.authorMemberId && item.workspaceId === input.workspaceId); if (!member) throw new ArcpError('unknown_sender', 'member is not in workspace'); if (!input.text?.trim()) throw new ArcpError('invalid_request', 'knowledge text is required'); const entry = { id: `knowledge_${randomUUID()}`, workspaceId: input.workspaceId, authorMemberId: input.authorMemberId, kind: input.kind, text: input.text.trim(), tags: input.tags ?? [], ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.goalId ? { goalId: input.goalId } : {}), createdAt: now() }; state.knowledge.push(entry); return entry; }); if (input.kind === 'blocker' || input.kind === 'evidence') await this.publishChannelEvent({ workspaceId: entry.workspaceId, taskId: entry.taskId, goalId: entry.goalId, sourceMemberId: entry.authorMemberId, ...(input.targetMemberId ? { targetMemberId: input.targetMemberId } : {}), ...(input.targetMemberId ? {} : { targetRole: 'manager' }), kind: input.kind === 'blocker' ? 'blocker' : 'finding', urgency: input.kind === 'blocker' ? 'urgent' : 'normal', consumptionPolicy: input.kind === 'blocker' ? 'ack_required' : 'consume_on_delivery', decisionRequired: input.kind === 'blocker', summary: `${input.kind} knowledge ${entry.id}`, evidenceRefs: [] }); return entry; }
  async submitResult(input: { workspaceId: string; taskId: string; memberId: string; status: Result['status']; summary: string; evidenceRefs?: string[]; expectedFence?: number; sourceId?: string }): Promise<Result> { await this.enforceRuntimeIdentityBinding(input.taskId, input.memberId, 'result'); const submitted = await this.store.mutate((state) => { const task = state.tasks.find((item) => item.id === input.taskId && item.workspaceId === input.workspaceId); const member = state.members.find((item) => item.id === input.memberId && item.workspaceId === input.workspaceId); if (!task || !member || task.ownerMemberId !== input.memberId) throw new ArcpError('task_held', 'member does not hold this task'); if (!member.capabilities.includes('submit_result')) throw new ArcpError('unauthorized', 'member lacks submit_result capability'); if (member.role === 'steward' || (member.role === STEWARD_ANALYSIS_ROLE && task.scope !== 'steward_analysis')) throw new ArcpError('unauthorized', 'Steward credentials cannot submit product Results'); if (!['candidate','failed','unknown'].includes(input.status)) throw new ArcpError('invalid_request', 'invalid result status'); if (input.expectedFence === undefined) throw new ArcpError('invalid_request', 'expectedFence is required; pass --expected-fence', 'expectedFence'); if (task.fence !== input.expectedFence) throw new ArcpError('stale_generation', `result fence is stale; current fence is ${task.fence}`); if ((input.evidenceRefs ?? []).some((value) => value.startsWith('/'))) throw new ArcpError('invalid_request', 'absolute evidence paths are not allowed'); const existing = input.sourceId ? state.results.find((item) => item.sourceId === input.sourceId) : undefined; if (existing) { if (existing.workspaceId !== input.workspaceId || existing.taskId !== input.taskId || existing.memberId !== input.memberId || existing.fence !== task.fence || existing.status !== input.status || existing.summary !== input.summary.trim() || JSON.stringify(existing.evidenceRefs) !== JSON.stringify(input.evidenceRefs ?? [])) throw new ArcpError('invalid_request', 'result source id conflicts with its durable payload', 'sourceId'); return existing; } const result = { id: `result_${randomUUID()}`, workspaceId: input.workspaceId, taskId: input.taskId, memberId: input.memberId, fence: task.fence, status: input.status, summary: input.summary.trim(), evidenceRefs: input.evidenceRefs ?? [], ...(input.sourceId ? { sourceId: input.sourceId } : {}), createdAt: now() }; state.results.push(result); for (const pending of state.deliveries.filter((item) => item.purpose === 'contract' && item.subject?.taskId === task.id && ['queued', 'held', 'waiting_safe_point', 'attempting'].includes(item.state))) { pending.state = 'withdrawn'; pending.refusedReason = `task ${task.id} already submitted result ${result.id}`; pending.reason = pending.refusedReason; } if (input.status === 'candidate') task.lifecycle = 'waiting'; else if (input.status === 'failed') task.lifecycle = 'failed'; else if (input.status === 'unknown') task.lifecycle = 'unknown'; task.updatedAt = now(); if (task.executionSurfaceId) { for (const claim of state.surfaceClaims.filter((claim) => claim.executionSurfaceId === task.executionSurfaceId && claim.active)) { claim.active = false; claim.releasedAt = now(); } const surface = state.executionSurfaces.find((surface) => surface.id === task.executionSurfaceId); if (surface) { surface.operationalState = input.status === 'candidate' ? 'accepted' : input.status === 'failed' ? 'abandoned' : 'parked'; surface.updatedAt = now(); } } const kind = input.status === 'candidate' ? 'task_candidate' : input.status === 'failed' ? 'task_failed' : 'task_unknown'; const candidate = this.appendChannelEvent(state, { id: input.sourceId ? `event_${input.sourceId}` : undefined, workspaceId: result.workspaceId, taskId: result.taskId, resultId: result.id, sourceMemberId: result.memberId, kind, urgency: 'normal', consumptionPolicy: 'consume_on_delivery', decisionRequired: input.status === 'candidate', summary: result.summary, evidenceRefs: result.evidenceRefs, notify: false }); if (input.status === 'candidate') { const route = state.sessions.find((item) => item.taskId === result.taskId && item.reportingRoute)?.reportingRoute; const primary = route?.primaryHandlerMemberId; const decision = this.appendChannelEvent(state, { id: input.sourceId ? `event_${input.sourceId}:decision` : undefined, workspaceId: result.workspaceId, taskId: result.taskId, resultId: result.id, sourceMemberId: result.memberId, ...(primary ? { targetMemberId: primary } : { targetRole: 'manager' }), kind: 'decision_required', urgency: 'normal', consumptionPolicy: 'decision_required', decisionRequired: true, summary: `Result ${result.id} requires ${primary ? `a decision from its accountable handler ${primary}` : 'Manager decision'}`, evidenceRefs: [], relatedEventId: candidate.id });
      // CC is observe-only: it references the same decision without minting a
      // second obligation, so a completed review is routed to the accountable
      // handler rather than broadcast.
      for (const cc of route?.ccMemberIds ?? []) this.appendChannelEvent(state, { ...(input.sourceId ? { id: `event_${input.sourceId}:cc:${cc}` } : {}), workspaceId: result.workspaceId, taskId: result.taskId, resultId: result.id, sourceMemberId: result.memberId, targetMemberId: cc, kind: 'material_progress', urgency: 'normal', consumptionPolicy: 'consume_on_delivery', decisionRequired: false, summary: `Observe-only copy: result ${result.id} is routed to ${primary ?? 'the Manager'} for decision`, evidenceRefs: [], relatedEventId: decision.id, notify: false });
    } return result; }); await this.pump(); return submitted; }
  context(workspaceId: string, memberId?: string) { const state = this.store.snapshot(); const workspace = state.workspaces.find((item) => item.id === workspaceId); if (!workspace) throw new ArcpError('not_found', 'workspace not found'); const roster = state.members.filter((item) => item.workspaceId === workspaceId).map((member) => ({ ...member, lifecycle: member.leaseExpiresAt && Date.parse(member.leaseExpiresAt) < Date.now() ? 'offline' as const : member.lifecycle })); const member = memberId ? state.members.find((item) => item.id === memberId) : undefined; return { workspace, roster, tasks: state.tasks.filter((item) => item.workspaceId === workspaceId), knowledge: state.knowledge.filter((item) => item.workspaceId === workspaceId), results: state.results.filter((item) => item.workspaceId === workspaceId), events: this.channelEvents(workspaceId, memberId), inbox: member ? this.projectedInbox(state, member, workspace) : [] }; }
  /** The member inbox renders the same canonical projection as `channel list`. */
  private projectedInbox(state: State, member: Member, workspace: ControlWorkspace): ProjectedInboxItem[] {
    const facts = projectionFacts(state);
    return state.channelEvents.filter((event): event is ChannelEvent & { consumptionState: 'open' | 'deferred' } => event.workspaceId === workspace.id && ['open', 'deferred'].includes(event.consumptionState) && intendedTarget(event, member, workspace)).map((event) => {
      const projection = projectChannelEvent(event, facts);
      const deliveries = state.deliveries.filter((item) => item.eventId === event.id).map((item) => ({ ...item, projection, markdown: renderChannelMarkdown(projection, markdownOptions()) }));
      const facet = event.consumptionState === 'open' ? 'due' : event.dependencyEventId ? 'waiting_dependency' : event.nextVisibleAt ? 'deferred' : 'manual';
      return { eventId: event.id, consumptionState: event.consumptionState, facet, ...(event.nextVisibleAt ? { nextVisibleAt: event.nextVisibleAt } : {}), ...(event.dependencyEventId ? { dependencyEventId: event.dependencyEventId } : {}), deliveries, projection, markdown: renderChannelMarkdown(projection, markdownOptions()), ...(deliveries[0]?.body ? { body: deliveries[0].body } : {}) };
    });
  }
  private requested(session: RuntimeSession): RuntimeSettings { return { provider: session.provider, model: session.model, ...(session.mode ? { mode: session.mode } : {}), ...(session.thinking ? { thinking: session.thinking } : {}) }; }
  private async children(externalId?: string, adapter: RuntimeAdapter = this.adapter): Promise<ChildObservation> {
    if (!externalId) return { source: 'unavailable', items: [] };
    const provider = await adapter.providerSubagents(externalId);
    try {
      const agents = (await adapter.registry()).value; if (!Array.isArray(agents)) return provider;
      const parent = agents.map(asRecord).filter((item) => String(item.ParentAgentId ?? item.parentAgentId ?? '') === externalId).map((item) => ({ id: String(item.id ?? item.agentId), status: String(item.status ?? item.Status ?? 'unknown'), source: 'paseo_parent' as const })).filter((item) => item.id);
      const all = [...provider.items, ...parent.filter((item) => !provider.items.some((child) => child.id === item.id))]; return { source: provider.source === 'provider_subagents' ? 'provider_subagents' : parent.length ? 'paseo_parent' : provider.source, items: all };
    } catch { return provider.source === 'provider_subagents' ? provider : { source: 'unavailable', items: [] }; }
  }
  private async workSummary(cwd?: string): Promise<WorkSummary> {
    if (!cwd) return { dirty: 'unknown', diffstat: 'unknown' };
    try {
      const [commit, status, stat] = await Promise.all([git(cwd, ['log', '-1', '--format=%H%x1f%s%x1f%cI']), git(cwd, ['status', '--porcelain']), git(cwd, ['diff', '--shortstat', 'HEAD'])]);
      const [sha, subject, time] = commit.trim().split('\x1f'); const match = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(stat);
      const untracked = status.split('\n').filter((line) => line.startsWith('?? ')).length;
      return { ...(sha && subject && time ? { latestCommit: { sha, subject, time } } : {}), dirty: Boolean(status.trim()), diffstat: match ? { files: Number(match[1]) + untracked, insertions: Number(match[2] ?? 0), deletions: Number(match[3] ?? 0) } : { files: untracked, insertions: 0, deletions: 0 } };
    } catch { return { dirty: 'unknown', diffstat: 'unknown' }; }
  }
  /**
   * Supervision: configure one budget policy per Workspace, evaluate it against
   * durable facts, and record a breach as a review subject.
   *
   * A breach NEVER kills, retries or duplicates work. It appends one durable
   * review record and one `workspace_analysis_required` ChannelEvent, both
   * addressed by a content-derived id so the same breach observed again — on a
   * later tick or after a restart — resolves to the same two records.
   */
  async configureSupervision(input: { workspaceId: string; reviewAfterMs?: number; inactivityAfterMs?: number; cooldownMs?: number; stewardProfileId?: string; automatic?: boolean }): Promise<SupervisionPolicy> {
    const budget = (value: number | undefined, field: string): number | undefined => {
      if (value === undefined) return undefined;
      if (!Number.isSafeInteger(value) || value <= 0) throw new ArcpError('invalid_request', `${field} must be a positive whole number of milliseconds`, field);
      return value;
    };
    const reviewAfterMs = budget(input.reviewAfterMs, 'reviewAfterMs');
    const inactivityAfterMs = budget(input.inactivityAfterMs, 'inactivityAfterMs');
    const cooldownMs = budget(input.cooldownMs, 'cooldownMs') ?? DEFAULT_SUPERVISION_COOLDOWN_MS;
    return this.store.mutate((state) => {
      if (!state.workspaces.some((item) => item.id === input.workspaceId)) throw new ArcpError('not_found', 'workspace not found');
      const existing = state.supervisionPolicies.find((item) => item.workspaceId === input.workspaceId);
      const stewardProfileId = input.stewardProfileId?.trim() || existing?.stewardProfileId || DEFAULT_STEWARD_PROFILE_ID;
      const stewardProfile = this.profileData.find((profile) => profile.id === stewardProfileId);
      if (!stewardProfile) throw new ArcpError('invalid_request', 'steward profile is not a configured profile', 'stewardProfileId');
      // Both Steward triggers share this profile. A prompting or non-Codex
      // profile would block unattended analysis and is rejected at policy time.
      if (stewardProfile.provider !== 'codex' || capabilityToken(stewardProfile.mode ?? '') !== 'fullaccess') throw new ArcpError('invalid_request', 'Steward profile must be Codex full-access (non-prompting)', 'stewardProfileId');
      const nextReviewAfterMs = reviewAfterMs ?? existing?.reviewAfterMs;
      const nextInactivityAfterMs = inactivityAfterMs ?? existing?.inactivityAfterMs;
      if (nextReviewAfterMs === undefined && nextInactivityAfterMs === undefined) throw new ArcpError('invalid_request', 'a supervision policy needs reviewAfterMs or inactivityAfterMs', 'reviewAfterMs');
      const at = now();
      const policy: SupervisionPolicy = {
        id: existing?.id ?? supervisionPolicyId(input.workspaceId),
        workspaceId: input.workspaceId,
        ...(nextReviewAfterMs !== undefined ? { reviewAfterMs: nextReviewAfterMs } : {}),
        ...(nextInactivityAfterMs !== undefined ? { inactivityAfterMs: nextInactivityAfterMs } : {}),
        cooldownMs: input.cooldownMs === undefined && existing ? existing.cooldownMs : cooldownMs,
        stewardProfileId,
        automatic: input.automatic ?? existing?.automatic ?? true,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      };
      if (existing) state.supervisionPolicies[state.supervisionPolicies.indexOf(existing)] = policy;
      else state.supervisionPolicies.push(policy);
      return policy;
    });
  }
  supervisionPolicy(workspaceId: string): SupervisionPolicy | undefined { return this.store.snapshot().supervisionPolicies.find((item) => item.workspaceId === workspaceId); }
  supervisionReviews(workspaceId: string): SupervisionReview[] { return this.store.snapshot().supervisionReviews.filter((item) => item.workspaceId === workspaceId); }
  /**
   * Record durable evidence that arrived from outside the ARCP record set: a
   * commit, or a runtime observation. An identical digest is a keepalive: it is
   * recorded once and never advances the inactivity clock again.
   */
  async recordSupervisionSignal(input: { workspaceId: string; subjectId: string; kind: SupervisionSignalKind; digest: string; observedAt?: string }): Promise<SupervisionSignal> {
    const digest = input.digest?.trim();
    if (!digest) throw new ArcpError('invalid_request', 'a supervision signal needs a digest', 'digest');
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(digest)) throw new ArcpError('invalid_request', 'a supervision signal digest must be an opaque token', 'digest');
    const observedAt = input.observedAt ?? now();
    return this.store.mutate((state) => {
      if (!state.workspaces.some((item) => item.id === input.workspaceId)) throw new ArcpError('not_found', 'workspace not found');
      const prior = state.supervisionSignals.filter((item) => item.subjectId === input.subjectId && item.kind === input.kind).sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id)).at(-1);
      if (prior?.digest === digest) return prior;
      const signal: SupervisionSignal = { id: supervisionSignalId(input.subjectId, input.kind, digest, observedAt), workspaceId: input.workspaceId, subjectId: input.subjectId, kind: input.kind, digest, observedAt };
      const existing = state.supervisionSignals.find((item) => item.id === signal.id);
      if (existing) return existing;
      state.supervisionSignals.push(signal);
      return signal;
    });
  }
  private supervisionView(state: State): SupervisionView {
    return {
      subjects: state.tasks.map((task) => ({ id: task.id, workspaceId: task.workspaceId, generation: task.fence, lifecycle: task.lifecycle, createdAt: task.createdAt, updatedAt: task.updatedAt, ...(task.scope ? { scope: task.scope } : {}), ...(task.ownerMemberId && state.members.find((member) => member.id === task.ownerMemberId)?.role ? { ownerRole: state.members.find((member) => member.id === task.ownerMemberId)!.role } : {}) })),
      results: state.results.map((result) => ({ taskId: result.taskId, createdAt: result.createdAt })),
      knowledge: state.knowledge.map((entry) => ({ taskId: entry.taskId, createdAt: entry.createdAt })),
      events: state.channelEvents.map((event) => ({ taskId: event.taskId, kind: event.kind, createdAt: event.createdAt })),
      signals: state.supervisionSignals,
      policies: state.supervisionPolicies,
      reviews: state.supervisionReviews,
    };
  }
  /** The last durable evidence of work on a Task, with the evidence category. */
  supervisionProgress(taskId: string): { at: string; source: string } | undefined {
    const state = this.store.snapshot();
    const task = state.tasks.find((item) => item.id === taskId);
    return task ? materialProgressAt(this.supervisionView(state), { id: task.id, workspaceId: task.workspaceId, generation: task.fence, lifecycle: task.lifecycle, createdAt: task.createdAt, updatedAt: task.updatedAt, ...(task.scope ? { scope: task.scope } : {}), ...(task.ownerMemberId && state.members.find((member) => member.id === task.ownerMemberId)?.role ? { ownerRole: state.members.find((member) => member.id === task.ownerMemberId)!.role } : {}) }) : undefined;
  }
  /**
   * Evaluate every automatic policy at `nowMs` and durably record any breach.
   *
   * The clock is a parameter so a tick is reproducible and never races a wall
   * clock. Repeated ticks across a breach are idempotent.
   */
  async evaluateSupervision(nowMs: number = Date.now()): Promise<SupervisionReview[]> {
    const created = await this.store.mutate((state) => {
      const breaches = evaluateSupervision(this.supervisionView(state), nowMs);
      const reviews: SupervisionReview[] = [];
      for (const breach of breaches) {
        if (state.supervisionReviews.some((item) => item.id === breach.reviewId)) continue;
        const event = this.appendChannelEvent(state, {
          id: breach.eventId,
          workspaceId: breach.workspaceId,
          taskId: breach.subjectId,
          targetRole: 'manager',
          kind: 'workspace_analysis_required',
          urgency: 'urgent',
          consumptionPolicy: 'ack_required',
          decisionRequired: false,
          summary: `Workspace analysis required for ${breach.subjectKind} ${breach.subjectId} at generation ${breach.generation}; the ${breach.reason === 'review_budget' ? 'review budget' : 'inactivity budget'} elapsed`,
          evidenceRefs: [breach.subjectId, breach.policyId],
        });
        const review: SupervisionReview = { id: breach.reviewId, workspaceId: breach.workspaceId, policyId: breach.policyId, subjectKind: breach.subjectKind, subjectId: breach.subjectId, generation: breach.generation, reason: breach.reason, eventId: event.id, breachedAt: breach.breachedAt, lastProgressAt: breach.lastProgressAt, cooldownUntil: breach.cooldownUntil, state: 'open' };
        state.supervisionReviews.push(review);
        // Elapsed time is not failure. The subject keeps its lifecycle, its
        // claim and its runtime: nothing here stops, retries or re-queues work.
        reviews.push(review);
      }
      return reviews;
    });
    if (created.length > 0) {
      await this.pump();
      // A newly-recorded breach is the automatic Steward trigger. The
      // WorkspaceSteward accessor is also used by the manual HTTP/CLI route,
      // so both triggers enter one execution path. Provider/timeout failures
      // leave the review durable and simply produce no report.
      for (const review of created) {
        try {
          const steward = await this.workspaceSteward(review.workspaceId);
          await steward.onSupervisionBreach({ workspaceId: review.workspaceId, subjectTaskId: review.subjectId, generation: review.generation, reason: review.reason, progressSince: review.lastProgressAt, observedAt: review.breachedAt, breachEventId: review.eventId } as any);
        } catch { /* review reconciliation remains durable when Codex is unavailable */ }
      }
    }
    return created;
  }
  /** Reconciliation: a Manager or Owner closes the review loop for one breach. */
  async acknowledgeSupervisionReview(reviewId: string, memberId: string): Promise<SupervisionReview> {
    return this.store.mutate((state) => {
      const review = state.supervisionReviews.find((item) => item.id === reviewId);
      if (!review) throw new ArcpError('not_found', 'supervision review not found');
      const member = state.members.find((item) => item.id === memberId);
      const workspace = state.workspaces.find((item) => item.id === review.workspaceId);
      if (!member || member.workspaceId !== review.workspaceId) throw new ArcpError('unauthorized', 'supervision review acknowledgement is not authorized');
      if (member.role !== 'manager' && workspace?.ownerMemberId !== member.id) throw new ArcpError('unauthorized', 'supervision review acknowledgement is not authorized');
      review.state = 'acknowledged'; review.acknowledgedAt = now(); review.acknowledgedByMemberId = memberId;
      return review;
    });
  }
  async runtimeStatus(id: string, refresh = false): Promise<{ session: RuntimeSession; observation: RuntimeObservation; children: ChildObservation; workSummary: WorkSummary }> {
    if (refresh) await this.observe(id);
    let session = this.store.snapshot().sessions.find((item) => item.id === id); if (!session) throw new ArcpError('not_found', 'runtime session not found');
    const requested = this.requested(session); let agent: Record<string, any> | undefined; let timeline: unknown[] | undefined; let source: 'sdk' | 'cli' | undefined;
    const externalId = await this.canonicalRuntimeIdentity(session);
    if (externalId) try { const snapshot = await this.adapterFor(session).snapshot(externalId); agent = snapshot.agent; timeline = snapshot.timeline; source = snapshot.source; } catch {
      // A failed live read cannot be presented as the previous healthy state for
      // a runtime believed live, so uncertainty stays fail-closed there. But a
      // session that already settled to terminal is not made uncertain by a read
      // that fails: rewriting it would resurrect a non-terminal session, refuse
      // relaunch with goal_held, and inflate activeRuntimeCount — and panorama
      // would amplify that across every session in a single pass.
      if (session.state !== 'terminal') session = await this.store.mutate((state) => {
        const item = state.sessions.find((value) => value.id === id)!;
        item.state = 'transport_indeterminate';
        for (const binding of state.runtimeBindings.filter((value) => value.runtimeSessionId === id)) binding.state = 'transport_indeterminate';
        return item;
      });
    }
    const current = agent ?? {}; const usage = safeJson(current.lastUsage); const numeric = (value: unknown): number | 'unknown' => typeof value === 'number' && Number.isFinite(value) ? value : 'unknown';
    const used = numeric(usage.contextWindowUsedTokens); const max = numeric(usage.contextWindowMaxTokens); const ratio = typeof used === 'number' && typeof max === 'number' && max > 0 ? used / max : 'unknown';
    const observed: Partial<RuntimeSettings> = agent ? { ...(setting(current.provider) ? { provider: String(current.provider) } : {}), ...(setting(current.model) ? { model: String(current.model) } : {}), ...(setting(current.currentModeId ?? current.mode) ? { mode: String(current.currentModeId ?? current.mode) } : {}), ...(setting(current.effectiveThinkingOptionId ?? current.thinkingOptionId ?? current.thinking) ? { thinking: String(current.effectiveThinkingOptionId ?? current.thinkingOptionId ?? current.thinking) } : {}) } : (session.observed ?? {});
    const mismatch = isAttachedParticipant(session) ? false : Boolean((requested.provider && !sameSetting(requested.provider, observed.provider)) || (requested.model && !sameSetting(requested.model, observed.model)) || (requested.mode && !sameSetting(requested.mode, observed.mode)) || (requested.thinking && !sameSetting(requested.thinking, observed.thinking)));
    const cacheInfo = agent ? this.cacheState(current, timeline ?? []) : { activityAt: undefined, ageMinutes: undefined, state: 'unknown' as const };
    const compactions = Array.isArray(timeline) ? timeline.map(safeJson).filter((item) => item.type === 'compaction') : [];
    const lastCompaction = compactions.at(-1); const observedAt = agent ? now() : session.lastObservedAt; const age = observedAt ? Date.now() - Date.parse(observedAt) : NaN;
    const freshness: RuntimeObservation['freshness'] = agent ? 'fresh' : !observedAt ? 'unavailable' : Number.isFinite(age) && age > 60_000 ? 'stale' : 'unknown';
    // Paseo marks a completed turn as requiring acknowledgement too; that is not
    // an actionable permission/attention condition for ARCP supervision.
    const pending = agent ? (Array.isArray(current.pendingPermissions) ? current.pendingPermissions.length : 'unknown') : 'unknown'; const attention = agent ? pending === 'unknown' ? (current.attentionReason === 'permission' || current.status === 'permission' || session.lastTurnState === 'requires_action' ? true : 'unknown') : pending !== 0 || current.attentionReason === 'permission' || current.status === 'permission' : 'unknown'; const attentionWhy = attention === true ? String(current.attentionReason ?? (pending !== 'unknown' && pending > 0 ? 'pending permission' : session.lastTurnState === 'requires_action' ? 'runtime requires action' : 'runtime attention')) : undefined;
    const health: RuntimeObservation['health'] = attention === true || mismatch || session.state === 'attention' ? 'attention' : !agent && !externalId ? 'unavailable' : freshness === 'stale' || session.state === 'transport_indeterminate' ? 'degraded' : agent ? 'healthy' : 'unknown';
    if ((session.adapterId === 'paseo' || session.runtimeKind === 'paseo') && session.workspaceId && (pending !== 'unknown' && pending > 0 || attention === true)) {
      const facts: Array<{ kind: 'permission' | 'attention'; summary: string }> = [];
      if (pending !== 'unknown' && pending > 0) facts.push({ kind: 'permission', summary: `Runtime ${session.id} has pending permission requests` });
      if (attention === true) facts.push({ kind: 'attention', summary: `Runtime ${session.id} requires attention` });
      await Promise.all(facts.map((fact) => this.publishChannelEvent({ semanticKey: `observation:${session.externalId ?? session.id}:${session.generation}:${fact.kind}:${session.workspaceId}:${session.goalId}:${session.taskId ?? ''}:${session.memberId ?? ''}`, workspaceId: session.workspaceId, goalId: session.goalId, taskId: session.taskId, sourceMemberId: session.memberId, sourceActorId: session.actorId, targetRole: 'manager', kind: fact.kind, urgency: 'urgent', consumptionPolicy: fact.kind === 'permission' ? 'decision_required' : 'ack_required', decisionRequired: true, summary: fact.summary, evidenceRefs: [] })));
    }
    const nativeTurnId = setting(current.activeTurn?.turnId ?? current.activeTurn?.id ?? agent?.lastTurnId ?? agent?.lastMessageId);
    // Paseo does not document whether `lastUsage` is per-turn or cumulative for
    // this native turn id. Keep its displayed observation reported, but never
    // sum it into burn deltas until that provenance is proven.
    if (agent && nativeTurnId) this.runtimeBudget.record({ runtimeSessionId: session.id, providerId: session.provider, model: session.model, ...(session.mode ? { mode: session.mode } : {}), ...(session.thinking ? { thinking: session.thinking } : {}), sampledAt: observedAt ?? now(), turnCountDelta: 1, ...(typeof used === 'number' ? { contextUsed: used } : {}), ...(typeof max === 'number' ? { contextMax: max } : {}), wakeCategory: 'unknown', sourceEventId: nativeTurnId });
    const burn = this.runtimeBudget.view(session.id, this.runtimeBudgetPolicy);
    return { session, observation: { status: session.state, activeTurn: agent ? Boolean(current.activeTurn) : 'unknown', usage: { input: numeric(usage.inputTokens), cached: numeric(usage.cachedInputTokens), output: numeric(usage.outputTokens) }, context: { used, max, ratio, quality: agent && typeof used === 'number' ? source === 'sdk' ? 'observed' : 'reported' : 'unavailable' }, pendingPermissions: pending, attention, ...(attentionWhy ? { attentionWhy } : {}), compaction: { count: Array.isArray(timeline) ? compactions.length : 'unknown', status: !Array.isArray(timeline) ? 'unavailable' : !compactions.length ? 'none' : lastCompaction?.status === 'loading' ? 'loading' : 'completed', ...(setting(lastCompaction?.timestamp ?? lastCompaction?.createdAt) ? { lastAt: String(lastCompaction?.timestamp ?? lastCompaction?.createdAt) } : {}) }, cache: { ...(cacheInfo.activityAt ? { activityAt: cacheInfo.activityAt } : {}), ageMinutes: cacheInfo.ageMinutes ?? 'unknown', state: cacheInfo.state }, burn, ...(observedAt ? { lastObservedAt: observedAt } : {}), freshness, health, requested, observed, mismatch }, children: await this.children(externalId, this.adapterFor(session)), workSummary: await this.workSummary(session.workspace) };
  }
  /** The one read-only fact bundle the temporal projection consumes. Panorama
   * and the reconcile preview must see identical facts, so they share it. */
  private temporalFacts(workspaceId: string, state: ReturnType<StateStore['snapshot']>, sessions: RuntimeSession[]): TemporalProjectionFacts {
    const owned = <T extends { workspaceId?: string }>(items: readonly T[]) => items.filter((item) => item.workspaceId === workspaceId);
    return { channelEvents: owned(state.channelEvents), deliveries: state.deliveries, tasks: owned(state.tasks), results: owned(state.results), sessions, members: owned(state.members), goals: owned(state.goals), knowledge: owned(state.knowledge), nowMs: Date.now() };
  }
  async panorama(workspaceId: string, refresh = false, temporalFilter: TemporalFilter = 'active') {
    const context = this.context(workspaceId); const state = this.store.snapshot(); const sessions = state.sessions.filter((item) => item.workspaceId === workspaceId); const runtime = await Promise.all(sessions.map((item) => this.runtimeStatus(item.id, refresh)));
    const goals = state.goals.filter((goal) => sessions.some((session) => session.goalId === goal.id));
    const placement = (context.workspace.paseoPlacements ?? []).map((item) => ({ controlWorkspaceId: workspaceId, projectId: item.projectId, workspaceId: item.workspaceId, checkout: item.checkout, tabs: sessions.filter((session) => session.placement?.requested.workspaceId === item.workspaceId).map((session) => ({ runtimeId: session.id, agentId: session.externalId, role: state.members.find((member) => member.id === session.memberId)?.role, goalId: session.goalId, goal: goals.find((goal) => goal.id === session.goalId)?.title, cwd: session.workspace, model: session.model, mode: session.mode, thinking: session.thinking })) }));
    const temporal = projectTemporal(this.temporalFacts(workspaceId, state, sessions), temporalFilter);
    const budgets = this.providerBudgetSnapshot ? { snapshot: this.providerBudgetSnapshot, source: this.providerBudgetSnapshot.source, admissions: [...new Map(sessions.map((session) => { const key = `${session.provider}:${session.model}`; return [key, evaluateAdmission({ envelope: this.providerBudgetSnapshot, bindings: this.providerBudgetConfig.bindings ?? [], policies: this.providerBudgetConfig.policies ?? [], providerId: session.provider, model: session.model, activeRuntimeCount: sessions.filter((other) => other.provider === session.provider && other.state !== 'terminal').length })] as const; })).values()] } : { status: 'source_unavailable' as const };
    const surfaceIds = new Set([...context.tasks.map((task) => task.executionSurfaceId), ...sessions.map((session) => session.executionSurfaceId)].filter((id): id is string => Boolean(id)));
    const surfaces = state.executionSurfaces.filter((surface) => surfaceIds.has(surface.id));
    const execution = {
      repositories: [...new Map(surfaces.map((surface) => [surface.repositoryId, { id: surface.repositoryId, checkout: surface.checkout.path }])).values()],
      surfaces,
      claims: state.surfaceClaims.filter((claim) => surfaceIds.has(claim.executionSurfaceId)),
      bindings: state.runtimeBindings.filter((binding) => surfaceIds.has(binding.executionSurfaceId)),
    };
    const cooperation = { scope: context.workspace, goals, tasks: context.tasks, members: context.roster, results: context.results, knowledge: context.knowledge, events: context.events };
    return { ...context, goals, runtime, placement, cooperation, execution, blocked: this.blockedRuntimes(workspaceId), providerBudget: budgets, latestKnowledgeRef: context.knowledge.at(-1)?.id, latestResultRef: context.results.at(-1)?.id, temporal };
  }
  temporalReconciliation(workspaceId: string) {
    const state = this.store.snapshot(); const sessions = state.sessions.filter((item) => item.workspaceId === workspaceId);
    return temporalReconciliationPreview(this.temporalFacts(workspaceId, state, sessions));
  }
  state() { return this.store.snapshot(); }
}

export class ArcpError extends Error { constructor(readonly code: string, message: string, readonly field?: string) { super(message); } }
