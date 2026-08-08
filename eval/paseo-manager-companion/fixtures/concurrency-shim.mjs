#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const stateDir = process.env.PASEO_CONCURRENCY_STATE;
const activeDir = path.join(stateDir, 'active');
fs.mkdirSync(activeDir, { recursive: true });
const args = process.argv.slice(2);
const out = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === 'ls') {
  out(Array.from({ length: 20 }, (_, i) => ({ id: `candidate-${i + 1}`, status: 'idle' })));
} else if (args[0] === 'inspect') {
  const id = args[1];
  const token = path.join(activeDir, `${process.pid}-${id}`);
  fs.writeFileSync(token, '1', { flag: 'wx' });
  const tooMany = fs.readdirSync(activeDir).length > 8;
  const forcedFailure = process.env.PASEO_CONCURRENCY_FAIL === id;
  setTimeout(() => {
    fs.rmSync(token, { force: true });
    if (tooMany || forcedFailure) process.exit(1);
    out({ Id: id, ParentAgentId: 'manager-1', Status: 'idle', UpdatedAt: '2026-08-08T00:00:00.000Z', Cwd: process.cwd() });
  }, 40);
} else if (args[0] === 'heartbeat' && args[1] === 'update') {
  out({ id: args[2], status: 'active' });
} else {
  out({ ok: true });
}
