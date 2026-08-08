#!/usr/bin/env node
const args = process.argv.slice(2);
const out = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === 'ls') out([{ id: 'candidate-1', status: 'idle' }, { id: 'candidate-2', status: 'idle' }]);
else if (args[0] === 'inspect' && args[1] === 'candidate-1') out({ Id: 'candidate-1', ParentAgentId: 'manager-1', Status: 'idle', UpdatedAt: '2026-08-08T00:00:00.000Z', Cwd: process.cwd() });
else if (args[0] === 'inspect') process.exit(1);
else if (args[0] === 'heartbeat' && args[1] === 'create') out({ id: 'unexpected-heartbeat', status: 'active' });
else if (args[0] === 'heartbeat' && args[1] === 'update') out({ id: args[2], status: 'active' });
else out({ ok: true });
