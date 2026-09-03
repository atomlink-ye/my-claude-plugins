import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQLiteStateStore } from '../../../../skills/agent-runtime-control-panel/runtime/src/state-store.js';

const root = () => mkdtemp(path.join(os.tmpdir(), 'arcp-document-store-'));

const revision = (id: string, documentId: string, n: number, body: string) => ({
  id, documentId, workspaceId: 'workspace-1', revision: n, authorMemberId: 'member-1',
  body, bytes: Buffer.byteLength(body, 'utf8'), contentHash: `hash-${id}`, createdAt: '2026-01-01T00:00:00.000Z',
});

describe('DocumentArtifact persistence', () => {
  it('round-trips documents and their revisions through SQLite, bodies intact', async () => {
    const dir = await root(); const store = new SQLiteStateStore(dir); await store.init();
    await store.mutate((state) => {
      state.documents.push({ id: 'document-1', workspaceId: 'workspace-1', kind: 'contract', title: 'c', authorMemberId: 'member-1', latestRevision: 2, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z' });
      state.documentRevisions.push(revision('revision-1', 'document-1', 1, 'first\n'), revision('revision-2', 'document-1', 2, 'second\n'));
    });
    store.close();

    const reopened = new SQLiteStateStore(dir); await reopened.init();
    const state = reopened.snapshot();
    expect(state.documents).toHaveLength(1);
    expect(state.documents[0]).toMatchObject({ id: 'document-1', latestRevision: 2 });
    expect(state.documentRevisions.map((item) => item.body)).toEqual(['first\n', 'second\n']);
    reopened.close();
  });

  it('enforces append-only numbering in storage, not only in application code', async () => {
    const dir = await root(); const store = new SQLiteStateStore(dir); await store.init();
    await store.mutate((state) => {
      state.documents.push({ id: 'document-1', workspaceId: 'workspace-1', kind: 'note', title: 'n', authorMemberId: 'member-1', latestRevision: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
      state.documentRevisions.push(revision('revision-1', 'document-1', 1, 'body\n'));
    });
    const file = store.file;
    store.close();

    // A second row claiming revision 1 of the same document is refused by the
    // database itself, so a bug upstream cannot quietly renumber history.
    const db = new DatabaseSync(file);
    expect(() => db.prepare('INSERT INTO document_revisions(id, payload) VALUES (?, ?)')
      .run('revision-duplicate', JSON.stringify(revision('revision-duplicate', 'document-1', 1, 'rewritten\n'))))
      .toThrow(/UNIQUE/i);
    db.close();
  });
});
