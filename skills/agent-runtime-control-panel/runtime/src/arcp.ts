import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PaseoCli, asRecord } from './cli.js';
import { CompanionService } from './service.js';

export type GoalState = 'active' | 'completed' | 'cancelled';
export type SessionState = 'launching' | 'running' | 'idle' | 'terminal' | 'transport_indeterminate';
export type DeliveryState = 'queued' | 'waiting_safe_point' | 'delivered' | 'acknowledged' | 'transport_indeterminate';

export interface Actor { id: string; clientIdentity: string; label: string; createdAt: string; }
export interface ActorBinding { id: string; actorId: string; adapter: 'paseo'; remoteActorId: string; generation: number; createdAt: string; }
export interface Goal { id: string; actorId: string; title: string; state: GoalState; createdAt: string; updatedAt: string; }
export interface RuntimeSession { id: string; actorId: string; goalId: string; bindingId: string; profileId: string; provider: string; model: string; mode: string; thinking: string; workspace?: string; externalId?: string; state: SessionState; lastObservedAt?: string; createdAt: string; }
export interface Delivery { id: string; fromActorId: string; runtimeSessionId: string; body: string; command: 'normal' | 'interrupt'; state: DeliveryState; companionMessageId?: string; createdAt: string; deliveredAt?: string; acknowledgedAt?: string; }
interface State { actors: Actor[]; bindings: ActorBinding[]; goals: Goal[]; sessions: RuntimeSession[]; deliveries: Delivery[]; }

const empty = (): State => ({ actors: [], bindings: [], goals: [], sessions: [], deliveries: [] });
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
      this.state = { actors: parsed.actors ?? [], bindings: parsed.bindings ?? [], goals: parsed.goals ?? [], sessions: parsed.sessions ?? [], deliveries: parsed.deliveries ?? [] };
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
  if (['idle', 'waiting'].includes(state)) return 'idle';
  return 'running';
}

/** The V1 first-class runtime adapter. Provider choices stay in validated profiles;
 * this adapter owns only safe Paseo transport/discovery calls and never exposes native handles. */
export class PaseoAdapter {
  constructor(private readonly cli: PaseoCli) {}
  discover() { return this.cli.run(['provider', 'ls', '--json'], { timeoutMs: 5_000 }); }
  models(provider: string) { return this.cli.run(['provider', 'models', provider, '--json'], { timeoutMs: 5_000 }); }
  launch(profile: typeof DEFAULT_PROFILES[number], goalTitle: string, workspace?: string) {
    return this.cli.run(['run', '-d', '--json', '--provider', profile.provider, '--model', profile.model, '--mode', profile.mode, '--thinking', profile.thinking, ...(workspace ? ['--cwd', workspace] : []), `Work on ARCP Goal: ${goalTitle}`], { timeoutMs: 30_000 });
  }
  observe(externalId: string) { return this.cli.run(['inspect', externalId, '--json'], { timeoutMs: 5_000 }); }
  registry() { return this.cli.run(['ls', '-g', '--json'], { timeoutMs: 5_000 }); }
}

export class ArcpService {
  readonly store: ArcpStore;
  readonly adapter: PaseoAdapter;
  constructor(readonly companion: CompanionService, readonly cli = new PaseoCli(), store?: ArcpStore) { this.store = store ?? new ArcpStore(companion.store.dir); this.adapter = new PaseoAdapter(cli); }
  async init(): Promise<void> { await this.store.init(); }
  registerActor(input: { clientIdentity: string; label?: string }): Promise<{ actor: Actor; binding: ActorBinding }> {
    const clientIdentity = input.clientIdentity?.trim();
    if (!clientIdentity) throw new ArcpError('invalid_request', 'clientIdentity is required');
    return this.store.mutate((state) => {
      let actor = state.actors.find((item) => item.clientIdentity === clientIdentity);
      if (!actor) { actor = { id: idFor('actor', clientIdentity), clientIdentity, label: input.label?.trim() || 'ARCP client', createdAt: now() }; state.actors.push(actor); }
      let binding = state.bindings.find((item) => item.actorId === actor!.id && item.adapter === 'paseo');
      if (!binding) { binding = { id: idFor('binding', `${actor.id}:paseo:1`), actorId: actor.id, adapter: 'paseo', remoteActorId: actor.id, generation: 1, createdAt: now() }; state.bindings.push(binding); }
      return { actor, binding };
    });
  }
  async bindActor(input: { actorId: string; remoteActorId?: string }): Promise<ActorBinding> {
    return this.store.mutate((state) => {
      if (!state.actors.some((item) => item.id === input.actorId)) throw new ArcpError('unknown_recipient', 'actor is not registered');
      const current = state.bindings.filter((item) => item.actorId === input.actorId && item.adapter === 'paseo').sort((a, b) => b.generation - a.generation)[0];
      const remoteActorId = input.remoteActorId?.trim() || input.actorId;
      if (current?.remoteActorId === remoteActorId) return current;
      const generation = (current?.generation ?? 0) + 1;
      const binding = { id: idFor('binding', `${input.actorId}:paseo:${generation}`), actorId: input.actorId, adapter: 'paseo' as const, remoteActorId, generation, createdAt: now() };
      state.bindings.push(binding); return binding;
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
  profiles() { return DEFAULT_PROFILES.map((profile) => ({ ...profile, paidModelAutoSelection: false })); }
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
          const thinking = Array.isArray(model?.thinkingOptionIds) && model.thinkingOptionIds.map(String).includes(profile.thinking);
          return { ...profile, available: providerAvailable && Boolean(model) && thinking && capabilityToken(modes).includes(capabilityToken(profile.mode)) };
        } catch { return { ...profile, available: false }; }
      }));
      return { available: true, profiles };
    } catch { return { available: false, profiles: this.profiles().map((profile) => ({ ...profile, available: false })) }; }
  }
  async launch(input: { actorId: string; goalId: string; profileId: string; workspace?: string }): Promise<RuntimeSession> {
    const profile = DEFAULT_PROFILES.find((item) => item.id === input.profileId);
    if (!profile) throw new ArcpError('invalid_request', 'unknown launch profile');
    const state = this.store.snapshot();
    const goal = state.goals.find((item) => item.id === input.goalId && item.actorId === input.actorId);
    const binding = state.bindings.find((item) => item.actorId === input.actorId && item.adapter === 'paseo');
    if (!goal || !binding) throw new ArcpError('unknown_recipient', 'actor or goal is not registered');
    const discovered = await this.discovery();
    const available = discovered.profiles.find((item) => item.id === profile.id)?.available;
    if (!available) throw new ArcpError('profile_unavailable', 'requested provider, model, or mode is unavailable');
    const session: RuntimeSession = { id: `runtime_${randomUUID()}`, actorId: input.actorId, goalId: goal.id, bindingId: binding.id, profileId: profile.id, provider: profile.provider, model: profile.model, mode: profile.mode, thinking: profile.thinking, workspace: input.workspace, state: 'launching', createdAt: now() };
    await this.store.mutate((next) => { next.sessions.push(session); });
    try {
      const result = asRecord((await this.adapter.launch(profile, goal.title, input.workspace)).value);
      const externalId = String(result.id ?? result.agentId ?? '');
      if (!externalId) throw new Error('Paseo did not return a runtime identity');
      return this.store.mutate((next) => { const stored = next.sessions.find((item) => item.id === session.id)!; stored.externalId = externalId; stored.state = 'running'; stored.lastObservedAt = now(); return stored; });
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
      return this.store.mutate((state) => { const item = state.sessions.find((value) => value.id === id)!; item.state = sessionState(observed.status ?? observed.Status); item.lastObservedAt = now(); return item; });
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
  async deliver(input: { fromActorId: string; runtimeSessionId: string; body: string; command?: 'normal' | 'interrupt' }): Promise<Delivery> {
    if (!input.body?.trim()) throw new ArcpError('invalid_request', 'body is required');
    const snapshot = this.store.snapshot(); const session = snapshot.sessions.find((item) => item.id === input.runtimeSessionId);
    if (!snapshot.actors.some((item) => item.id === input.fromActorId) || !session || !session.externalId) throw new ArcpError('unknown_recipient', 'recipient is not registered');
    const command = input.command ?? 'normal';
    if (!['normal', 'interrupt'].includes(command)) throw new ArcpError('invalid_request', 'command must be normal or interrupt');
    const delivery: Delivery = { id: `delivery_${randomUUID()}`, fromActorId: input.fromActorId, runtimeSessionId: session.id, body: input.body.trim(), command, state: command === 'normal' ? 'waiting_safe_point' : 'queued', createdAt: now() };
    await this.store.mutate((state) => { state.deliveries.push(delivery); });
    try {
      const sent = await this.companion.postMessage({ to: session.externalId, from: input.fromActorId, body: input.body.trim(), delivery: command === 'interrupt' ? 'interrupt' : 'on-idle', mode: 'ack' });
      return this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id)!; item.companionMessageId = sent.id; item.state = sent.delivery?.status === 'accepted' ? 'delivered' : item.state; if (item.state === 'delivered') item.deliveredAt = now(); return item; });
    } catch { return this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === delivery.id)!; item.state = 'transport_indeterminate'; return item; }); }
  }
  async acknowledge(id: string, reason: string): Promise<Delivery> {
    const delivery = this.store.snapshot().deliveries.find((item) => item.id === id);
    if (!delivery) throw new ArcpError('not_found', 'delivery not found');
    try { if (delivery.companionMessageId) await this.companion.deleteMessage(delivery.companionMessageId, reason || 'processed'); }
    catch { return this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === id)!; item.state = 'transport_indeterminate'; return item; }); }
    return this.store.mutate((state) => { const item = state.deliveries.find((value) => value.id === id)!; item.state = 'acknowledged'; item.acknowledgedAt = now(); return item; });
  }
  state() { return this.store.snapshot(); }
}

export class ArcpError extends Error { constructor(readonly code: string, message: string) { super(message); } }
