import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArcpService } from '../../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { artifactRefFor, diffDocumentLines, formatArtifactRef, parseArtifactRef, resolveArtifactRef, DOCUMENT_BODY_LIMIT } from '../../../../skills/agent-runtime-control-panel/runtime/src/document.js';
import { documentAddress } from '../../../../skills/agent-runtime-control-panel/runtime/src/content.js';
import { publicSession } from '../../../../skills/agent-runtime-control-panel/runtime/src/arcp-server.js';

class FakeCli {
  async run(args: string[]) {
    if (args[0] === 'provider' && args[1] === 'ls') return { value: [{ provider: 'codex', status: 'available', enabled: true, modes: ['auto'] }], stdout: '', stderr: '' };
    if (args[0] === 'provider' && args[1] === 'models') return { value: [{ id: 'gpt-5.6-terra', thinkingOptionIds: ['medium'] }], stdout: '', stderr: '' };
    if (args[0] === 'inspect') return { value: { id: 'worker-live', status: 'idle', provider: 'codex', model: 'gpt-5.6-terra', mode: 'auto', thinking: 'medium' }, stdout: '', stderr: '' };
    if (args[0] === 'run') return { value: { id: 'worker-live' }, stdout: '', stderr: '' };
    return { value: [], stdout: '', stderr: '' };
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arcp-document-artifact-'));
  const service = new ArcpService(root, new FakeCli() as any);
  await service.init();
  const { actor } = await service.registerActor({ clientIdentity: 'document-owner' });
  const created = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'document artifacts' });
  return { service, actor, workspace: created.workspace, member: created.member };
}

describe('DocumentArtifact — identity, append-only revisions, and exact refs', () => {
  it('addresses a revision by its own exact UTF-8 bytes, independently of the channel envelope hash', async () => {
    const { service, workspace, member } = await fixture();
    const body = '# Contract\n\nOwn exactly `src/x.ts`.\n';
    const created = await service.createDocument({ workspaceId: workspace.id, memberId: member.id, kind: 'contract', title: 'Worker contract', body });

    expect(created.revision.revision).toBe(1);
    expect(created.revision.contentHash).toBe(documentAddress(body));
    expect(created.revision.bytes).toBe(Buffer.byteLength(body, 'utf8'));
    expect(created.ref).toBe(`arcp://doc/${created.document.id}@1#sha256:${documentAddress(body)}`);
    service.close();
  });

  it('appends a revision without mutating the previous one, so a ref handed out earlier still names the same bytes', async () => {
    const { service, workspace, member } = await fixture();
    const first = await service.createDocument({ workspaceId: workspace.id, memberId: member.id, kind: 'contract', title: 'c', body: 'original\n' });
    const second = await service.reviseDocument({ documentId: first.document.id, memberId: member.id, body: 'revised\n' });

    expect(second.revision.revision).toBe(2);
    expect(second.document.latestRevision).toBe(2);
    // The original ref must still resolve to the original bytes.
    const resolved = service.resolveDocumentRef(first.ref);
    expect(resolved.status).toBe('verified');
    expect(resolved.status === 'verified' && resolved.revision.body).toBe('original\n');
    expect(service.showDocument(first.document.id).revision.body).toBe('revised\n');
    service.close();
  });

  it('refuses an empty body and a body over the size cap, so a document cannot become unbounded state smuggling', async () => {
    const { service, workspace, member } = await fixture();
    await expect(service.createDocument({ workspaceId: workspace.id, memberId: member.id, kind: 'note', title: 't', body: '   ' }))
      .rejects.toMatchObject({ code: 'invalid_request', field: 'body' });
    await expect(service.createDocument({ workspaceId: workspace.id, memberId: member.id, kind: 'note', title: 't', body: 'x'.repeat(DOCUMENT_BODY_LIMIT + 1) }))
      .rejects.toMatchObject({ code: 'invalid_request', field: 'body' });
    service.close();
  });

  it('refuses an unknown kind and an empty title', async () => {
    const { service, workspace, member } = await fixture();
    await expect(service.createDocument({ workspaceId: workspace.id, memberId: member.id, kind: 'manifesto', title: 't', body: 'x' }))
      .rejects.toMatchObject({ code: 'invalid_request', field: 'kind' });
    await expect(service.createDocument({ workspaceId: workspace.id, memberId: member.id, kind: 'note', title: '  ', body: 'x' }))
      .rejects.toMatchObject({ code: 'invalid_request', field: 'title' });
    service.close();
  });

  it('scopes documents to their workspace: a member of another workspace cannot author into this one', async () => {
    const { service, actor, workspace, member } = await fixture();
    const other = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'other' });
    await expect(service.createDocument({ workspaceId: workspace.id, memberId: other.member.id, kind: 'note', title: 't', body: 'x' }))
      .rejects.toMatchObject({ code: 'unauthorized' });
    const mine = await service.createDocument({ workspaceId: workspace.id, memberId: member.id, kind: 'note', title: 't', body: 'x' });
    await expect(service.reviseDocument({ documentId: mine.document.id, memberId: other.member.id, body: 'y' }))
      .rejects.toMatchObject({ code: 'unauthorized' });
    service.close();
  });

  it('lists metadata without bodies and filters by kind', async () => {
    const { service, workspace, member } = await fixture();
    await service.createDocument({ workspaceId: workspace.id, memberId: member.id, kind: 'contract', title: 'a', body: 'a\n' });
    await service.createDocument({ workspaceId: workspace.id, memberId: member.id, kind: 'report', title: 'b', body: 'b\n' });

    const all = service.listDocuments(workspace.id);
    expect(all).toHaveLength(2);
    expect(all.every((item) => !('body' in item))).toBe(true);
    expect(service.listDocuments(workspace.id, 'contract').map((item) => item.title)).toEqual(['a']);
    service.close();
  });

  it('diffs two revisions as added and removed lines', async () => {
    const { service, workspace, member } = await fixture();
    const created = await service.createDocument({ workspaceId: workspace.id, memberId: member.id, kind: 'note', title: 'n', body: 'keep\ndrop\n' });
    await service.reviseDocument({ documentId: created.document.id, memberId: member.id, body: 'keep\nadd\n' });

    const { diff } = service.diffDocument(created.document.id, 1, 2);
    expect(diff.split('\n')).toEqual(expect.arrayContaining([' keep', '-drop', '+add']));
    service.close();
  });

  it('refuses to resolve a ref that does not survive verification, and distinguishes why', async () => {
    const { service, workspace, member } = await fixture();
    const created = await service.createDocument({ workspaceId: workspace.id, memberId: member.id, kind: 'contract', title: 'c', body: 'authority\n' });
    const parts = parseArtifactRef(created.ref)!;

    expect(service.resolveDocumentRef('not-a-ref').status).toBe('malformed');
    expect(service.resolveDocumentRef(formatArtifactRef({ ...parts, documentId: 'document_absent' })).status).toBe('unknown_document');
    expect(service.resolveDocumentRef(formatArtifactRef({ ...parts, revision: 7 })).status).toBe('unknown_revision');
    // A ref naming a real revision but the wrong bytes is the dangerous case:
    // someone made a specific claim and it is false.
    expect(service.resolveDocumentRef(formatArtifactRef({ ...parts, contentHash: documentAddress('different\n') })).status).toBe('hash_mismatch');
    expect(service.resolveDocumentRef(created.ref).status).toBe('verified');
    service.close();
  });

  it('verifies against the body itself, so a tampered stored hash cannot vouch for its own row', async () => {
    const { service, workspace, member } = await fixture();
    const created = await service.createDocument({ workspaceId: workspace.id, memberId: member.id, kind: 'contract', title: 'c', body: 'real authority\n' });
    const forged = { ...created.revision, body: 'swapped authority\n' };

    // The row still carries the original hash, and its ref still claims it.
    expect(resolveArtifactRef(artifactRefFor(forged), [forged]).status).toBe('hash_mismatch');
    service.close();
  });

  it('rejects malformed refs rather than repairing them', () => {
    expect(parseArtifactRef('arcp://doc/d@0#sha256:' + 'a'.repeat(64))).toBeUndefined();
    expect(parseArtifactRef('arcp://doc/d@1#sha256:tooshort')).toBeUndefined();
    expect(parseArtifactRef('arcp://doc/d@1')).toBeUndefined();
    expect(parseArtifactRef(`arcp://doc/d@2#sha256:${'a'.repeat(64)}`)).toMatchObject({ documentId: 'd', revision: 2 });
  });

  it('diffs identical bodies to context lines only', () => {
    expect(diffDocumentLines('same\n', 'same\n')).toBe(' same\n ');
  });
});

describe('Launch binding to an exact contract revision', () => {
  it('projects the contract binding evidence over HTTP, since a ref a reader cannot see proves nothing', async () => {
    const { service, actor, workspace, member } = await fixture();
    const contract = await service.createDocument({ workspaceId: workspace.id, memberId: member.id, kind: 'contract', title: 'c', body: 'authority\n' });
    const started: any = await service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'g', contractDocumentRef: contract.ref, profileId: 'codex-worker', workspace: '/tmp' } as any);

    const projected: any = publicSession(started.session);
    expect(projected.contractRef).toBe(contract.ref);
    expect(projected.contractBoundAtLaunch).toBe(true);
    service.close();
  });

  it('binds a launch to a verified revision, records the ref durably, and hands the runtime the exact bytes', async () => {
    const { service, actor, workspace, member } = await fixture();
    const body = '# Goal Contract\n\nOwn exactly `src/x.ts`.\n';
    const contract = await service.createDocument({ workspaceId: workspace.id, memberId: member.id, kind: 'contract', title: 'worker contract', body });

    const started: any = await service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'document-bound goal', contractDocumentRef: contract.ref, profileId: 'codex-worker', workspace: '/tmp' } as any);

    expect(started.session.contractRef).toBe(contract.ref);
    // The asserted flag still travels too: the runtime really did receive text.
    expect(started.session.contractBoundAtLaunch).toBe(true);
    // And the ref on the session re-resolves to the exact authored bytes.
    const resolved = service.resolveDocumentRef(started.session.contractRef);
    expect(resolved.status === 'verified' && resolved.revision.body).toBe(body);
    service.close();
  });

  it('refuses a launch whose contract ref does not verify, and creates nothing', async () => {
    const { service, actor, workspace, member } = await fixture();
    const contract = await service.createDocument({ workspaceId: workspace.id, memberId: member.id, kind: 'contract', title: 'c', body: 'real\n' });
    const parts = parseArtifactRef(contract.ref)!;
    const tampered = formatArtifactRef({ ...parts, contentHash: documentAddress('forged\n') });

    const goalsBefore = service.state().goals.length;
    const sessionsBefore = service.state().sessions.length;
    await expect(service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'forged', contractDocumentRef: tampered, profileId: 'codex-worker', workspace: '/tmp' } as any))
      .rejects.toMatchObject({ code: 'invalid_request', field: 'contractDocumentRef' });

    // Fail closed means nothing durable was created under an unverifiable claim.
    expect(service.state().goals).toHaveLength(goalsBefore);
    expect(service.state().sessions).toHaveLength(sessionsBefore);
    service.close();
  });

  it('refuses a contract document belonging to another workspace', async () => {
    const { service, actor, workspace } = await fixture();
    const other = await service.createWorkspace({ ownerActorId: actor.id, purpose: 'other' });
    const foreign = await service.createDocument({ workspaceId: other.workspace.id, memberId: other.member.id, kind: 'contract', title: 'c', body: 'foreign\n' });

    await expect(service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'cross', contractDocumentRef: foreign.ref, profileId: 'codex-worker', workspace: '/tmp' } as any))
      .rejects.toMatchObject({ code: 'unauthorized', field: 'contractDocumentRef' });
    service.close();
  });

  it('leaves a raw --contract launch exactly as it was: bound and asserted, but with no ref to verify', async () => {
    const { service, actor, workspace } = await fixture();
    const started: any = await service.startManaged({ actorId: actor.id, workspaceId: workspace.id, title: 'raw contract', contract: 'own exactly src/x.ts', profileId: 'codex-worker', workspace: '/tmp' } as any);

    expect(started.session.contractBoundAtLaunch).toBe(true);
    expect(started.session.contractRef).toBeUndefined();
    service.close();
  });
});
