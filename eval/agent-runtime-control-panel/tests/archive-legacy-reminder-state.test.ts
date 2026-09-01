import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const script = path.join(process.cwd(), '../scripts/archive-legacy-reminder-state');

async function legacyState() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'legacy-reminder-'));
  await writeFile(path.join(root, 'reminders.json'), JSON.stringify([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]));
  await writeFile(path.join(root, 'tracked-children.json'), JSON.stringify({ 'child-a': {}, 'child-b': {} }));
  await writeFile(path.join(root, 'ledger-resolved.jsonl'), '{"id":"l1"}\n{"id":"l2"}\n');
  return root;
}

async function run(source: string, destination: string) {
  const { stdout } = await execFileAsync(process.execPath, [script, '--data', source, '--out', destination]);
  return JSON.parse(stdout);
}

describe('one-time legacy reminder state archive', () => {
  it('copies every record and leaves the source directory intact', async () => {
    const source = await legacyState();
    const destination = path.join(await mkdtemp(path.join(os.tmpdir(), 'legacy-archive-')), 'archive');
    const summary = await run(source, destination);

    // Catches a mutation that archives by moving/renaming, or that unlinks the
    // source after copying: legacy reminder records are live user data and
    // deletion stays Owner-gated.
    expect((await readdir(source)).sort()).toEqual(['ledger-resolved.jsonl', 'reminders.json', 'tracked-children.json']);
    expect(summary.sourceRetained).toBe(true);
    expect(summary.files).toBe(3);
    // 3 reminders + 2 tracked children + 2 ledger lines. Catches a mutation
    // that counts files instead of records, or skips the .jsonl sidecar.
    expect(summary.totalRecords).toBe(7);

    const manifest = JSON.parse(await readFile(path.join(destination, 'MANIFEST.json'), 'utf8'));
    expect(manifest.files.map((file: any) => [file.name, file.records])).toEqual([
      ['ledger-resolved.jsonl', 2], ['reminders.json', 3], ['tracked-children.json', 2],
    ]);
    // Catches a mutation that reports a digest of anything other than the bytes
    // actually written, which would make a corrupted archive look verified.
    for (const file of manifest.files) {
      const archived = await readFile(path.join(destination, file.name));
      expect(createHash('sha256').update(archived).digest('hex')).toBe(file.sha256);
      expect(archived).toEqual(await readFile(path.join(source, file.name)));
    }
  });

  it('refuses to overwrite an existing archive or to write inside the source', async () => {
    const source = await legacyState();
    const destination = path.join(await mkdtemp(path.join(os.tmpdir(), 'legacy-archive-')), 'archive');
    const first = await run(source, destination);
    const firstManifest = await readFile(path.join(destination, 'MANIFEST.json'), 'utf8');

    // Catches a mutation that drops the existing-destination guard and silently
    // rewrites a previously verified archive.
    await expect(execFileAsync(process.execPath, [script, '--data', source, '--out', destination]))
      .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('--out already exists') });
    expect(await readFile(path.join(destination, 'MANIFEST.json'), 'utf8')).toBe(firstManifest);
    expect(first.archive).toBe(destination);

    // Catches a mutation that allows the archive to be written into the state
    // directory it is archiving, which would make the copy self-referential.
    await expect(execFileAsync(process.execPath, [script, '--data', source, '--out', path.join(source, 'archive')]))
      .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('--out must be outside --data') });
  });
});
