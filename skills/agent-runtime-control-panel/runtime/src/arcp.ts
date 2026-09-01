import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaseoCli, asRecord } from './cli.js';
import { CompanionService } from './service.js';
import type { MessageRecord } from './types.js';
import { createPaseoClient } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';
import { HermesAcpAdapter, type SafePointEvent } from './hermes-acp.js';
import { SQLiteStateStore, type StateStore } from './state-store.js';
export type { StateStore } from './state-store.js';

export type GoalState = 'active' | 'completed' | 'cancelled';
export type SessionState = 'launching' | 'running' | 'idle' | 'terminal' | 'attention' | 'transport_indeterminate';
export type DeliveryState = 'queued' | 'held' | 'waiting_safe_point' | 'attempting' | 'delivered' | 'running' | 'processed' | 'acknowledged' | 'transport_indeterminate' | 'withdrawn';

export interface Actor { id: string; clientIdentity: string; label: string; createdAt: string; }
export interface ActorBinding { id: string; actorId: string; channel: 'hermes' | 'local'; profileRef?: string; conversationRef?: string; generation: number; createdAt: string; }
export interface Goal { id: string; actorId: string; title: string; workspaceId?: string; state: GoalState; createdAt: string; updatedAt: string; }
export type ChannelEventKind = 'decision_required' | 'decision_resolved' | 'task_claimed' | 'task_candidate' | 'task_completed' | 'task_failed' | 'task_unknown' | 'phase_progress' | 'phase_completed' | 'blocker' | 'finding' | 'permission' | 'attention' | 'runtime_health' | 'transport_uncertainty' | 'material_progress';
export interface ChannelEventContent { summary: string; evidenceRefs: string[]; contentHash: string; sensitivity: 'normal' | 'sensitive'; retention: 'standard' | 'bounded'; }
export interface ChannelTransition { state: 'queued' | 'delivered' | 'processed' | 'acknowledged' | 'transport_indeterminate' | 'undeliverable' | 'withdrawn'; at: string; }
export interface ChannelEvent { id: string; workspaceId?: string; goalId?: string; taskId?: string; resultId?: string; sourceMemberId?: string; sourceActorId?: string; targetMemberId?: string; targetActorId?: string; targetRole?: string; targetSubscription?: string; kind: ChannelEventKind; urgency: 'normal' | 'urgent'; decisionRequired: boolean; content: ChannelEventContent; deliveryState: ChannelTransition['state']; transitions: ChannelTransition[]; createdAt: string; deliveredAt?: string; processedAt?: string; acknowledgedAt?: string; undeliverableReason?: string; relatedEventId?: string; }
type ChannelEventInput = { id?: string; workspaceId?: string; goalId?: string; taskId?: string; resultId?: string; sourceMemberId?: string; sourceActorId?: string; targetMemberId?: string; targetActorId?: string; targetRole?: string; targetSubscription?: string; kind: ChannelEventKind; urgency: 'normal' | 'urgent'; decisionRequired: boolean; summary: string; evidenceRefs: string[]; relatedEventId?: string; notify?: boolean };
export interface RuntimeLaunchContext { workspaceId?: string; taskId?: string; memberId?: string; runtimeId?: string; memberCredential?: string; clientStatePath?: string; }
export interface RuntimeSession { id: string; actorId: string; goalId: string; taskId?: string; bindingId: string; generation: number; runtimeKind: 'paseo' | 'external'; adapterId: string; workspaceId?: string; memberId?: string; profileId: string; provider: string; model: string; mode?: string; thinking?: string; observed?: Partial<RuntimeSettings>; workspace?: string; externalId?: string; acpSessionId?: string; pid?: number; lastDeliveryId?: string; lastTurnState?: string; state: SessionState; lastObservedAt?: string; createdAt: string; }
export interface Delivery { id: string; fromActorId: string; runtimeSessionId: string; generation: number; body: string; command: 'normal' | 'interrupt'; reason?: string; eventId?: string; state: DeliveryState; createdAt: string; sourceMessageId?: string; cacheAuthorized?: true; safePointObservedAt?: string; safePointStatus?: string; attemptedAt?: string; deliveredAt?: string; processedAt?: string; acknowledgedAt?: string; }
export interface ControlWorkspace { id: string; purpose: string; lifecycle: 'active' | 'completed' | 'cancelled'; ownerActorId: string; ownerMemberId?: string; createdAt: string; updatedAt: string; }
export interface Member { id: string; workspaceId: string; actorId?: string; joinKind: 'managed' | 'native'; label: string; role: string; capabilities: string[]; lifecycle: 'invited' | 'joining' | 'active' | 'idle' | 'busy' | 'attention' | 'offline' | 'retired'; leaseExpiresAt?: string; lastHeartbeatAt?: string; createdAt: string; updatedAt: string; }
export interface Task { id: string; workspaceId: string; title: string; lifecycle: 'proposed' | 'ready' | 'claimed' | 'running' | 'waiting' | 'candidate' | 'completed' | 'failed' | 'unknown' | 'cancelled'; ownerMemberId?: string; fence: number; createdAt: string; updatedAt: string; }
export interface KnowledgeEntry { id: string; workspaceId: string; authorMemberId: string; kind: 'problem' | 'learning' | 'decision' | 'evidence' | 'runbook' | 'blocker'; text: string; tags: string[]; taskId?: string; goalId?: string; createdAt: string; }
export interface Result { id: string; workspaceId: string; taskId: string; memberId: string; fence: number; status: 'candidate' | 'failed' | 'unknown'; summary: string; evidenceRefs: string[]; sourceId?: string; createdAt: string; }
export interface RuntimeSettings { provider: string; model: string; mode?: string; thinking?: string; }
export interface ActionResult { action: 'launch' | 'hold' | 'warn'; launchable: boolean; why: string; requested: RuntimeSettings; effective: RuntimeSettings; profileId: string; recommendedCommands: string[]; liveModes: string[]; }
export interface RuntimeObservation { status: SessionState; activeTurn: boolean | 'unknown'; usage: { input: number | 'unknown'; cached: number | 'unknown'; output: number | 'unknown' }; context: { used: number | 'unknown'; max: number | 'unknown'; ratio: number | 'unknown'; quality: 'observed' | 'reported' | 'estimated' | 'unavailable' }; pendingPermissions: number | 'unknown'; attention: boolean | 'unknown'; attentionWhy?: string; compaction: { count: number | 'unknown'; status: 'completed' | 'loading' | 'none' | 'unavailable'; lastAt?: string }; cache: { activityAt?: string; ageMinutes: number | 'unknown'; state: 'fresh' | 'expiring' | 'expired' | 'unknown' }; lastObservedAt?: string; freshness: 'fresh' | 'stale' | 'unavailable' | 'unknown'; health: 'healthy' | 'degraded' | 'attention' | 'unavailable' | 'unknown'; requested: RuntimeSettings; observed: Partial<RuntimeSettings>; mismatch: boolean; }
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
export interface LegacySummary { reminders: Record<string, number>; messages: Record<string, number>; trackedChildren: { total: number; statuses: Record<string, number> }; openCorrectionInstances: number; blockedGateCount: number; }
interface Confirmation { tokenHash: string; kind: 'interrupt' | 'cache'; actorId: string; runtimeSessionId: string; generation: number; reason?: string; activeTurn: string; childSet: string; activityAt?: string; expiresAt: string; }
export interface State { actors: Actor[]; bindings: ActorBinding[]; credentials: Record<string, string>; workspaces: ControlWorkspace[]; members: Member[]; memberCredentials: Record<string, string>; tasks: Task[]; knowledge: KnowledgeEntry[]; results: Result[]; goals: Goal[]; sessions: RuntimeSession[]; deliveries: Delivery[]; channelEvents: ChannelEvent[]; confirmations: Confirmation[]; }

const empty = (): State => ({ actors: [], bindings: [], credentials: {}, workspaces: [], members: [], memberCredentials: {}, tasks: [], knowledge: [], results: [], goals: [], sessions: [], deliveries: [], channelEvents: [], confirmations: [] });
export const CLAUDE_CACHE_DEFAULTS = { expiringMinutes: 55, expiredMinutes: 60 } as const;
const idFor = (prefix: string, value: string) => `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
const now = () => new Date().toISOString();

/** A compact, independently durable ARCP state file. It intentionally stores public IDs and
 * metadata only: provider handles, prompts, credentials, and host paths never enter it. */
export class ArcpStore implements StateStore {
  private state: State = empty();
  private write = Promise.resolve();
  readonly file: string;
  constructor(dir: string) { this.file = path.join(dir, 'arcp-state.json'); }
  async init(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<State>;
      const legacyEvents = ((parsed as any).channelEvents ?? []) as Array<Record<string, any>>; const channelEvents = legacyEvents.map((item) => item.content ? item as ChannelEvent : migrateLegacyChannelEvent(item));
      this.state = { actors: parsed.actors ?? [], bindings: parsed.bindings ?? [], credentials: parsed.credentials ?? {}, workspaces: parsed.workspaces ?? [], members: parsed.members ?? [], memberCredentials: parsed.memberCredentials ?? {}, tasks: parsed.tasks ?? [], knowledge: parsed.knowledge ?? [], results: parsed.results ?? [], goals: parsed.goals ?? [], sessions: (parsed.sessions ?? []).map((item) => ({ ...item, runtimeKind: item.runtimeKind ?? 'paseo', adapterId: item.adapterId ?? 'paseo' })), deliveries: parsed.deliveries ?? [], channelEvents, confirmations: parsed.confirmations ?? [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('ARCP durable state is unreadable');
    }
  }
  snapshot(): State { return structuredClone(this.state); }
  async mutate<T>(fn: (state: State) => T): Promise<T> {
    const result = fn(this.state);
    const next = this.write.catch(() => undefined).then(async () => {
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 });
      await rename(temp, this.file);
    });
    this.write = next;
    await next;
    return result;
  }
  /** Keep durable transport history bounded; actionable rows are retained up
   * to the same cap so a permanently held legacy source cannot grow forever. */
  async prune(maxRows = 200): Promise<void> {
    await this.mutate((state) => {
      const deliveries = [...state.deliveries].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const keep = new Set(deliveries.slice(0, maxRows).map((item) => item.id));
      const removedEvents = new Set(deliveries.slice(maxRows).map((item) => item.eventId).filter((id): id is string => Boolean(id)));
      state.deliveries = deliveries.filter((item) => keep.has(item.id));
      state.channelEvents = state.channelEvents.filter((event) => !removedEvents.has(event.id));
    });
  }
}

export const DEFAULT_PROFILES = [
  { id: 'claude-manager', provider: 'claude', model: 'claude-opus-5', mode: 'auto', thinking: 'medium', role: 'manager' },
  { id: 'claude-bypass-permissions', provider: 'claude', model: 'claude-opus-5', mode: 'bypassPermissions', thinking: 'medium', role: 'manager' },
  { id: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', mode: 'auto', thinking: 'medium', role: 'worker' },
  { id: 'codex-full-access', provider: 'codex', model: 'gpt-5.6-terra', mode: 'full-access', thinking: 'medium', role: 'worker' },
  { id: 'pi-grok-worker', provider: 'pi', model: 'grok-cli/grok-4.6', role: 'worker' },
] as const;

function normalized(value: unknown): string { return String(value ?? '').toLowerCase(); }
function capabilityText(value: unknown): string { return String(JSON.stringify(value ?? '')).toLowerCase(); }
function capabilityToken(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function sessionState(value: unknown): SessionState {
  const state = normalized(value);
  if (!state || state === 'unknown') return 'transport_indeterminate';
  if (['completed', 'failed', 'stopped', 'cancelled', 'archived', 'terminal'].includes(state)) return 'terminal';
  if (state === 'idle') return 'idle';
  return 'running';
}
function normalizedTurnState(value: unknown): 'running' | 'requires_action' | 'idle' {
  const state = normalized(value);
  if (state.includes('permission') || state.includes('requires_action') || state.includes('attention') || state.includes('error')) return 'requires_action';
  if (state.includes('run') || state.includes('active') || state.includes('progress') || state.includes('turn_start') || state.includes('prompt_start')) return 'running';
  return 'idle';
}
const setting = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const sameSetting = (a: unknown, b: unknown) => !a || !b ? false : capabilityToken(String(a)) === capabilityToken(String(b));
const safeModeRank = (value: unknown) => {
  const mode = capabilityToken(String(value ?? ''));
  if (['plan', 'readonly', 'read', 'ask'].includes(mode)) return 0;
  if (mode === 'auto') return 1;
  if (['fullaccess', 'bypasspermissions'].includes(mode)) return 2;
  return 1;
};
const safeJson = (value: unknown): Record<string, any> => asRecord(value);
async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
function migrateLegacyChannelEvent(item: Record<string, any>): ChannelEvent {
  const summary = String(item.summary ?? ''); const evidenceRefs = Array.isArray(item.evidenceRefs) ? item.evidenceRefs.map(String) : []; const { summary: _summary, evidenceRefs: _evidenceRefs, content: _content, transitions: _transitions, ...envelope } = item;
  const at = item.createdAt ?? item.deliveredAt ?? item.processedAt ?? item.acknowledgedAt ?? '1970-01-01T00:00:00.000Z'; const transitions: ChannelTransition[] = [{ state: 'queued', at }];
  for (const [state, timestamp] of [['delivered', item.deliveredAt], ['processed', item.processedAt], ['acknowledged', item.acknowledgedAt]] as const) if (typeof timestamp === 'string') transitions.push({ state, at: timestamp });
  const final = item.deliveryState; if (final === 'transport_indeterminate' && !transitions.some((entry) => entry.state === final)) transitions.push({ state: final, at: item.transportUncertainAt ?? at });
  const contentHash = createHash('sha256').update(JSON.stringify({ summary, evidenceRefs })).digest('hex'); return { ...envelope, content: { summary, evidenceRefs, contentHash, sensitivity: 'normal', retention: 'standard' }, deliveryState: transitions.at(-1)!.state, transitions, createdAt: item.createdAt ?? at } as ChannelEvent;
}

/** The V1 first-class runtime adapter. Provider choices stay in validated profiles;
 * this adapter owns only safe Paseo transport/discovery calls and never exposes native handles. */
type PaseoModeClient = { connect(): Promise<void>; close(): Promise<void>; providers: { listModes(provider: string): Promise<unknown> } };

export class PaseoAdapter implements RuntimeAdapter {
  readonly adapterId = 'paseo';
  constructor(private readonly cli: PaseoCli, private readonly modeClientFactory?: () => PaseoModeClient) {}
  discover() { return this.cli.run(['provider', 'ls', '--json'], { timeoutMs: 5_000 }); }
  models(provider: string) { return this.cli.run(['provider', 'models', provider, '--json'], { timeoutMs: 5_000 }); }
  launch(profile: Profile, goalTitle: string, workspace?: string, context?: RuntimeLaunchContext) {
    const handoff = context?.workspaceId && context.taskId && context.runtimeId
      ? `\n\nARCP Worker handoff: workspace ${context.workspaceId}, task ${context.taskId}, runtime ${context.runtimeId}. Claim with \`arcp task claim ${context.taskId} --runtime ${context.runtimeId} --expected-fence 0\`. Report durable learning with \`arcp knowledge add ${context.workspaceId} --runtime ${context.runtimeId} --kind learning --text '<learning>'\` and submit the candidate with \`arcp result submit ${context.workspaceId} --runtime ${context.runtimeId} --task ${context.taskId} --summary '<summary>' --expected-fence 1\`.`
      : '';
    return this.cli.run(['run', '-d', '--json', '--provider', profile.provider, '--model', profile.model, ...(profile.mode ? ['--mode', profile.mode] : []), ...(profile.thinking ? ['--thinking', profile.thinking] : []), ...(workspace ? ['--cwd', workspace] : []), ...(context?.clientStatePath ? ['--env', `ARCP_CLIENT_STATE=${context.clientStatePath}`] : []), `Work on ARCP Goal: ${goalTitle}${handoff}`], { timeoutMs: 30_000 });
  }
  observe(externalId: string) { return this.cli.run(['inspect', externalId, '--json'], { timeoutMs: 5_000 }); }
  registry() { return this.cli.run(['ls', '-g', '--json'], { timeoutMs: 5_000 }); }
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
export type LaunchInput = { profileId?: string; provider?: string; model?: string; mode?: string; thinking?: string; role?: string; unattended?: boolean };

export class ArcpService {
  readonly store: StateStore;
  readonly adapter: RuntimeAdapter;
  private readonly adapters = new Map<string, RuntimeAdapter>();
  private profileData: Profile[] = [...DEFAULT_PROFILES];
  private pumpTimer?: NodeJS.Timeout;
  private pumping?: Promise<void>;
  private pumpAgain = false;
  constructor(readonly companion: CompanionService, readonly cli = new PaseoCli(), store?: StateStore, modeClientFactory?: () => PaseoModeClient, adapters: RuntimeAdapter[] = []) { this.store = store ?? (process.env.ARCP_STATE_STORE === 'sqlite' ? new SQLiteStateStore(companion.store.dir) : new ArcpStore(companion.store.dir)); this.adapter = new PaseoAdapter(cli, modeClientFactory); this.registerAdapter(this.adapter); this.registerAdapter(new HermesAcpAdapter()); for (const adapter of adapters) this.registerAdapter(adapter); }
  registerAdapter(adapter: RuntimeAdapter): void {
    this.adapters.set(adapter.adapterId, adapter);
    const onSafePoint = (adapter as RuntimeAdapter & { onSafePoint?: (listener: (event: SafePointEvent) => void) => () => void }).onSafePoint;
    if (onSafePoint) onSafePoint.call(adapter, () => { void this.pump(); });
    const onFact = (adapter as RuntimeAdapter & { onFact?: (listener: (fact: { externalId: string; kind: ChannelEventKind; urgency: 'normal' | 'urgent'; summary: string; sampleBucket?: number }) => void) => () => void }).onFact;
    if (onFact) onFact.call(adapter, (fact) => { const session = this.store.snapshot().sessions.find((item) => item.externalId === fact.externalId); if (session) void this.publishChannelEvent({ ...(fact.sampleBucket !== undefined ? { id: idFor('event', `observation:${fact.externalId}:${fact.kind}:${fact.sampleBucket}:${session.workspaceId ?? ''}:${session.goalId}:${session.taskId ?? ''}:${session.memberId ?? ''}`) } : {}), workspaceId: session.workspaceId, goalId: session.goalId, taskId: session.taskId, sourceMemberId: session.memberId, sourceActorId: session.actorId, targetRole: 'manager', kind: fact.kind, urgency: fact.urgency, decisionRequired: fact.kind === 'permission' || fact.kind === 'attention', summary: fact.summary, evidenceRefs: [] }).catch(() => undefined); });
    const onResult = (adapter as RuntimeAdapter & { onResult?: (listener: (fact: { externalId: string; taskId: string; status: Result['status']; summary: string; evidenceRefs?: string[]; expectedFence?: number; sourceId: string }) => void) => () => void }).onResult;
    if (onResult) onResult.call(adapter, (fact) => { const session = this.store.snapshot().sessions.find((item) => item.externalId === fact.externalId); if (session?.memberId && fact.expectedFence !== undefined) void this.submitResult({ workspaceId: session.workspaceId!, taskId: fact.taskId, memberId: session.memberId, status: fact.status, summary: fact.summary, evidenceRefs: fact.evidenceRefs, expectedFence: fact.expectedFence, sourceId: fact.sourceId }).catch(() => undefined); });
  }
  private adapterFor(session: RuntimeSession): RuntimeAdapter { return this.adapters.get(session.adapterId || (session.runtimeKind === 'external' ? 'hermes-acp' : 'paseo')) ?? this.adapter; }
  private channelFor(session: RuntimeSession): RuntimeAdapter { return this.adapters.get(session.adapterId || (session.runtimeKind === 'external' ? 'hermes-acp' : 'paseo')) ?? this.adapter; }
  private async prepareRuntimeClientState(sessionId: string, workspaceId: string, memberId: string, credential: string): Promise<string> {
    const root = path.join(path.dirname(this.store.file), 'runtime-members'); const file = path.join(root, `${sessionId}.json`);
    await mkdir(root, { recursive: true }); await writeFile(file, JSON.stringify({ workspaceId, memberId, runtimeMemberCredentials: { [sessionId]: credential } }) + '\n', { mode: 0o600 }); return file;
  }
  async init(): Promise<void> {
    await this.store.init();
    if ('prune' in this.store && typeof (this.store as any).prune === 'function') await (this.store as any).prune();
    try {
      const configPath = process.env.ARCP_CONFIG ?? fileURLToPath(new URL('../../config/default.json', import.meta.url));
      const config = JSON.parse(await readFile(configPath, 'utf8')) as { profiles?: Profile[] };
      if (Array.isArray(config.profiles) && config.profiles.every((item) => item?.id && item.provider && item.model && item.role)) this.profileData = config.profiles;
    } catch { /* fallback is intentional for a packaged skill with no local override */ }
    this.pumpTimer = setInterval(() => { void this.pump(); }, 2_000); this.pumpTimer.unref();
    void this.pump();
  }
  close(): void { if (this.pumpTimer) clearInterval(this.pumpTimer); }
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
  async startManaged(input: LaunchInput & { actorId: string; workspaceId: string; title: string; paseoWorkspaceRef?: string }): Promise<ActionResult | { goal: Goal; task: Task; member: Member; session: RuntimeSession; credential: string }> {
    const state = this.store.snapshot(); if (!state.workspaces.some((item) => item.id === input.workspaceId && item.lifecycle === 'active')) throw new ArcpError('workspace_closed', 'team workspace is unavailable');
    const preflight = await this.preflight(input);
    if (!preflight.launchable) return preflight;
    const goal = await this.createGoal({ actorId: input.actorId, title: input.title, workspaceId: input.workspaceId });
    const task = await this.createTask({ workspaceId: input.workspaceId, title: input.title });
    const profile = this.profileData.find((item) => item.id === preflight.profileId);
    const joined = await this.joinWorkspace({ workspaceId: input.workspaceId, label: `managed-${preflight.profileId}`, role: input.role?.trim() || profile?.role || 'worker', joinKind: 'managed', actorId: input.actorId });
    if (!joined.credential) throw new ArcpError('internal_error', 'managed member credential was not issued');
    const runtimeId = `runtime_${randomUUID()}`; const clientStatePath = await this.prepareRuntimeClientState(runtimeId, input.workspaceId, joined.member.id, joined.credential);
    const session = await this.launch({ ...input, actorId: input.actorId, goalId: goal.id, workspace: input.paseoWorkspaceRef, workspaceId: input.workspaceId, memberId: joined.member.id, taskId: task.id, runtimeId, memberCredential: joined.credential, clientStatePath } as LaunchInput & { actorId: string; goalId: string; workspace?: string; workspaceId?: string; memberId?: string; taskId?: string; runtimeId?: string; memberCredential?: string; clientStatePath?: string });
    return { goal, task, member: joined.member, session, credential: joined.credential };
  }
  /** Register one stable sibling Hermes ACP on-call Runtime. This is a new
   * external process sharing ARCP Workspace/Knowledge/Delivery; it does not
   * attach to the operator's Feishu Hermes conversation, which remains Owner. */
  async registerExternal(input: { actorId: string; workspaceId: string; label?: string; role?: string; workspace?: string }): Promise<{ member: Member; session: RuntimeSession; credential?: string }> {
    const state = this.store.snapshot();
    if (!state.workspaces.some((item) => item.id === input.workspaceId && item.lifecycle === 'active')) throw new ArcpError('workspace_closed', 'team workspace is unavailable');
    const label = input.label?.trim() || 'hermes-acp-on-call';
    const prior = state.sessions.find((item) => item.runtimeKind === 'external' && item.adapterId === 'hermes-acp' && item.workspaceId === input.workspaceId && item.memberId && state.members.find((member) => member.id === item.memberId)?.label === label && item.state !== 'terminal');
    if (prior) { const adapter = this.adapters.get('hermes-acp') as RuntimeAdapter & { reconcileExternal?: (externalId: string) => Promise<boolean> } | undefined; if (adapter?.reconcileExternal && !(await adapter.reconcileExternal(prior.externalId ?? ''))) { await this.store.mutate((next) => { next.sessions.find((item) => item.id === prior.id)!.state = 'transport_indeterminate'; }); } const member = state.members.find((item) => item.id === prior.memberId)!; return { member, session: this.store.snapshot().sessions.find((item) => item.id === prior.id)! }; }
    const goal = await this.createGoal({ actorId: input.actorId, title: `External Hermes ACP ${label}`, workspaceId: input.workspaceId });
    const task = await this.createTask({ workspaceId: input.workspaceId, title: `External Hermes ACP ${label}` });
    const joined = await this.joinWorkspace({ workspaceId: input.workspaceId, label, role: input.role?.trim() || 'on-call', joinKind: 'managed', actorId: input.actorId, capabilities: ['claim_task', 'write_knowledge', 'submit_result', 'read_context'] });
    if (!joined.credential) throw new ArcpError('internal_error', 'external member credential was not issued');
    const binding = this.store.snapshot().bindings.find((item) => item.actorId === input.actorId); if (!binding) throw new ArcpError('unknown_recipient', 'actor or binding is not registered');
    const session: RuntimeSession = { id: `runtime_${randomUUID()}`, actorId: input.actorId, goalId: goal.id, taskId: task.id, bindingId: binding.id, generation: 1, runtimeKind: 'external', adapterId: 'hermes-acp', workspaceId: input.workspaceId, memberId: joined.member.id, profileId: 'hermes-acp', provider: 'hermes', model: 'hermes-agent', workspace: input.workspace, state: 'launching', createdAt: now() };
    await this.store.mutate((next) => { next.sessions.push(session); });
    try {
      const clientStatePath = await this.prepareRuntimeClientState(session.id, input.workspaceId, joined.member.id, joined.credential);
      const launched = asRecord((await this.adapters.get('hermes-acp')!.launch({ id: 'hermes-acp', provider: 'hermes', model: 'hermes-agent', role: 'worker' }, goal.title, input.workspace, { workspaceId: input.workspaceId, taskId: task.id, memberId: joined.member.id, runtimeId: session.id, memberCredential: joined.credential, clientStatePath })).value);
      const externalId = String(launched.id ?? launched.sessionId ?? launched.acpSessionId ?? ''); if (!externalId) throw new Error('Hermes ACP did not return a session identity');
      await this.store.mutate((next) => { const item = next.sessions.find((value) => value.id === session.id)!; item.externalId = externalId; item.acpSessionId = String(launched.acpSessionId ?? externalId); item.pid = typeof launched.pid === 'number' ? launched.pid : undefined; item.lastTurnState = 'idle'; item.state = 'idle'; return item; });
    } catch { await this.store.mutate((next) => { next.sessions.find((value) => value.id === session.id)!.state = 'transport_indeterminate'; }); }
    return { member: joined.member, session: this.store.snapshot().sessions.find((item) => item.id === session.id)!, credential: joined.credential };
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
  profiles() { return this.profileData.map((profile) => ({ ...profile, paidModelAutoSelection: false })); }
  async discovery(): Promise<{ available: boolean; profiles: Array<Record<string, unknown>> }> {
    try {
      const providers = (await this.adapter.discover()).value;
      if (!Array.isArray(providers)) throw new Error('provider listing is not an array');
      const profiles = await Promise.all(this.profiles().map(async (profile) => {
        const provider = providers.map(asRecord).find((item) => String(item.provider).toLowerCase() === profile.provider);
        const providerAvailable = normalized(provider?.status) === 'available' && normalized(provider?.enabled) !== 'disabled';
        const modes = (await this.adapter.modes(profile.provider)) ?? this.cliModeIds(provider?.modes);
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
      if (token === 'automode') return 'auto';
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
      const profile = this.profileData.find((item) => item.id === (input.profileId ?? 'codex-worker'));
      if (!profile) throw new ArcpError('invalid_request', 'unknown launch profile');
      return profile;
    }
    if (!input.provider?.trim() || !input.model?.trim()) throw new ArcpError('invalid_request', 'explicit launch requires provider and model');
    if (input.provider === 'pi' && input.mode) throw new ArcpError('invalid_request', 'Pi/Grok has no ARCP mode; omit --mode');
    const mode = setting(input.mode); const thinking = setting(input.thinking);
    return { id: 'explicit', provider: input.provider.trim(), model: input.model.trim(), ...(mode ? { mode } : {}), ...(thinking ? { thinking } : {}), role: 'explicit' };
  }
  async preflight(input: LaunchInput): Promise<ActionResult> {
    const profile = this.requestedProfile(input); const requested: RuntimeSettings = { provider: profile.provider, model: profile.model, ...(profile.mode ? { mode: profile.mode } : {}), ...(profile.thinking ? { thinking: profile.thinking } : {}) };
    const discovered = await this.discovery();
    let live = discovered.profiles.find((item) => item.id === profile.id)?.available === true;
    let liveModes: string[] = [];
    try {
      const providers = (await this.adapter.discover()).value; const provider = Array.isArray(providers) ? providers.map(asRecord).find((item) => normalized(item.provider) === normalized(profile.provider)) : undefined; liveModes = (await this.adapter.modes(profile.provider)) ?? this.cliModeIds(provider?.modes);
      if (profile.id === 'explicit') {
        const models = (await this.adapter.models(profile.provider)).value; const model = Array.isArray(models) ? models.map(asRecord).find((item) => sameSetting(item.id, profile.model)) : undefined;
        live = normalized(provider?.status) === 'available' && normalized(provider?.enabled) !== 'disabled' && Boolean(model) && (!profile.mode || liveModes.some((mode) => sameSetting(mode, profile.mode))) && (!profile.thinking || (Array.isArray(model?.thinkingOptionIds) && model.thinkingOptionIds.some((value: unknown) => sameSetting(value, profile.thinking))));
      }
    } catch { /* discovery receipt remains truthful */ }
    const stronger = profile.provider === 'codex' ? 'full-access' : profile.provider === 'claude' ? 'bypassPermissions' : undefined;
    const elevatedProfile = profile.provider === 'codex' ? 'codex-full-access' : profile.provider === 'claude' ? 'claude-bypass-permissions' : undefined;
    const recommendedCommands = stronger && liveModes.some((mode) => sameSetting(mode, stronger)) ? [`arcp start --profile ${elevatedProfile} --title '<goal>'${input.unattended ? ' --unattended' : ''}`] : [];
    if (!live) return { action: 'hold', launchable: false, why: 'requested provider, model, thinking, or mode is not live-validated', requested, effective: requested, profileId: profile.id, recommendedCommands: profile.mode === 'auto' ? recommendedCommands : [], liveModes };
    const needsElevation = ['claude', 'codex'].includes(profile.provider) && (safeModeRank(profile.mode) < safeModeRank('auto') || Boolean(input.unattended) && safeModeRank(profile.mode) < 2);
    if (needsElevation && recommendedCommands.length) return { action: 'hold', launchable: false, why: input.unattended ? 'unattended work requires an explicit stronger live mode' : 'requested mode is below the provider default auto', requested, effective: requested, profileId: profile.id, recommendedCommands, liveModes };
    if (needsElevation) return { action: 'warn', launchable: true, why: 'requested mode is weaker than auto and no stronger live mode is available; ARCP will not substitute one', requested, effective: requested, profileId: profile.id, recommendedCommands, liveModes };
    return { action: 'launch', launchable: true, why: 'requested settings are live-validated without substitution', requested, effective: requested, profileId: profile.id, recommendedCommands: [], liveModes };
  }
  async launch(input: LaunchInput & { actorId: string; goalId: string; workspace?: string; workspaceId?: string; memberId?: string; taskId?: string; runtimeId?: string; memberCredential?: string; clientStatePath?: string }): Promise<RuntimeSession> {
    const preflight = await this.preflight(input); if (!preflight.launchable) throw new ArcpError(preflight.why.startsWith('requested provider') ? 'profile_unavailable' : 'launch_held', preflight.why);
    const profile = this.requestedProfile(input);
    const state = this.store.snapshot();
    const goal = state.goals.find((item) => item.id === input.goalId && item.actorId === input.actorId);
    const binding = state.bindings.find((item) => item.actorId === input.actorId);
    if (!goal || !binding) throw new ArcpError('unknown_recipient', 'actor or goal is not registered');
    if (input.memberId && !state.members.some((item) => item.id === input.memberId && (!input.workspaceId || item.workspaceId === input.workspaceId))) throw new ArcpError('unknown_recipient', 'managed member is not in workspace');
    if (state.sessions.some((item) => item.goalId === goal.id && item.state !== 'terminal')) {
      throw new ArcpError('goal_held', 'goal already has a primary runtime session');
    }
    const discovered = await this.discovery();
    const available = discovered.profiles.find((item) => item.id === profile.id)?.available;
    if (!available) throw new ArcpError('profile_unavailable', 'requested provider, model, or mode is unavailable');
    const generation = Math.max(0, ...state.sessions.filter((item) => item.goalId === goal.id).map((item) => item.generation)) + 1;
    const session: RuntimeSession = { id: input.runtimeId ?? `runtime_${randomUUID()}`, actorId: input.actorId, goalId: goal.id, ...(input.taskId ? { taskId: input.taskId } : {}), bindingId: binding.id, generation, runtimeKind: 'paseo', adapterId: 'paseo', ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), ...(input.memberId ? { memberId: input.memberId } : {}), profileId: profile.id, provider: profile.provider, model: profile.model, ...(profile.mode ? { mode: profile.mode } : {}), ...(profile.thinking ? { thinking: profile.thinking } : {}), workspace: input.workspace, state: 'launching', createdAt: now() };
    await this.store.mutate((next) => { next.sessions.push(session); });
    try {
      const result = asRecord((await this.adapter.launch(profile, goal.title, input.workspace, { workspaceId: input.workspaceId, taskId: input.taskId, memberId: input.memberId, runtimeId: session.id, memberCredential: input.memberCredential, clientStatePath: input.clientStatePath })).value);
      const externalId = String(result.id ?? result.agentId ?? '');
      if (!externalId) throw new Error('Paseo did not return a runtime identity');
      // Persist the opaque handle before postflight: reconcile must remain possible
      // when launch succeeded but the immediate observation timed out.
      await this.store.mutate((next) => { next.sessions.find((item) => item.id === session.id)!.externalId = externalId; });
      const snapshot = await this.channelFor(session).snapshot(externalId); const inspected = snapshot.agent;
      const observed = [inspected.provider ?? inspected.Provider, inspected.model ?? inspected.Model, inspected.currentModeId ?? inspected.mode ?? inspected.Mode, inspected.effectiveThinkingOptionId ?? inspected.thinkingOptionId ?? inspected.thinking ?? inspected.Thinking];
      const expected = [profile.provider, profile.model, profile.mode, profile.thinking];
      const matchesPlan = expected.every((expectedValue, index) => !expectedValue || (typeof observed[index] === 'string' && capabilityToken(String(observed[index])) === capabilityToken(expectedValue)));
      return this.store.mutate((next) => { const stored = next.sessions.find((item) => item.id === session.id)!; stored.observed = { ...(setting(observed[0]) ? { provider: String(observed[0]) } : {}), ...(setting(observed[1]) ? { model: String(observed[1]) } : {}), ...(setting(observed[2]) ? { mode: String(observed[2]) } : {}), ...(setting(observed[3]) ? { thinking: String(observed[3]) } : {}) }; stored.state = matchesPlan ? sessionState(inspected.status ?? inspected.Status) : 'attention'; stored.lastObservedAt = now(); return stored; });
    } catch {
      return this.store.mutate((next) => { const stored = next.sessions.find((item) => item.id === session.id)!; stored.state = 'transport_indeterminate'; return stored; });
    }
  }
  async observe(id: string): Promise<RuntimeSession> {
    const prior = this.store.snapshot().sessions.find((item) => item.id === id);
    if (!prior) throw new ArcpError('not_found', 'runtime session not found');
    if (!prior.externalId) return prior;
    try {
      const snapshot = await this.channelFor(prior).snapshot(prior.externalId); const observed = snapshot.agent;
      const updated = await this.store.mutate((state) => {
        const item = state.sessions.find((value) => value.id === id)!;
        item.observed = { ...(setting(observed.provider ?? observed.Provider) ? { provider: String(observed.provider ?? observed.Provider) } : {}), ...(setting(observed.model ?? observed.Model) ? { model: String(observed.model ?? observed.Model) } : {}), ...(setting(observed.currentModeId ?? observed.mode ?? observed.Mode) ? { mode: String(observed.currentModeId ?? observed.mode ?? observed.Mode) } : {}), ...(setting(observed.effectiveThinkingOptionId ?? observed.thinkingOptionId ?? observed.thinking ?? observed.Thinking) ? { thinking: String(observed.effectiveThinkingOptionId ?? observed.thinkingOptionId ?? observed.thinking ?? observed.Thinking) } : {}) };
        if (setting(observed.lastDeliveryId)) item.lastDeliveryId = String(observed.lastDeliveryId);
        if (setting(observed.lastTurnState)) item.lastTurnState = normalizedTurnState(observed.lastTurnState);
        const requested = [item.provider, item.model, item.mode, item.thinking]; const actual = [item.observed.provider, item.observed.model, item.observed.mode, item.observed.thinking];
        item.state = requested.every((value, index) => !value || sameSetting(value, actual[index])) ? sessionState(observed.status ?? observed.Status) : 'attention'; item.lastObservedAt = now();
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
    try {
      if (prior.runtimeKind === 'external') {
        const adapter = this.adapterFor(prior) as RuntimeAdapter & { reconcileExternal?: (externalId: string) => Promise<boolean> };
        const valid = adapter.reconcileExternal ? await adapter.reconcileExternal(prior.externalId ?? '') : false;
        if (!valid) { const uncertain = await this.store.mutate((state) => { const item = state.sessions.find((value) => value.id === id)!; item.state = 'transport_indeterminate'; return item; }); await this.emitTransportUncertainty(uncertain); return uncertain; }
      }
      const agents = (await this.channelFor(prior).registry()).value;
      const match = Array.isArray(agents) ? agents.map(asRecord).find((item) => String(item.id ?? item.agentId) === prior.externalId) : undefined;
      if (!match) { const uncertain = await this.store.mutate((state) => { const item = state.sessions.find((value) => value.id === id)!; item.state = 'transport_indeterminate'; return item; }); await this.emitTransportUncertainty(uncertain); return uncertain; }
      return this.store.mutate((state) => { const item = state.sessions.find((value) => value.id === id)!; item.state = sessionState(match.status ?? match.Status); item.lastObservedAt = now(); return item; });
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
    if (!session.externalId) throw new ArcpError('unknown_recipient', 'recipient is not registered');
    const adapter = this.channelFor(session); const snapshot = await adapter.snapshot(session.externalId); const children = await this.children(session.externalId, adapter); const turn = safeJson(snapshot.agent.activeTurn);
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
  async interrupt(input: { fromActorId: string; runtimeSessionId: string; body: string; reason: string; confirmation?: string; sourceMessageId?: string }): Promise<Delivery | Record<string, unknown>> {
    if (!input.reason?.trim() || !input.body?.trim()) throw new ArcpError('invalid_request', 'interrupt reason and body are required');
    const session = this.store.snapshot().sessions.find((item) => item.id === input.runtimeSessionId); if (!session || !session.externalId || !this.store.snapshot().actors.some((item) => item.id === input.fromActorId)) throw new ArcpError('unknown_recipient', 'recipient is not registered');
    if (session.provider === 'claude') {
      const facts = await this.facts(session);
      if (!input.confirmation || !(await this.validateConfirmation('interrupt', input.confirmation, session, { actorId: input.fromActorId, reason: input.reason.trim() }, facts))) {
        return this.confirmationReceipt('interrupt', session, { actorId: input.fromActorId, reason: input.reason.trim() }, facts, input.confirmation ? 'Claude interrupt confirmation is stale; no interrupt was sent' : 'Claude interrupt requires confirmation; no interrupt was sent');
      }
    }
    const deliveryId = input.sourceMessageId ? idFor('delivery', `companion:${input.sourceMessageId}:${session.id}`) : `delivery_${randomUUID()}`;
    const event = await this.publishChannelEvent({ id: input.sourceMessageId ? idFor('event', `delivery:${input.sourceMessageId}:${session.id}`) : undefined, workspaceId: session.workspaceId, goalId: session.goalId, sourceActorId: input.fromActorId, targetActorId: session.actorId, kind: 'attention', urgency: 'urgent', decisionRequired: false, summary: `Channel interrupt ${deliveryId} queued`, evidenceRefs: [], notify: false });
    const delivery: Delivery = { id: deliveryId, fromActorId: input.fromActorId, runtimeSessionId: session.id, generation: session.generation, body: input.body.trim(), command: 'interrupt', reason: input.reason.trim(), eventId: event.id, ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}), state: 'queued', createdAt: now() };
    await this.store.mutate((state) => { state.deliveries.push(delivery); });
    try { await this.channelFor(session).interrupt(session.externalId, delivery.body); return this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id)!; const event = item.eventId ? state.channelEvents.find((value) => value.id === item.eventId) : undefined; item.state = 'delivered'; item.deliveredAt = now(); if (event) this.transitionEvent(event, 'delivered', item.deliveredAt); return item; }); }
    catch { return this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id)!; const event = item.eventId ? state.channelEvents.find((value) => value.id === item.eventId) : undefined; item.state = 'transport_indeterminate'; if (event) this.transitionEvent(event, 'transport_indeterminate'); return item; }); }
  }
  async deliver(input: { fromActorId: string; runtimeSessionId: string; body: string; command?: 'normal' | 'interrupt'; reason?: string; cacheConfirmation?: string; sourceMessageId?: string }): Promise<Delivery | Record<string, unknown>> {
    if (!input.body?.trim()) throw new ArcpError('invalid_request', 'body is required');
    const snapshot = this.store.snapshot(); const session = snapshot.sessions.find((item) => item.id === input.runtimeSessionId);
    if (!snapshot.actors.some((item) => item.id === input.fromActorId) || !session || !session.externalId) throw new ArcpError('unknown_recipient', 'recipient is not registered');
    const command = input.command ?? 'normal';
    if (!['normal', 'interrupt'].includes(command)) throw new ArcpError('invalid_request', 'command must be normal or interrupt');
    const existing = input.sourceMessageId ? snapshot.deliveries.find((item) => item.sourceMessageId === input.sourceMessageId && item.runtimeSessionId === session.id) : undefined;
    if (existing) {
      // A completed source message is terminal: a concurrent reconcile may
      // have rendered a different coalesced batch, but must not resend it.
      if (existing.body !== input.body.trim() && ['delivered', 'running', 'processed', 'acknowledged'].includes(existing.state)) return existing;
      if (existing.body !== input.body.trim() || existing.command !== command || existing.generation !== session.generation || existing.fromActorId !== input.fromActorId) throw new ArcpError('invalid_request', 'companion delivery identity conflicts with its durable payload');
      return existing;
    }
    if (command === 'interrupt') return this.interrupt({ fromActorId: input.fromActorId, runtimeSessionId: input.runtimeSessionId, body: input.body, reason: input.reason ?? '', confirmation: input.cacheConfirmation, sourceMessageId: input.sourceMessageId });
    const cache = await this.cacheGuard(session, input.fromActorId, input.cacheConfirmation);
    const deliveryId = input.sourceMessageId ? idFor('delivery', `companion:${input.sourceMessageId}:${session.id}`) : `delivery_${randomUUID()}`;
    const event = await this.publishChannelEvent({ id: input.sourceMessageId ? idFor('event', `delivery:${input.sourceMessageId}:${session.id}`) : undefined, workspaceId: session.workspaceId, goalId: session.goalId, sourceActorId: input.fromActorId, targetActorId: session.actorId, kind: 'material_progress', urgency: 'normal', decisionRequired: false, summary: `Channel delivery ${deliveryId} queued`, evidenceRefs: [], notify: false });
    const held = !('allow' in cache);
    const delivery: Delivery = { id: deliveryId, fromActorId: input.fromActorId, runtimeSessionId: session.id, generation: session.generation, body: input.body.trim(), command, eventId: event.id, ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}), ...('allow' in cache && cache.cacheAuthorized ? { cacheAuthorized: true as const } : {}), ...(input.reason ? { reason: input.reason.trim() } : {}), ...(held ? { reason: cache.why } : {}), state: held ? 'held' : command === 'normal' ? 'waiting_safe_point' : 'queued', createdAt: now() };
    await this.store.mutate((state) => { state.deliveries.push(delivery); });
    if (held) return { ...cache, deliveryId };
    await this.pump(); return this.store.snapshot().deliveries.find((item) => item.id === delivery.id)!;
  }
  async reuse(input: { fromActorId: string; runtimeSessionId: string; body: string; cacheConfirmation?: string }) { return this.deliver({ ...input, command: 'normal' }); }
  /** Companion calls this after persisting its legacy audit record. The target
   * session owner is the server-authenticated sender; untrusted legacy `from`
   * never becomes an ARCP actor.  Normal Companion notifications deliberately
   * use safe-point delivery: legacy urgency may request interrupt, but Claude's
   * separate interrupt confirmation remains in force. */
  async deliverCompanionMessage(message: MessageRecord, prompt: string): Promise<{ deliveryId: string; state: string }> {
    const candidates = this.store.snapshot().sessions.filter((item) => item.externalId === message.to);
    if (candidates.length !== 1) throw new ArcpError('unknown_recipient', candidates.length ? 'ARCP runtime recipient is ambiguous' : 'ARCP runtime recipient is unavailable');
    const session = candidates[0];
    if (session.state === 'terminal') return { deliveryId: idFor('delivery', `companion:${message.id}:${session.id}`), state: 'held_terminal' };
    const requestedInterrupt = message.delivery === 'interrupt' && session.provider !== 'claude';
    const result = await this.deliver({ fromActorId: session.actorId, runtimeSessionId: session.id, body: prompt, command: requestedInterrupt ? 'interrupt' : 'normal', reason: requestedInterrupt ? 'companion urgent delivery' : undefined, sourceMessageId: message.id });
    if (!('id' in result) || !('state' in result)) return { deliveryId: String((result as any).deliveryId ?? idFor('delivery', `companion:${message.id}:${session.id}`)), state: 'held' };
    return { deliveryId: String(result.id), state: String(result.state) };
  }
  isRuntimeRecipient(recipient: string): boolean {
    return this.store.snapshot().sessions.some((session) => session.externalId === recipient);
  }
  private async pump(): Promise<void> {
    if (this.pumping) { this.pumpAgain = true; return this.pumping; }
    this.pumping = (async () => {
      for (const delivery of this.store.snapshot().deliveries.filter((item) => item.command === 'normal' && ['waiting_safe_point', 'delivered', 'running'].includes(item.state))) {
        const session = this.store.snapshot().sessions.find((item) => item.id === delivery.runtimeSessionId);
        if (!session?.externalId || session.state === 'terminal' || session.generation !== delivery.generation) continue;
        let observed: RuntimeSession;
        try { observed = await this.observe(session.id); } catch { continue; }
        // A post-dispatch observation advances delivered → running → processed in observe().
        // Only waiting_safe_point is eligible to begin a turn; indeterminate is deliberately excluded.
        const currentDelivery = this.store.snapshot().deliveries.find((item) => item.id === delivery.id);
        if (!currentDelivery || currentDelivery.state !== 'waiting_safe_point') continue;
        if (observed.state !== 'idle') continue;
        if (session.provider === 'claude') {
          const facts = await this.facts(session);
          if (facts.cache.state !== 'fresh' && !delivery.cacheAuthorized) { await this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id)!; item.safePointStatus = `cache_${facts.cache.state}`; return item; }); continue; }
        }
        await this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id)!; const runtime = state.sessions.find((value) => value.id === session.id)!; item.state = 'attempting'; item.safePointObservedAt = now(); item.safePointStatus = observed.state; item.attemptedAt = now(); runtime.lastDeliveryId = delivery.id; runtime.lastTurnState = 'running'; return item; });
        try {
          // Adapter rechecks immediately before its non-steering start-turn operation.
          const event = delivery.eventId ? this.store.snapshot().channelEvents.find((item) => item.id === delivery.eventId) : undefined;
          await this.channelFor(session).startTurn(session.externalId, delivery.body, delivery.id);
          await this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id)!; const event = item.eventId ? state.channelEvents.find((value) => value.id === item.eventId) : undefined; item.state = 'delivered'; item.deliveredAt = now(); if (event) this.transitionEvent(event, 'delivered', item.deliveredAt); return item; });
        } catch { await this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id)!; const event = item.eventId ? state.channelEvents.find((value) => value.id === item.eventId) : undefined; item.state = 'transport_indeterminate'; if (event) this.transitionEvent(event, 'transport_indeterminate'); return item; }); }
      }
      if ('prune' in this.store && typeof (this.store as any).prune === 'function') await (this.store as any).prune();
    })().finally(() => { this.pumping = undefined; if (this.pumpAgain) { this.pumpAgain = false; void this.pump(); } });
    return this.pumping;
  }
  async acknowledge(id: string, reason: string, generation?: number): Promise<Delivery> {
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
    const delivery = this.store.snapshot().deliveries.find((item) => item.id === id);
    if (!delivery) throw new ArcpError('not_found', 'delivery not found');
    if (['delivered', 'running', 'processed', 'acknowledged'].includes(delivery.state)) throw new ArcpError('invalid_request', 'delivered delivery cannot be withdrawn');
    if (memberId) {
      const session = this.store.snapshot().sessions.find((item) => item.id === delivery.runtimeSessionId);
      if (!session || session.memberId !== memberId) throw new ArcpError('unauthorized', 'delivery withdrawal is not authorized');
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
    const prohibitedTranscript = /(?:<thinking>|<assistant>|<user>|chain[- ]of[- ]thought|internal reasoning|transcript|reason\s*[:=])/i;
    if (prohibitedAssignment.test(summary) || prohibitedPath.test(summary) || prohibitedTranscript.test(summary) || evidenceRefs.some((ref) => prohibitedPath.test(ref) || prohibitedAssignment.test(ref) || /path\s*=/i.test(ref))) throw new ArcpError('invalid_request', 'channel event content contains prohibited private data', 'summary');
    const taskNotification = ['task_candidate', 'task_failed', 'task_unknown', 'task_completed'].includes(input.kind);
    const targetRole = input.targetRole ?? (taskNotification ? 'manager' : undefined);
    const notifying = input.notify !== false || taskNotification;
    if (notifying && !input.targetMemberId && !input.targetActorId && !targetRole && !input.targetSubscription) throw new ArcpError('invalid_request', 'notifying channel events require an explicit target', 'target');
    const contentHash = createHash('sha256').update(JSON.stringify({ summary, evidenceRefs })).digest('hex');
    const stablePayload = { workspaceId: input.workspaceId, goalId: input.goalId, taskId: input.taskId, resultId: input.resultId, sourceMemberId: input.sourceMemberId, sourceActorId: input.sourceActorId, targetMemberId: input.targetMemberId, targetActorId: input.targetActorId, targetRole, targetSubscription: input.targetSubscription, kind: input.kind, urgency: input.urgency, decisionRequired: input.decisionRequired, relatedEventId: input.relatedEventId, summary, evidenceRefs };
    const id = input.id ?? `event_${createHash('sha256').update(JSON.stringify(stablePayload)).digest('hex').slice(0, 20)}`;
    const existing = state.channelEvents.find((item) => item.id === id);
    if (existing) {
      const existingPayload = { workspaceId: existing.workspaceId, goalId: existing.goalId, taskId: existing.taskId, resultId: existing.resultId, sourceMemberId: existing.sourceMemberId, sourceActorId: existing.sourceActorId, targetMemberId: existing.targetMemberId, targetActorId: existing.targetActorId, targetRole: existing.targetRole, targetSubscription: existing.targetSubscription, kind: existing.kind, urgency: existing.urgency, decisionRequired: existing.decisionRequired, relatedEventId: existing.relatedEventId, summary: existing.content.summary, evidenceRefs: existing.content.evidenceRefs }; const conflict = JSON.stringify(existingPayload) !== JSON.stringify(stablePayload);
      if (conflict) throw new ArcpError('invalid_request', 'channel event id conflicts with its durable payload', 'id');
      return existing;
    }
    const { notify: _notify, ...publicInput } = { ...input, ...(targetRole ? { targetRole } : {}) };
    const { summary: _summary, evidenceRefs: _evidenceRefs, ...envelope } = publicInput;
    const event: ChannelEvent = { ...envelope, id, content: { summary, evidenceRefs, contentHash, sensitivity: 'normal', retention: 'standard' }, deliveryState: 'queued', transitions: [{ state: 'queued', at: now() }], createdAt: now() };
    state.channelEvents.push(event);
    if (notifying && event.workspaceId) {
      const targetMembers = state.members.filter((member) => member.workspaceId === event.workspaceId && (!event.targetMemberId || member.id === event.targetMemberId) && (!event.targetActorId || member.actorId === event.targetActorId) && (!event.targetRole || member.role === event.targetRole) && (!event.targetSubscription || event.targetSubscription === '*' || member.role === event.targetSubscription || member.capabilities.includes(event.targetSubscription)));
      const targetMemberIds = new Set(targetMembers.map((member) => member.id));
      const targetSessions = state.sessions.filter((session) => session.workspaceId === event.workspaceId && session.externalId && session.memberId && session.memberId !== event.sourceMemberId && targetMemberIds.has(session.memberId) && ['launching', 'running', 'idle', 'attention'].includes(session.state));
      if (targetSessions.length === 0) {
        event.undeliverableReason = targetMembers.length === 0 ? 'no matching target member' : 'no live target runtime session';
        this.transitionEvent(event, 'undeliverable');
      }
      for (const session of targetSessions) {
        const deliveryId = idFor('delivery', `event:${event.id}:${session.id}`);
        if (state.deliveries.some((delivery) => delivery.id === deliveryId)) continue;
        state.deliveries.push({ id: deliveryId, fromActorId: event.sourceActorId ?? session.actorId, runtimeSessionId: session.id, generation: session.generation, body: event.content.summary, command: 'normal', eventId: event.id, state: 'waiting_safe_point', createdAt: now() });
      }
    }
    return event;
  }
  private transitionEvent(event: ChannelEvent, state: ChannelTransition['state'], at = now()): void {
    if (event.transitions.at(-1)?.state === state) return;
    event.transitions.push({ state, at }); event.deliveryState = state;
    if (state === 'delivered') event.deliveredAt = at; else if (state === 'processed') event.processedAt = at; else if (state === 'acknowledged') event.acknowledgedAt = at;
  }
  private async emitTransportUncertainty(session: RuntimeSession): Promise<void> {
    await this.store.mutate((state) => { this.appendChannelEvent(state, { workspaceId: session.workspaceId, goalId: session.goalId, taskId: session.taskId, sourceMemberId: session.memberId, sourceActorId: session.actorId, targetRole: 'manager', kind: 'runtime_health', urgency: 'urgent', decisionRequired: true, summary: `Runtime ${session.id} health is uncertain`, evidenceRefs: [] }); this.appendChannelEvent(state, { workspaceId: session.workspaceId, goalId: session.goalId, taskId: session.taskId, sourceMemberId: session.memberId, sourceActorId: session.actorId, targetRole: 'manager', kind: 'transport_uncertainty', urgency: 'urgent', decisionRequired: true, summary: `Runtime ${session.id} transport is uncertain`, evidenceRefs: [] }); });
    if (!this.pumping) await this.pump();
  }
  async publishChannelEvent(input: ChannelEventInput): Promise<ChannelEvent> {
    if (!input.summary?.trim()) throw new ArcpError('invalid_request', 'channel event summary is required');
    const event = await this.store.mutate((state) => this.appendChannelEvent(state, input));
    await this.pump(); return event;
  }
  async acknowledgeEvent(eventId: string, memberId: string, _reason = 'acknowledged'): Promise<ChannelEvent> {
    return this.store.mutate((state) => {
      const event = state.channelEvents.find((item) => item.id === eventId);
      const member = state.members.find((item) => item.id === memberId);
      if (!event) throw new ArcpError('not_found', 'channel event not found');
      if (!member || member.workspaceId !== event.workspaceId) throw new ArcpError('unauthorized', 'event acknowledgement is not authorized');
      const intended = (!event.targetMemberId || event.targetMemberId === member.id) && (!event.targetActorId || event.targetActorId === member.actorId) && (!event.targetRole || event.targetRole === member.role) && (!event.targetSubscription || event.targetSubscription === '*' || event.targetSubscription === member.role || member.capabilities.includes(event.targetSubscription));
      if (!intended) throw new ArcpError('unauthorized', 'event acknowledgement is not authorized');
      if (!['delivered', 'processed'].includes(event.deliveryState)) throw new ArcpError('invalid_request', 'channel event has not been delivered');
      this.transitionEvent(event, 'acknowledged'); return event;
    });
  }
  channelEvents(workspaceId: string, memberId?: string): ChannelEvent[] {
    const state = this.store.snapshot();
    const member = memberId ? state.members.find((item) => item.id === memberId) : undefined;
    return state.channelEvents.filter((event) => event.workspaceId === workspaceId && (!member || (!event.targetMemberId || event.targetMemberId === member.id) && (!event.targetActorId || event.targetActorId === member.actorId) && (!event.targetRole || event.targetRole === member.role) && (!event.targetSubscription || event.targetSubscription === '*' || event.targetSubscription === member.role || member.capabilities.includes(event.targetSubscription))));
  }
  async resolveDecision(eventId: string, sourceMemberId: string, summary = 'Decision resolved'): Promise<ChannelEvent> {
        const resolved = await this.store.mutate((state) => { const triggering = state.channelEvents.find((event) => event.id === eventId && event.kind === 'decision_required'); const resolver = state.members.find((member) => member.id === sourceMemberId); if (!triggering) throw new ArcpError('not_found', 'decision event not found'); if (!resolver || resolver.workspaceId !== triggering.workspaceId) throw new ArcpError('unauthorized', 'decision resolver is not in the event workspace'); const intended = (!triggering.targetMemberId || triggering.targetMemberId === resolver.id) && (!triggering.targetActorId || triggering.targetActorId === resolver.actorId) && (!triggering.targetRole || triggering.targetRole === resolver.role) && (!triggering.targetSubscription || triggering.targetSubscription === '*' || triggering.targetSubscription === resolver.role || resolver.capabilities.includes(triggering.targetSubscription)); if (!intended) throw new ArcpError('unauthorized', 'decision resolver is not an intended target'); triggering.decisionRequired = false; if (triggering.taskId) { const task = state.tasks.find((item) => item.id === triggering.taskId); if (task) { task.lifecycle = 'completed'; task.updatedAt = now(); this.appendChannelEvent(state, { workspaceId: triggering.workspaceId, goalId: triggering.goalId, taskId: task.id, resultId: triggering.resultId, sourceMemberId, targetRole: 'manager', kind: 'task_completed', urgency: 'normal', decisionRequired: false, summary: `Task ${task.id} completed by durable Result`, evidenceRefs: [], notify: false }); } } return this.appendChannelEvent(state, { workspaceId: triggering.workspaceId, goalId: triggering.goalId, taskId: triggering.taskId, resultId: triggering.resultId, sourceMemberId, targetMemberId: triggering.sourceMemberId, targetActorId: triggering.sourceActorId, ...(triggering.sourceMemberId || triggering.sourceActorId ? {} : { targetRole: 'owner' }), kind: 'decision_resolved', urgency: 'normal', decisionRequired: false, summary, evidenceRefs: [], relatedEventId: eventId }); }); await this.pump(); return resolved;
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
      if (!member) { credential = randomBytes(32).toString('base64url'); const at = now(); const hash = createHash('sha256').update(credential).digest('hex'); member = { id: `member_${randomUUID()}`, workspaceId: input.workspaceId, ...(input.actorId ? { actorId: input.actorId } : {}), joinKind: input.joinKind ?? 'native', label: input.label.trim(), role: input.role.trim(), capabilities: input.capabilities ?? [], lifecycle: 'active', leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(), lastHeartbeatAt: at, createdAt: at, updatedAt: at }; state.members.push(member); state.memberCredentials[hash] = member.id; }
      return { member, ...(credential ? { credential } : {}) };
    });
  }
  memberForCredential(credential: string): Member { const state = this.store.snapshot(); const id = state.memberCredentials[createHash('sha256').update(credential).digest('hex')]; const member = state.members.find((item) => item.id === id); if (!member) throw new ArcpError('unknown_sender', 'member credential is unknown'); return member; }
  async createTask(input: { workspaceId: string; title: string }): Promise<Task> { return this.store.mutate((state) => { if (!state.workspaces.some((item) => item.id === input.workspaceId)) throw new ArcpError('not_found', 'workspace not found'); if (!input.title?.trim()) throw new ArcpError('invalid_request', 'task title is required'); const at = now(); const task = { id: `task_${randomUUID()}`, workspaceId: input.workspaceId, title: input.title.trim(), lifecycle: 'ready' as const, fence: 0, createdAt: at, updatedAt: at }; state.tasks.push(task); return task; }); }
  async heartbeat(memberId: string, presence: 'idle' | 'busy' | 'attention' = 'idle'): Promise<Member> { return this.store.mutate((state) => { const member = state.members.find((item) => item.id === memberId); if (!member) throw new ArcpError('unknown_sender', 'member is unknown'); const at = now(); member.lifecycle = presence; member.lastHeartbeatAt = at; member.leaseExpiresAt = new Date(Date.now() + 300_000).toISOString(); member.updatedAt = at; return member; }); }
  async claimTask(taskId: string, memberId: string, expectedFence?: number): Promise<Task> { const claimed = await this.store.mutate((state) => { const task = state.tasks.find((item) => item.id === taskId); const member = state.members.find((item) => item.id === memberId); if (!task || !member || task.workspaceId !== member.workspaceId) throw new ArcpError('unknown_recipient', 'task or member is unknown'); if (expectedFence === undefined) throw new ArcpError('invalid_request', 'expectedFence is required; pass --expected-fence', 'expectedFence'); if (task.fence !== expectedFence) throw new ArcpError('stale_generation', `task claim fence is stale; current fence is ${task.fence}`); if (task.ownerMemberId === memberId && ['claimed', 'running', 'waiting'].includes(task.lifecycle)) return task; if (task.ownerMemberId && ['claimed', 'running', 'waiting'].includes(task.lifecycle)) throw new ArcpError('task_held', 'task already has an active claim'); task.ownerMemberId = memberId; task.fence += 1; task.lifecycle = 'claimed'; task.updatedAt = now(); member.lifecycle = 'busy'; member.updatedAt = now(); return task; }); await this.publishChannelEvent({ workspaceId: claimed.workspaceId, taskId: claimed.id, sourceMemberId: claimed.ownerMemberId, targetRole: 'manager', kind: 'task_claimed', urgency: 'normal', decisionRequired: false, summary: `Task ${claimed.id} claimed at fence ${claimed.fence}`, evidenceRefs: [] }); return claimed; }
  async addKnowledge(input: { workspaceId: string; authorMemberId: string; kind: KnowledgeEntry['kind']; text: string; tags?: string[]; taskId?: string; goalId?: string }): Promise<KnowledgeEntry> { const entry = await this.store.mutate((state) => { const member = state.members.find((item) => item.id === input.authorMemberId && item.workspaceId === input.workspaceId); if (!member) throw new ArcpError('unknown_sender', 'member is not in workspace'); if (!input.text?.trim()) throw new ArcpError('invalid_request', 'knowledge text is required'); const entry = { id: `knowledge_${randomUUID()}`, workspaceId: input.workspaceId, authorMemberId: input.authorMemberId, kind: input.kind, text: input.text.trim(), tags: input.tags ?? [], ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.goalId ? { goalId: input.goalId } : {}), createdAt: now() }; state.knowledge.push(entry); return entry; }); if (input.kind === 'blocker' || input.kind === 'evidence') await this.publishChannelEvent({ workspaceId: entry.workspaceId, taskId: entry.taskId, goalId: entry.goalId, sourceMemberId: entry.authorMemberId, targetRole: 'manager', kind: input.kind === 'blocker' ? 'blocker' : 'finding', urgency: input.kind === 'blocker' ? 'urgent' : 'normal', decisionRequired: input.kind === 'blocker', summary: `${input.kind} knowledge ${entry.id}`, evidenceRefs: [] }); return entry; }
  async submitResult(input: { workspaceId: string; taskId: string; memberId: string; status: Result['status']; summary: string; evidenceRefs?: string[]; expectedFence?: number; sourceId?: string }): Promise<Result> { const submitted = await this.store.mutate((state) => { const task = state.tasks.find((item) => item.id === input.taskId && item.workspaceId === input.workspaceId); if (!task || task.ownerMemberId !== input.memberId) throw new ArcpError('task_held', 'member does not hold this task'); if (!['candidate','failed','unknown'].includes(input.status)) throw new ArcpError('invalid_request', 'invalid result status'); if (input.expectedFence === undefined) throw new ArcpError('invalid_request', 'expectedFence is required; pass --expected-fence', 'expectedFence'); if (task.fence !== input.expectedFence) throw new ArcpError('stale_generation', `result fence is stale; current fence is ${task.fence}`); if ((input.evidenceRefs ?? []).some((value) => value.startsWith('/'))) throw new ArcpError('invalid_request', 'absolute evidence paths are not allowed'); const existing = input.sourceId ? state.results.find((item) => item.sourceId === input.sourceId) : undefined; if (existing) { if (existing.workspaceId !== input.workspaceId || existing.taskId !== input.taskId || existing.memberId !== input.memberId || existing.fence !== task.fence || existing.status !== input.status || existing.summary !== input.summary.trim() || JSON.stringify(existing.evidenceRefs) !== JSON.stringify(input.evidenceRefs ?? [])) throw new ArcpError('invalid_request', 'result source id conflicts with its durable payload', 'sourceId'); return existing; } const result = { id: `result_${randomUUID()}`, workspaceId: input.workspaceId, taskId: input.taskId, memberId: input.memberId, fence: task.fence, status: input.status, summary: input.summary.trim(), evidenceRefs: input.evidenceRefs ?? [], ...(input.sourceId ? { sourceId: input.sourceId } : {}), createdAt: now() }; state.results.push(result); if (input.status === 'candidate') task.lifecycle = 'waiting'; else if (input.status === 'failed') task.lifecycle = 'failed'; else if (input.status === 'unknown') task.lifecycle = 'unknown'; task.updatedAt = now(); const kind = input.status === 'candidate' ? 'task_candidate' : input.status === 'failed' ? 'task_failed' : 'task_unknown'; const candidate = this.appendChannelEvent(state, { id: input.sourceId ? `event_${input.sourceId}` : undefined, workspaceId: result.workspaceId, taskId: result.taskId, resultId: result.id, sourceMemberId: result.memberId, kind, urgency: 'normal', decisionRequired: input.status === 'candidate', summary: result.summary, evidenceRefs: result.evidenceRefs, notify: false }); if (input.status === 'candidate') this.appendChannelEvent(state, { id: input.sourceId ? `event_${input.sourceId}:decision` : undefined, workspaceId: result.workspaceId, taskId: result.taskId, resultId: result.id, sourceMemberId: result.memberId, targetRole: 'manager', kind: 'decision_required', urgency: 'normal', decisionRequired: true, summary: `Result ${result.id} requires Manager decision`, evidenceRefs: [], relatedEventId: candidate.id }); return result; }); await this.pump(); return submitted; }
  context(workspaceId: string, memberId?: string) { const state = this.store.snapshot(); const workspace = state.workspaces.find((item) => item.id === workspaceId); if (!workspace) throw new ArcpError('not_found', 'workspace not found'); const roster = state.members.filter((item) => item.workspaceId === workspaceId).map((member) => ({ ...member, lifecycle: member.leaseExpiresAt && Date.parse(member.leaseExpiresAt) < Date.now() ? 'offline' as const : member.lifecycle })); const memberSessions = new Set(state.sessions.filter((session) => session.workspaceId === workspaceId && (!memberId || session.memberId === memberId)).map((session) => session.id)); return { workspace, roster, tasks: state.tasks.filter((item) => item.workspaceId === workspaceId), knowledge: state.knowledge.filter((item) => item.workspaceId === workspaceId), results: state.results.filter((item) => item.workspaceId === workspaceId), events: this.channelEvents(workspaceId, memberId), inbox: memberId ? state.deliveries.filter((item) => memberSessions.has(item.runtimeSessionId) && item.state !== 'acknowledged') : [] }; }
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
  legacySummary(): LegacySummary {
    const count = (items: Array<{ status?: string }>) => items.reduce<Record<string, number>>((out, item) => { const status = item.status ?? 'unknown'; out[status] = (out[status] ?? 0) + 1; return out; }, {});
    const reminders = this.companion.store.getReminders(); const messages = this.companion.store.getMessages(); const children = this.companion.store.getTrackedChildren(); const corrections = this.companion.store.getCorrections();
    const open = corrections.filter((item) => item.status === 'open' && item.findings.some((finding) => finding.resolution === null));
    return { reminders: count(reminders), messages: count(messages), trackedChildren: { total: children.length, statuses: children.length ? { unknown: children.length } : {} }, openCorrectionInstances: open.length, blockedGateCount: new Set(open.map((item) => item.managerId)).size };
  }
  async runtimeStatus(id: string, refresh = false): Promise<{ session: RuntimeSession; observation: RuntimeObservation; children: ChildObservation; workSummary: WorkSummary }> {
    if (refresh) await this.observe(id);
    const session = this.store.snapshot().sessions.find((item) => item.id === id); if (!session) throw new ArcpError('not_found', 'runtime session not found');
    const requested = this.requested(session); let agent: Record<string, any> | undefined; let timeline: unknown[] | undefined; let source: 'sdk' | 'cli' | undefined;
    if (session.externalId) try { const snapshot = await this.channelFor(session).snapshot(session.externalId); agent = snapshot.agent; timeline = snapshot.timeline; source = snapshot.source; } catch { /* persisted last observation remains useful but stale */ }
    const current = agent ?? {}; const usage = safeJson(current.lastUsage); const numeric = (value: unknown): number | 'unknown' => typeof value === 'number' && Number.isFinite(value) ? value : 'unknown';
    const used = numeric(usage.contextWindowUsedTokens); const max = numeric(usage.contextWindowMaxTokens); const ratio = typeof used === 'number' && typeof max === 'number' && max > 0 ? used / max : 'unknown';
    const observed: Partial<RuntimeSettings> = agent ? { ...(setting(current.provider) ? { provider: String(current.provider) } : {}), ...(setting(current.model) ? { model: String(current.model) } : {}), ...(setting(current.currentModeId ?? current.mode) ? { mode: String(current.currentModeId ?? current.mode) } : {}), ...(setting(current.effectiveThinkingOptionId ?? current.thinkingOptionId ?? current.thinking) ? { thinking: String(current.effectiveThinkingOptionId ?? current.thinkingOptionId ?? current.thinking) } : {}) } : (session.observed ?? {});
    const mismatch = Boolean((requested.provider && !sameSetting(requested.provider, observed.provider)) || (requested.model && !sameSetting(requested.model, observed.model)) || (requested.mode && !sameSetting(requested.mode, observed.mode)) || (requested.thinking && !sameSetting(requested.thinking, observed.thinking)));
    const cacheInfo = agent ? this.cacheState(current, timeline ?? []) : { activityAt: undefined, ageMinutes: undefined, state: 'unknown' as const };
    const compactions = Array.isArray(timeline) ? timeline.map(safeJson).filter((item) => item.type === 'compaction') : [];
    const lastCompaction = compactions.at(-1); const observedAt = agent ? now() : session.lastObservedAt; const age = observedAt ? Date.now() - Date.parse(observedAt) : NaN;
    const freshness: RuntimeObservation['freshness'] = agent ? 'fresh' : !observedAt ? 'unavailable' : Number.isFinite(age) && age > 60_000 ? 'stale' : 'unknown';
    // Paseo marks a completed turn as requiring acknowledgement too; that is not
    // an actionable permission/attention condition for ARCP supervision.
    const pending = agent ? (Array.isArray(current.pendingPermissions) ? current.pendingPermissions.length : 'unknown') : 'unknown'; const attention = agent ? pending === 'unknown' ? (current.attentionReason === 'permission' || current.status === 'permission' || session.lastTurnState === 'requires_action' ? true : 'unknown') : pending !== 0 || current.attentionReason === 'permission' || current.status === 'permission' : 'unknown'; const attentionWhy = attention === true ? String(current.attentionReason ?? (pending !== 'unknown' && pending > 0 ? 'pending permission' : session.lastTurnState === 'requires_action' ? 'runtime requires action' : 'runtime attention')) : undefined;
    const health: RuntimeObservation['health'] = attention === true || mismatch || session.state === 'attention' ? 'attention' : !agent && !session.externalId ? 'unavailable' : freshness === 'stale' || session.state === 'transport_indeterminate' ? 'degraded' : agent ? 'healthy' : 'unknown';
    if ((session.adapterId === 'paseo' || session.runtimeKind === 'paseo') && session.workspaceId && (pending !== 'unknown' && pending > 0 || attention === true)) {
      const sampleBucket = Math.floor(Date.now() / 60_000);
      const facts: Array<{ kind: 'permission' | 'attention'; summary: string }> = [];
      if (pending !== 'unknown' && pending > 0) facts.push({ kind: 'permission', summary: `Runtime ${session.id} has pending permission requests` });
      if (attention === true) facts.push({ kind: 'attention', summary: `Runtime ${session.id} requires attention` });
      await Promise.all(facts.map((fact) => this.publishChannelEvent({ id: idFor('event', `observation:${session.externalId ?? session.id}:${fact.kind}:${sampleBucket}:${session.workspaceId}:${session.goalId}:${session.taskId ?? ''}:${session.memberId ?? ''}`), workspaceId: session.workspaceId, goalId: session.goalId, taskId: session.taskId, sourceMemberId: session.memberId, sourceActorId: session.actorId, targetRole: 'manager', kind: fact.kind, urgency: 'urgent', decisionRequired: true, summary: fact.summary, evidenceRefs: [] })));
    }
    return { session, observation: { status: session.state, activeTurn: agent ? Boolean(current.activeTurn) : 'unknown', usage: { input: numeric(usage.inputTokens), cached: numeric(usage.cachedInputTokens), output: numeric(usage.outputTokens) }, context: { used, max, ratio, quality: agent && typeof used === 'number' ? source === 'sdk' ? 'observed' : 'reported' : 'unavailable' }, pendingPermissions: pending, attention, ...(attentionWhy ? { attentionWhy } : {}), compaction: { count: Array.isArray(timeline) ? compactions.length : 'unknown', status: !Array.isArray(timeline) ? 'unavailable' : !compactions.length ? 'none' : lastCompaction?.status === 'loading' ? 'loading' : 'completed', ...(setting(lastCompaction?.timestamp ?? lastCompaction?.createdAt) ? { lastAt: String(lastCompaction?.timestamp ?? lastCompaction?.createdAt) } : {}) }, cache: { ...(cacheInfo.activityAt ? { activityAt: cacheInfo.activityAt } : {}), ageMinutes: cacheInfo.ageMinutes ?? 'unknown', state: cacheInfo.state }, ...(observedAt ? { lastObservedAt: observedAt } : {}), freshness, health, requested, observed, mismatch }, children: await this.children(session.externalId, this.channelFor(session)), workSummary: await this.workSummary(session.workspace) };
  }
  async panorama(workspaceId: string, refresh = false) {
    const context = this.context(workspaceId); const state = this.store.snapshot(); const sessions = state.sessions.filter((item) => item.workspaceId === workspaceId); const runtime = await Promise.all(sessions.map((item) => this.runtimeStatus(item.id, refresh)));
    return { ...context, goals: state.goals.filter((goal) => sessions.some((session) => session.goalId === goal.id)), runtime, latestKnowledgeRef: context.knowledge.at(-1)?.id, latestResultRef: context.results.at(-1)?.id, legacy: this.legacySummary() };
  }
  state() { return this.store.snapshot(); }
}

export class ArcpError extends Error { constructor(readonly code: string, message: string, readonly field?: string) { super(message); } }
