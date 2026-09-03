import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ArcpService } from '../../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { HermesAcpAdapter } from '../../../../skills/agent-runtime-control-panel/runtime/src/hermes-acp.js';
import { HermesChannelAdapter } from '../../../../skills/agent-runtime-control-panel/runtime/src/actor-channel.js';
import { FakePaseoCli } from '../support/fake-paseo-cli.js';

/**
 * A real, spawnable-shaped Hermes ACP process double. Unlike a stub that
 * fakes `RuntimeAdapter.startTurn` directly, this answers the same
 * JSON-RPC framing the real `hermes acp` binary speaks over stdio, so the
 * assertions below exercise the actual `session/prompt` wire contract
 * rather than an interface-level mock.
 */
class FakeAcpProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  readonly prompts: Array<{ sessionId: string; text: string }> = [];
  constructor() {
    super();
    this.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const request = JSON.parse(line);
        if (request.method === 'initialize') this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } })}\n`);
        else if (request.method === 'session/new') this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'acp-session-owner-1' } })}\n`);
        else if (request.method === 'session/prompt') {
          this.prompts.push({ sessionId: request.params.sessionId, text: request.params.prompt[0].text });
          this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: request.params.sessionId, update: { sessionUpdate: 'prompt_end' } } })}\n`);
          this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`);
        }
      }
    });
  }
  kill(): boolean { this.emit('close'); return true; }
}

describe('Hermes ACP owner channel integration', () => {
  it('delivers an Owner escalation as a real ACP session/prompt turn and returns an accepted receipt to ARCP', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-hermes-acp-owner-'));
    const process = new FakeAcpProcess();
    const acpAdapter = new HermesAcpAdapter(() => process as any);
    // Mint the Owner's opaque ACP session the same way production does: by
    // actually connecting through the ACP handshake, never by inventing an id.
    const launched = await acpAdapter.launch({ id: 'hermes-acp', provider: 'hermes', model: 'hermes-agent', role: 'worker' } as any, 'owner on-call', '.');
    const acpSessionId = String((launched.value as any).id);
    expect(acpSessionId).toBe('acp-session-owner-1');

    const service = new ArcpService(root, new FakePaseoCli() as any, undefined, undefined, [acpAdapter]);
    await service.init();
    // Startup wired the shipped 'hermes' channel straight to the ACP runtime
    // adapter with no explicit transport installed, so nothing here can reach
    // a human chat: this is the only wire the Owner channel has.
    expect(service.channelDiscovery()).toContainEqual({ adapterId: 'hermes', configured: true, available: true });
    expect(service.channels.get('hermes')).toBeInstanceOf(HermesChannelAdapter);

    const { actor } = await service.registerActor({ clientIdentity: 'owner-deputy-acp' });
    // The Owner's binding targets the exact opaque ACP session id ARCP just
    // observed from the handshake above, never a chat id or a private path.
    await service.rebindActor({ actorId: actor.id, channel: 'hermes' as any, conversationRef: acpSessionId });
    const workspace = await service.createWorkspace({ purpose: 'hermes acp owner channel', ownerActorId: actor.id });
    const worker = await service.joinWorkspace({ workspaceId: workspace.workspace.id, label: 'Worker', role: 'worker' });
    const task = await service.createTask({ workspaceId: workspace.workspace.id, title: 'unit of work' });
    await service.claimTask(task.id, worker.member.id, task.fence);
    const result = await service.submitResult({ workspaceId: workspace.workspace.id, taskId: task.id, memberId: worker.member.id, status: 'candidate', summary: 'candidate awaiting a decision', expectedFence: task.fence + 1 });
    const decision = service.state().channelEvents.find((event) => event.kind === 'decision_required' && event.resultId === result.id)!;

    const escalated = await service.escalateToOwnerActor({ eventId: decision.id, reason: 'Manager ACK SLA expired' });

    // The receipt ARCP records comes back from a real ACP turn, not a stub.
    expect(escalated.receipt?.state).toBe('accepted');
    expect(service.state().channelEvents.find((event) => event.id === escalated.event.id)?.deliveryState).toBe('delivered');

    // Exactly one real session/prompt turn, addressed to the exact opaque ACP
    // session id, carrying no chat id or private path.
    expect(process.prompts).toHaveLength(1);
    expect(process.prompts[0].sessionId).toBe(acpSessionId);
    expect(process.prompts[0].text).toContain('[ARCP escalation]');
    expect(process.prompts[0].text).not.toMatch(/oc_|om_|feishu|lark|\/(Users|home)\//i);

    // A retried escalation must not open a second ACP turn.
    await service.escalateToOwnerActor({ eventId: decision.id, reason: 'Manager ACK SLA expired' });
    expect(process.prompts).toHaveLength(1);
    service.close();
  });
});
