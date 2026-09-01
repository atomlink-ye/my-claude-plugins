import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CliResult } from './cli.js';
import type { ChannelAdapter, ChannelEvent, ChildObservation, Profile, RuntimeAdapter, RuntimeLaunchContext } from './arcp.js';

type JsonRpcMessage = { jsonrpc?: string; id?: number; method?: string; params?: Record<string, any>; result?: any; error?: { message?: string } };
type ApcProcess = ChildProcessWithoutNullStreams;
type Session = { process: ApcProcess; nextId: number; pending: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>; status: 'running' | 'idle' | 'attention' | 'terminal'; timeline: unknown[]; externalId?: string; context?: RuntimeLaunchContext; lastDeliveryId?: string; lastTurnState?: string; lastFactKey?: string; lastFactAt?: number };
type SpawnFn = (command: string, args: string[], options: { stdio: ['pipe', 'pipe', 'pipe']; env?: Record<string, string> }) => ApcProcess;
export type SafePointEvent = { externalId: string; deliveryId?: string; state: 'idle' | 'attention' | 'terminal' };
export type ChannelFact = { externalId: string; kind: 'phase_progress' | 'phase_completed' | 'material_progress' | 'permission' | 'attention' | 'runtime_health' | 'transport_uncertainty'; summary: string; urgency: 'normal' | 'urgent'; sampleBucket?: number };
export type AcpResultFact = { externalId: string; taskId: string; status: 'candidate' | 'failed' | 'unknown'; summary: string; evidenceRefs?: string[]; expectedFence?: number; sourceId: string };

function record(value: unknown): Record<string, any> { return value && typeof value === 'object' ? value as Record<string, any> : {}; }
function result(value: unknown): CliResult { return { value, stdout: '', stderr: '' }; }
function handoff(context?: RuntimeLaunchContext): string {
  if (!context?.workspaceId || !context.taskId || !context.runtimeId) return '';
  return `\n\nARCP Worker handoff: workspace ${context.workspaceId}, task ${context.taskId}, runtime ${context.runtimeId}. Claim with \`arcp task claim ${context.taskId} --runtime ${context.runtimeId} --expected-fence 0\`. Report durable learning with \`arcp knowledge add ${context.workspaceId} --runtime ${context.runtimeId} --kind learning --text '<learning>'\` and submit the candidate with \`arcp result submit ${context.workspaceId} --runtime ${context.runtimeId} --task ${context.taskId} --summary '<summary>' --expected-fence 1\`.`;
}

/** Small real ACP transport for Hermes. It creates a sibling on-call Runtime;
 * it never attaches to the operator's existing Feishu Hermes conversation. */
export class HermesAcpAdapter implements RuntimeAdapter {
  readonly adapterId = 'hermes-acp';
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<(event: SafePointEvent) => void>();
  private readonly factListeners = new Set<(fact: ChannelFact) => void>();
  private readonly resultListeners = new Set<(fact: AcpResultFact) => void>();
  constructor(private readonly spawnProcess: SpawnFn = ((command, args, options) => spawn(command, args, options) as ApcProcess)) {}

  onSafePoint(listener: (event: SafePointEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onFact(listener: (fact: ChannelFact) => void): () => void { this.factListeners.add(listener); return () => this.factListeners.delete(listener); }
  onResult(listener: (fact: AcpResultFact) => void): () => void { this.resultListeners.add(listener); return () => this.resultListeners.delete(listener); }
  private emit(event: SafePointEvent): void { for (const listener of this.listeners) listener(event); }
  private setState(externalId: string, session: Session, state: Session['status'], turnState?: string): void {
    session.status = state; if (turnState) session.lastTurnState = turnState.includes('permission') || turnState.includes('requires_action') || state === 'attention' ? 'requires_action' : state === 'idle' ? 'idle' : 'running';
    if (state !== 'running') this.emit({ externalId, ...(session.lastDeliveryId ? { deliveryId: session.lastDeliveryId } : {}), state });
  }
  private wire(externalId: string, session: Session): void {
    let buffered = '';
    session.process.stdout.on('data', (chunk) => {
      buffered += String(chunk);
      while (true) {
        const newline = buffered.indexOf('\n'); if (newline < 0) break;
        const line = buffered.slice(0, newline).trim(); buffered = buffered.slice(newline + 1);
        if (!line) continue;
        let message: JsonRpcMessage; try { message = JSON.parse(line); } catch { continue; }
        if (typeof message.id === 'number' && (message.result !== undefined || message.error)) {
          const pending = session.pending.get(message.id); if (!pending) continue; session.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error.message || 'Hermes ACP request failed')); else pending.resolve(message.result);
          continue;
        }
        if (message.method === 'session/update') this.onUpdate(session.externalId ?? externalId, session, record(message.params?.update));
        if (message.method === 'session/request_permission') { this.setState(session.externalId ?? externalId, session, 'attention', 'requires_action'); this.emitFact({ externalId: session.externalId ?? externalId, kind: 'permission', urgency: 'urgent', summary: 'Hermes ACP requested permission' }, session); }
      }
    });
    session.process.stderr.on('data', () => undefined);
    session.process.on('close', () => {
      for (const pending of session.pending.values()) pending.reject(new Error('Hermes ACP process exited'));
      session.pending.clear(); if (session.status !== 'terminal') { this.setState(externalId, session, 'terminal', 'running'); this.emitFact({ externalId, kind: 'runtime_health', urgency: 'urgent', summary: 'Hermes ACP process exited unexpectedly' }, session); this.emitFact({ externalId, kind: 'transport_uncertainty', urgency: 'urgent', summary: 'Hermes ACP transport is uncertain after process exit' }, session); }
    });
  }
  private onUpdate(externalId: string, session: Session, update: Record<string, any>): void {
    const kind = String(update.sessionUpdate ?? update.type ?? update.status ?? '').toLowerCase();
    const resultFact = record(update.result);
    if (resultFact.taskId && ['candidate', 'failed', 'unknown'].includes(String(resultFact.status))) for (const listener of this.resultListeners) listener({ externalId, taskId: String(resultFact.taskId), status: String(resultFact.status) as AcpResultFact['status'], summary: String(resultFact.summary ?? ''), sourceId: String(resultFact.resultId ?? resultFact.id ?? `acp:${externalId}:${resultFact.taskId}:${resultFact.expectedFence ?? ''}:${resultFact.status}:${resultFact.summary ?? ''}`), ...(Array.isArray(resultFact.evidenceRefs) ? { evidenceRefs: resultFact.evidenceRefs.map(String) } : {}), ...(typeof resultFact.expectedFence === 'number' ? { expectedFence: resultFact.expectedFence } : {}) });
    if (kind) session.timeline.push({ type: kind, timestamp: new Date().toISOString() });
    if (kind.includes('error') || kind.includes('permission') || kind.includes('requires_action')) this.setState(externalId, session, 'attention', 'requires_action');
    else if (kind.includes('complete') || kind.includes('idle') || kind === 'turn_end' || kind === 'prompt_end') this.setState(externalId, session, 'idle', kind);
    else if (kind.includes('close') || kind.includes('terminal') || kind.includes('exit')) this.setState(externalId, session, 'terminal', kind);
    else if (kind) this.setState(externalId, session, 'running', kind);
    if (kind.includes('complete') || kind === 'turn_end' || kind === 'prompt_end') this.emitFact({ externalId, kind: 'phase_completed', urgency: 'normal', summary: 'Hermes ACP phase completed' }, session);
    else if (kind.includes('plan')) this.emitFact({ externalId, kind: 'phase_progress', urgency: 'normal', summary: 'Hermes ACP phase progress' }, session);
    else if (kind.includes('permission') || kind.includes('requires_action')) this.emitFact({ externalId, kind: 'attention', urgency: 'urgent', summary: 'Hermes ACP requires attention' }, session);
    else if (kind.includes('error')) this.emitFact({ externalId, kind: 'transport_uncertainty', urgency: 'urgent', summary: 'Hermes ACP transport is uncertain' }, session);
    else if (kind && !kind.includes('complete') && !kind.includes('idle')) this.emitFact({ externalId, kind: kind.includes('tool') || kind.includes('message') || kind.includes('usage') ? 'material_progress' : 'phase_progress', urgency: 'normal', summary: 'Hermes ACP runtime progress' }, session);
  }
  private emitFact(fact: ChannelFact, session?: Session): void { const key = `${fact.externalId}:${fact.kind}:${fact.summary}`; const nowMs = Date.now(); if (session && session.lastFactKey === key && (session.lastFactAt ?? 0) + 30_000 > nowMs) return; if (session) { session.lastFactKey = key; session.lastFactAt = nowMs; } for (const listener of this.factListeners) listener({ ...fact, sampleBucket: Math.floor(nowMs / 60_000) }); }
  private request(externalId: string, session: Session, method: string, params: Record<string, any>, timeoutMs = 30_000): Promise<any> {
    const id = session.nextId++;
    const request = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { session.pending.delete(id); reject(new Error('Hermes ACP request timed out')); }, timeoutMs); timer.unref();
      session.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    });
    session.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return request;
  }
  private async connected(cwd: string, context?: RuntimeLaunchContext): Promise<{ externalId: string; session: Session }> {
    const child = this.spawnProcess('hermes', ['acp', '--accept-hooks'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env as Record<string, string>, ...(context?.clientStatePath ? { ARCP_CLIENT_STATE: context.clientStatePath } : {}) } });
    const session: Session = { process: child, nextId: 1, pending: new Map(), status: 'idle', timeline: [] };
    const temporaryId = `pending-${process.pid}-${Date.now()}`; this.wire(temporaryId, session);
    await this.request(temporaryId, session, 'initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'arcp', version: '0.1.0' } });
    const created = record(await this.request(temporaryId, session, 'session/new', { cwd, mcpServers: [] }));
    const externalId = String(created.sessionId ?? created.id ?? ''); if (!externalId) { child.kill('SIGTERM'); throw new Error('Hermes ACP did not return a session id'); }
    session.externalId = externalId; this.sessions.set(externalId, session); return { externalId, session };
  }
  discover(): Promise<CliResult> { return Promise.resolve(result([{ provider: 'hermes', status: 'available', enabled: true, modes: ['default', 'accept_edits', 'dont_ask'] }])); }
  models(provider: string): Promise<CliResult> { return Promise.resolve(result(provider === 'hermes' ? [{ id: 'hermes-agent' }] : [])); }
  modes(provider: string): Promise<string[] | undefined> { return Promise.resolve(provider === 'hermes' ? ['default', 'accept_edits', 'dont_ask'] : []); }
  async launch(_profile: Profile, _goalTitle: string, workspace?: string, context?: RuntimeLaunchContext): Promise<CliResult> {
    const connected = await this.connected(workspace || process.cwd(), context); connected.session.context = context; return result({ id: connected.externalId, acpSessionId: connected.externalId, pid: connected.session.process.pid });
  }
  observe(externalId: string): Promise<CliResult> {
    const session = this.sessions.get(externalId); if (!session) return Promise.reject(new Error('Hermes ACP session is unavailable'));
    return Promise.resolve(result({ id: externalId, status: session.status, activeTurn: session.status === 'running', provider: 'hermes', model: 'hermes-agent', lastTurnState: session.lastTurnState }));
  }
  snapshot(externalId: string): Promise<{ agent: Record<string, any>; timeline: unknown[]; source: 'sdk' | 'cli' }> {
    const session = this.sessions.get(externalId); if (!session) return Promise.reject(new Error('Hermes ACP session is unavailable'));
    return Promise.resolve({ agent: { id: externalId, status: session.status, activeTurn: session.status === 'running', provider: 'hermes', model: 'hermes-agent', lastTurnState: session.lastTurnState }, timeline: session.timeline.slice(-100), source: 'cli' });
  }
  registry(): Promise<CliResult> { return Promise.resolve(result([...this.sessions].map(([id, session]) => ({ id, status: session.status })))); }
  providerSubagents(_parentAgentId: string): Promise<ChildObservation> { return Promise.resolve({ source: 'none', items: [] }); }
  async startTurn(externalId: string, body: string, deliveryId: string): Promise<CliResult> {
    const session = this.sessions.get(externalId); if (!session) throw new Error('Hermes ACP session is unavailable');
    if (session.lastDeliveryId === deliveryId && session.status === 'running') return result({ id: deliveryId, duplicate: true });
    const firstDelivery = session.lastDeliveryId === undefined; session.lastDeliveryId = deliveryId; this.setState(externalId, session, 'running', 'prompt_started');
    await this.request(externalId, session, 'session/prompt', { sessionId: externalId, prompt: [{ type: 'text', text: body + (firstDelivery ? handoff(session.context) : '') }] }, 10 * 60_000);
    if (session.status === 'running') this.setState(externalId, session, 'idle', 'prompt_completed');
    return result({ id: deliveryId });
  }
  async interrupt(externalId: string, _body: string): Promise<CliResult> {
    const session = this.sessions.get(externalId); if (!session) throw new Error('Hermes ACP session is unavailable');
    await this.request(externalId, session, 'session/cancel', { sessionId: externalId }); this.setState(externalId, session, 'idle', 'idle'); return result({ id: externalId, cancelled: true });
  }
  async stop(externalId: string): Promise<CliResult> {
    const session = this.sessions.get(externalId); if (!session) return result({ id: externalId, stopped: false });
    try { await this.request(externalId, session, 'session/close', { sessionId: externalId }, 5_000); } catch { /* process termination is the final stop */ }
    session.status = 'terminal'; session.process.kill('SIGTERM'); this.sessions.delete(externalId); return result({ id: externalId, stopped: true });
  }
  async reconcileExternal(externalId: string): Promise<boolean> { const session = this.sessions.get(externalId); if (!session) return false; return session.process.exitCode === null; }
}

/** ACP is the wire for the same Channel semantics, never a second scheduler. */
export class AcpChannelAdapter implements ChannelAdapter {
  readonly channelId = 'acp-channel';
  readonly adapterId = 'hermes-acp';
  constructor(private readonly runtime: RuntimeAdapter) {}
  discover() { return this.runtime.discover(); }
  models(provider: string) { return this.runtime.models(provider); }
  modes(provider: string) { return this.runtime.modes(provider); }
  launch(profile: Profile, goalTitle: string, workspace?: string, context?: RuntimeLaunchContext) { return this.runtime.launch(profile, goalTitle, workspace, context); }
  observe(externalId: string) { return this.runtime.observe(externalId); }
  snapshot(externalId: string) { return this.runtime.snapshot(externalId); }
  registry() { return this.runtime.registry(); }
  providerSubagents(parentAgentId: string) { return this.runtime.providerSubagents(parentAgentId); }
  startTurn(externalId: string, body: string, deliveryId: string) { return this.runtime.startTurn(externalId, body, deliveryId); }
  interrupt(externalId: string, body: string) { return this.runtime.interrupt(externalId, body); }
  stop(externalId: string) { return this.runtime.stop(externalId); }
  async sendEvent(event: ChannelEvent, externalId: string, deliveryId: string, body: string): Promise<void> { await this.runtime.startTurn(externalId, body, deliveryId); }
}
