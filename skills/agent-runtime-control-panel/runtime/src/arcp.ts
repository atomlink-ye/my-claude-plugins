import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaseoCli, asRecord } from './cli.js';
import { CompanionService } from './service.js';
import { createPaseoClient } from '@getpaseo/client';
import WebSocket from 'ws';

export type GoalState = 'active' | 'completed' | 'cancelled';
export type SessionState = 'launching' | 'running' | 'idle' | 'terminal' | 'attention' | 'transport_indeterminate';
export type DeliveryState = 'queued' | 'waiting_safe_point' | 'attempting' | 'delivered' | 'running' | 'processed' | 'acknowledged' | 'transport_indeterminate';

export interface Actor { id: string; clientIdentity: string; label: string; createdAt: string; }
export interface ActorBinding { id: string; actorId: string; channel: 'hermes' | 'local'; profileRef?: string; conversationRef?: string; generation: number; createdAt: string; }
export interface Goal { id: string; actorId: string; title: string; state: GoalState; createdAt: string; updatedAt: string; }
export interface RuntimeSession { id: string; actorId: string; goalId: string; bindingId: string; generation: number; workspaceId?: string; memberId?: string; profileId: string; provider: string; model: string; mode?: string; thinking?: string; workspace?: string; externalId?: string; state: SessionState; lastObservedAt?: string; createdAt: string; }
export interface Delivery { id: string; fromActorId: string; runtimeSessionId: string; generation: number; body: string; command: 'normal' | 'interrupt'; reason?: string; state: DeliveryState; createdAt: string; safePointObservedAt?: string; safePointStatus?: string; attemptedAt?: string; deliveredAt?: string; processedAt?: string; acknowledgedAt?: string; }
export interface ControlWorkspace { id: string; purpose: string; lifecycle: 'active' | 'completed' | 'cancelled'; ownerActorId: string; createdAt: string; updatedAt: string; }
export interface Member { id: string; workspaceId: string; actorId?: string; label: string; role: string; capabilities: string[]; lifecycle: 'invited' | 'joining' | 'active' | 'idle' | 'busy' | 'attention' | 'offline' | 'retired'; credentialHash: string; lastHeartbeatAt?: string; createdAt: string; updatedAt: string; }
export interface Task { id: string; workspaceId: string; title: string; lifecycle: 'proposed' | 'ready' | 'claimed' | 'running' | 'waiting' | 'candidate' | 'completed' | 'failed' | 'unknown' | 'cancelled'; ownerMemberId?: string; fence: number; createdAt: string; updatedAt: string; }
export interface KnowledgeEntry { id: string; workspaceId: string; authorMemberId: string; kind: 'problem' | 'learning' | 'decision' | 'evidence' | 'runbook' | 'blocker'; text: string; tags: string[]; taskId?: string; goalId?: string; createdAt: string; }
export interface Result { id: string; workspaceId: string; taskId: string; memberId: string; status: 'candidate' | 'completed' | 'failed' | 'unknown'; summary: string; evidenceRefs: string[]; createdAt: string; }
interface State { actors: Actor[]; bindings: ActorBinding[]; credentials: Record<string, string>; workspaces: ControlWorkspace[]; members: Member[]; memberCredentials: Record<string, string>; tasks: Task[]; knowledge: KnowledgeEntry[]; results: Result[]; goals: Goal[]; sessions: RuntimeSession[]; deliveries: Delivery[]; }

const empty = (): State => ({ actors: [], bindings: [], credentials: {}, workspaces: [], members: [], memberCredentials: {}, tasks: [], knowledge: [], results: [], goals: [], sessions: [], deliveries: [] });
const idFor = (prefix: string, value: string) => `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
const now = () => new Date().toISOString();

/** A compact, independently durable ARCP state file. It intentionally stores public IDs and
 * metadata only: provider handles, prompts, credentials, and host paths never enter it. */
export class ArcpStore {
  private state: State = empty();
  private write = Promise.resolve();
  readonly file: string;
  constructor(dir: string) { this.file = path.join(dir, 'arcp-state.json'); }
  async init(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<State>;
      this.state = { actors: parsed.actors ?? [], bindings: parsed.bindings ?? [], credentials: parsed.credentials ?? {}, workspaces: parsed.workspaces ?? [], members: parsed.members ?? [], memberCredentials: parsed.memberCredentials ?? {}, tasks: parsed.tasks ?? [], knowledge: parsed.knowledge ?? [], results: parsed.results ?? [], goals: parsed.goals ?? [], sessions: parsed.sessions ?? [], deliveries: parsed.deliveries ?? [] };
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
}

export const DEFAULT_PROFILES = [
  { id: 'claude-manager', provider: 'claude', model: 'anthropic/claude-opus-4-6', mode: 'auto', thinking: 'medium', role: 'manager' },
  { id: 'codex-worker', provider: 'codex', model: 'gpt-5.6-terra', mode: 'full-access', thinking: 'medium', role: 'worker' },
  { id: 'pi-grok-worker', provider: 'pi', model: 'grok-cli/grok-4.6', mode: 'full-access', thinking: 'medium', role: 'worker' },
] as const;

function normalized(value: unknown): string { return String(value ?? '').toLowerCase(); }
function capabilityText(value: unknown): string { return String(JSON.stringify(value ?? '')).toLowerCase(); }
function capabilityToken(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function sessionState(value: unknown): SessionState {
  const state = normalized(value);
  if (['completed', 'failed', 'stopped', 'cancelled', 'archived', 'terminal'].includes(state)) return 'terminal';
  if (state === 'idle') return 'idle';
  return 'running';
}

/** The V1 first-class runtime adapter. Provider choices stay in validated profiles;
 * this adapter owns only safe Paseo transport/discovery calls and never exposes native handles. */
export class PaseoAdapter {
  constructor(private readonly cli: PaseoCli) {}
  discover() { return this.cli.run(['provider', 'ls', '--json'], { timeoutMs: 5_000 }); }
  models(provider: string) { return this.cli.run(['provider', 'models', provider, '--json'], { timeoutMs: 5_000 }); }
  launch(profile: Profile, goalTitle: string, workspace?: string) {
    return this.cli.run(['run', '-d', '--json', '--provider', profile.provider, '--model', profile.model, ...(profile.mode ? ['--mode', profile.mode] : []), ...(profile.thinking ? ['--thinking', profile.thinking] : []), ...(workspace ? ['--cwd', workspace] : []), `Work on ARCP Goal: ${goalTitle}`], { timeoutMs: 30_000 });
  }
  observe(externalId: string) { return this.cli.run(['inspect', externalId, '--json'], { timeoutMs: 5_000 }); }
  registry() { return this.cli.run(['ls', '-g', '--json'], { timeoutMs: 5_000 }); }
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
}

export type Profile = { id: string; provider: string; model: string; mode?: string; thinking?: string; role: string };

export class ArcpService {
  readonly store: ArcpStore;
  readonly adapter: PaseoAdapter;
  private profileData: Profile[] = [...DEFAULT_PROFILES];
  private pumpTimer?: NodeJS.Timeout;
  private pumping?: Promise<void>;
  constructor(readonly companion: CompanionService, readonly cli = new PaseoCli(), store?: ArcpStore) { this.store = store ?? new ArcpStore(companion.store.dir); this.adapter = new PaseoAdapter(cli); }
  async init(): Promise<void> {
    await this.store.init();
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
  async createGoal(input: { actorId: string; title: string }): Promise<Goal> {
    if (!input.title?.trim()) throw new ArcpError('invalid_request', 'title is required');
    return this.store.mutate((state) => {
      if (!state.actors.some((item) => item.id === input.actorId)) throw new ArcpError('unknown_recipient', 'actor is not registered');
      const at = now(); const goal = { id: `goal_${randomUUID()}`, actorId: input.actorId, title: input.title.trim(), state: 'active' as const, createdAt: at, updatedAt: at };
      state.goals.push(goal); return goal;
    });
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
        const modes = capabilityText(provider?.modes);
        try {
          const models = (await this.adapter.models(profile.provider)).value;
          const model = Array.isArray(models) ? models.map(asRecord).find((item) => String(item.id).toLowerCase() === profile.model.toLowerCase()) : undefined;
          const thinking = !profile.thinking || (Array.isArray(model?.thinkingOptionIds) && model.thinkingOptionIds.map(String).includes(profile.thinking));
          const mode = !profile.mode || capabilityToken(modes).includes(capabilityToken(profile.mode));
          return { ...profile, available: providerAvailable && Boolean(model) && thinking && mode };
        } catch { return { ...profile, available: false }; }
      }));
      return { available: true, profiles };
    } catch { return { available: false, profiles: this.profiles().map((profile) => ({ ...profile, available: false })) }; }
  }
  async launch(input: { actorId: string; goalId: string; profileId: string; workspace?: string; workspaceId?: string; memberId?: string }): Promise<RuntimeSession> {
    const profile = this.profileData.find((item) => item.id === input.profileId);
    if (!profile) throw new ArcpError('invalid_request', 'unknown launch profile');
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
    const session: RuntimeSession = { id: `runtime_${randomUUID()}`, actorId: input.actorId, goalId: goal.id, bindingId: binding.id, generation, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), ...(input.memberId ? { memberId: input.memberId } : {}), profileId: profile.id, provider: profile.provider, model: profile.model, ...(profile.mode ? { mode: profile.mode } : {}), ...(profile.thinking ? { thinking: profile.thinking } : {}), workspace: input.workspace, state: 'launching', createdAt: now() };
    await this.store.mutate((next) => { next.sessions.push(session); });
    try {
      const result = asRecord((await this.adapter.launch(profile, goal.title, input.workspace)).value);
      const externalId = String(result.id ?? result.agentId ?? '');
      if (!externalId) throw new Error('Paseo did not return a runtime identity');
      const inspected = asRecord((await this.adapter.observe(externalId)).value);
      const observed = [inspected.provider ?? inspected.Provider, inspected.model ?? inspected.Model, inspected.mode ?? inspected.Mode, inspected.thinking ?? inspected.Thinking];
      const expected = [profile.provider, profile.model, profile.mode, profile.thinking];
      const matchesPlan = expected.every((expectedValue, index) => !expectedValue || (typeof observed[index] === 'string' && capabilityToken(String(observed[index])) === capabilityToken(expectedValue)));
      return this.store.mutate((next) => { const stored = next.sessions.find((item) => item.id === session.id)!; stored.externalId = externalId; stored.state = matchesPlan ? sessionState(inspected.status ?? inspected.Status) : 'attention'; stored.lastObservedAt = now(); return stored; });
    } catch {
      return this.store.mutate((next) => { const stored = next.sessions.find((item) => item.id === session.id)!; stored.state = 'transport_indeterminate'; return stored; });
    }
  }
  async observe(id: string): Promise<RuntimeSession> {
    const prior = this.store.snapshot().sessions.find((item) => item.id === id);
    if (!prior) throw new ArcpError('not_found', 'runtime session not found');
    if (!prior.externalId) return prior;
    try {
      const observed = asRecord((await this.adapter.observe(prior.externalId)).value);
      const updated = await this.store.mutate((state) => {
        const item = state.sessions.find((value) => value.id === id)!; item.state = sessionState(observed.status ?? observed.Status); item.lastObservedAt = now();
        for (const delivery of state.deliveries.filter((value) => value.runtimeSessionId === id && value.generation === item.generation && ['delivered', 'running'].includes(value.state))) {
          if (item.state === 'running') delivery.state = 'running';
          else if (item.state === 'idle' || item.state === 'terminal') { delivery.state = 'processed'; delivery.processedAt = now(); }
        }
        return item;
      });
      void this.pump(); return updated;
    } catch { return this.store.mutate((state) => { const item = state.sessions.find((value) => value.id === id)!; item.state = 'transport_indeterminate'; return item; }); }
  }
  async reconcile(id: string): Promise<RuntimeSession> {
    const prior = this.store.snapshot().sessions.find((item) => item.id === id);
    if (!prior) throw new ArcpError('not_found', 'runtime session not found');
    try {
      const agents = (await this.adapter.registry()).value;
      const match = Array.isArray(agents) ? agents.map(asRecord).find((item) => String(item.id ?? item.agentId) === prior.externalId) : undefined;
      if (!match) return this.store.mutate((state) => { const item = state.sessions.find((value) => value.id === id)!; item.state = 'transport_indeterminate'; return item; });
      return this.store.mutate((state) => { const item = state.sessions.find((value) => value.id === id)!; item.state = sessionState(match.status ?? match.Status); item.lastObservedAt = now(); return item; });
    } catch { return this.store.mutate((state) => { const item = state.sessions.find((value) => value.id === id)!; item.state = 'transport_indeterminate'; return item; }); }
  }
  async deliver(input: { fromActorId: string; runtimeSessionId: string; body: string; command?: 'normal' | 'interrupt'; reason?: string }): Promise<Delivery> {
    if (!input.body?.trim()) throw new ArcpError('invalid_request', 'body is required');
    const snapshot = this.store.snapshot(); const session = snapshot.sessions.find((item) => item.id === input.runtimeSessionId);
    if (!snapshot.actors.some((item) => item.id === input.fromActorId) || !session || !session.externalId) throw new ArcpError('unknown_recipient', 'recipient is not registered');
    const command = input.command ?? 'normal';
    if (!['normal', 'interrupt'].includes(command)) throw new ArcpError('invalid_request', 'command must be normal or interrupt');
    if (command === 'interrupt' && !input.reason?.trim()) throw new ArcpError('invalid_request', 'interrupt reason is required');
    const delivery: Delivery = { id: `delivery_${randomUUID()}`, fromActorId: input.fromActorId, runtimeSessionId: session.id, generation: session.generation, body: input.body.trim(), command, ...(input.reason ? { reason: input.reason.trim() } : {}), state: command === 'normal' ? 'waiting_safe_point' : 'queued', createdAt: now() };
    await this.store.mutate((state) => { state.deliveries.push(delivery); });
    if (command === 'normal') { await this.pump(); return this.store.snapshot().deliveries.find((item) => item.id === delivery.id)!; }
    try {
      await this.adapter.interrupt(session.externalId!, delivery.body);
      return this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id)!; item.state = 'delivered'; item.deliveredAt = now(); return item; });
    } catch { return this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id)!; item.state = 'transport_indeterminate'; return item; }); }
  }
  private async pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    this.pumping = (async () => {
      for (const delivery of this.store.snapshot().deliveries.filter((item) => item.command === 'normal' && item.state === 'waiting_safe_point')) {
        const session = this.store.snapshot().sessions.find((item) => item.id === delivery.runtimeSessionId);
        if (!session?.externalId || session.generation !== delivery.generation) continue;
        let observed: RuntimeSession;
        try { observed = await this.observe(session.id); } catch { continue; }
        if (!['idle', 'terminal'].includes(observed.state)) continue;
        await this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id)!; item.state = 'attempting'; item.safePointObservedAt = now(); item.safePointStatus = observed.state; item.attemptedAt = now(); return item; });
        try {
          // Adapter rechecks immediately before its non-steering start-turn operation.
          await this.adapter.startTurn(session.externalId, delivery.body, delivery.id);
          await this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id)!; item.state = 'delivered'; item.deliveredAt = now(); return item; });
        } catch { await this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id)!; item.state = 'transport_indeterminate'; return item; }); }
      }
    })().finally(() => { this.pumping = undefined; });
    return this.pumping;
  }
  async acknowledge(id: string, reason: string, generation?: number): Promise<Delivery> {
    const delivery = this.store.snapshot().deliveries.find((item) => item.id === id);
    if (!delivery) throw new ArcpError('not_found', 'delivery not found');
    if (generation !== undefined && generation !== delivery.generation) throw new ArcpError('stale_generation', 'delivery generation is stale');
    if (delivery.state !== 'processed') throw new ArcpError('invalid_request', 'delivery has not been processed');
    return this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === id)!; item.state = 'acknowledged'; item.acknowledgedAt = now(); return item; });
  }
  async createWorkspace(input: { ownerActorId: string; purpose: string }): Promise<ControlWorkspace> {
    if (!input.purpose?.trim()) throw new ArcpError('invalid_request', 'workspace purpose is required');
    return this.store.mutate((state) => { if (!state.actors.some((item) => item.id === input.ownerActorId)) throw new ArcpError('unknown_recipient', 'owner actor is not registered'); const at = now(); const workspace = { id: `workspace_${randomUUID()}`, purpose: input.purpose.trim(), lifecycle: 'active' as const, ownerActorId: input.ownerActorId, createdAt: at, updatedAt: at }; state.workspaces.push(workspace); return workspace; });
  }
  async joinWorkspace(input: { workspaceId: string; label: string; role: string; capabilities?: string[]; actorId?: string }): Promise<{ member: Member; credential?: string }> {
    if (!input.label?.trim() || !input.role?.trim()) throw new ArcpError('invalid_request', 'member label and role are required');
    return this.store.mutate((state) => {
      if (!state.workspaces.some((item) => item.id === input.workspaceId)) throw new ArcpError('not_found', 'workspace not found');
      let member = state.members.find((item) => item.workspaceId === input.workspaceId && item.label === input.label.trim()); let credential: string | undefined;
      if (!member) { credential = randomBytes(32).toString('base64url'); const at = now(); member = { id: `member_${randomUUID()}`, workspaceId: input.workspaceId, ...(input.actorId ? { actorId: input.actorId } : {}), label: input.label.trim(), role: input.role.trim(), capabilities: input.capabilities ?? [], lifecycle: 'active', credentialHash: createHash('sha256').update(credential).digest('hex'), lastHeartbeatAt: at, createdAt: at, updatedAt: at }; state.members.push(member); state.memberCredentials[member.credentialHash] = member.id; }
      return { member, ...(credential ? { credential } : {}) };
    });
  }
  memberForCredential(credential: string): Member { const state = this.store.snapshot(); const id = state.memberCredentials[createHash('sha256').update(credential).digest('hex')]; const member = state.members.find((item) => item.id === id); if (!member) throw new ArcpError('unknown_sender', 'member credential is unknown'); return member; }
  async createTask(input: { workspaceId: string; title: string }): Promise<Task> { return this.store.mutate((state) => { if (!state.workspaces.some((item) => item.id === input.workspaceId)) throw new ArcpError('not_found', 'workspace not found'); if (!input.title?.trim()) throw new ArcpError('invalid_request', 'task title is required'); const at = now(); const task = { id: `task_${randomUUID()}`, workspaceId: input.workspaceId, title: input.title.trim(), lifecycle: 'ready' as const, fence: 0, createdAt: at, updatedAt: at }; state.tasks.push(task); return task; }); }
  async claimTask(taskId: string, memberId: string): Promise<Task> { return this.store.mutate((state) => { const task = state.tasks.find((item) => item.id === taskId); const member = state.members.find((item) => item.id === memberId); if (!task || !member || task.workspaceId !== member.workspaceId) throw new ArcpError('unknown_recipient', 'task or member is unknown'); if (task.ownerMemberId && task.ownerMemberId !== memberId && ['claimed', 'running', 'waiting'].includes(task.lifecycle)) throw new ArcpError('task_held', 'task already has an active claim'); task.ownerMemberId = memberId; task.fence += 1; task.lifecycle = 'claimed'; task.updatedAt = now(); member.lifecycle = 'busy'; member.updatedAt = now(); return task; }); }
  async addKnowledge(input: { workspaceId: string; authorMemberId: string; kind: KnowledgeEntry['kind']; text: string; tags?: string[]; taskId?: string; goalId?: string }): Promise<KnowledgeEntry> { return this.store.mutate((state) => { const member = state.members.find((item) => item.id === input.authorMemberId && item.workspaceId === input.workspaceId); if (!member) throw new ArcpError('unknown_sender', 'member is not in workspace'); if (!input.text?.trim()) throw new ArcpError('invalid_request', 'knowledge text is required'); const entry = { id: `knowledge_${randomUUID()}`, workspaceId: input.workspaceId, authorMemberId: input.authorMemberId, kind: input.kind, text: input.text.trim(), tags: input.tags ?? [], ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.goalId ? { goalId: input.goalId } : {}), createdAt: now() }; state.knowledge.push(entry); return entry; }); }
  async submitResult(input: { workspaceId: string; taskId: string; memberId: string; status: Result['status']; summary: string; evidenceRefs?: string[] }): Promise<Result> { return this.store.mutate((state) => { const task = state.tasks.find((item) => item.id === input.taskId && item.workspaceId === input.workspaceId); if (!task || task.ownerMemberId !== input.memberId) throw new ArcpError('task_held', 'member does not hold this task'); const result = { id: `result_${randomUUID()}`, workspaceId: input.workspaceId, taskId: input.taskId, memberId: input.memberId, status: input.status, summary: input.summary.trim(), evidenceRefs: input.evidenceRefs ?? [], createdAt: now() }; state.results.push(result); if (input.status === 'completed') task.lifecycle = 'completed'; else if (input.status === 'candidate') task.lifecycle = 'candidate'; else if (input.status === 'failed') task.lifecycle = 'failed'; task.updatedAt = now(); return result; }); }
  context(workspaceId: string) { const state = this.store.snapshot(); const workspace = state.workspaces.find((item) => item.id === workspaceId); if (!workspace) throw new ArcpError('not_found', 'workspace not found'); return { workspace, roster: state.members.filter((item) => item.workspaceId === workspaceId), tasks: state.tasks.filter((item) => item.workspaceId === workspaceId), knowledge: state.knowledge.filter((item) => item.workspaceId === workspaceId), results: state.results.filter((item) => item.workspaceId === workspaceId), inbox: state.deliveries.filter((item) => state.sessions.find((session) => session.id === item.runtimeSessionId)?.actorId === workspace.ownerActorId) }; }
  state() { return this.store.snapshot(); }
}

export class ArcpError extends Error { constructor(readonly code: string, message: string) { super(message); } }
