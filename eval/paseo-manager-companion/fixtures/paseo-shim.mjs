#!/usr/bin/env node
import fs from 'node:fs';
const stateFile = process.env.PASEO_SHIM_STATE;
const state = stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { heartbeats: {}, agents: {} };
const save = () => stateFile && fs.writeFileSync(stateFile, JSON.stringify(state));
const args = process.argv.slice(2);
const out = (value) => { process.stdout.write(JSON.stringify(value)); save(); };
const agentId = process.env.PASEO_AGENT_ID || 'manager-1';
if (args[0] === 'ls') {
  out(Object.values(state.agents).map((a) => ({ id: a.id, shortId: a.id, status: a.status, cwd: a.cwd })));
} else if (args[0] === 'inspect') {
  const id = args[1];
  const a = state.agents[id] || { id, ParentAgentId: 'manager-1', Status: 'idle', UpdatedAt: '2026-08-08T00:00:00.000Z', Cwd: process.cwd() };
  out(a);
} else if (args[0] === 'run') {
  const id = `child-${Object.keys(state.agents).length + 1}`;
  state.agents[id] = { Id: id, id, agentId: id, ParentAgentId: agentId, Status: 'running', UpdatedAt: '2026-08-08T00:00:00.000Z', Cwd: args[args.indexOf('--cwd') + 1] || process.cwd(), Worktree: process.cwd() };
  out({ agentId: id, status: 'running', provider: 'shim', cwd: state.agents[id].Cwd });
} else if (args[0] === 'heartbeat' && args[1] === 'create') {
  const id = `hb-${Object.keys(state.heartbeats).length + 1}`;
  state.heartbeats[id] = { id, status: 'active', nextRunAt: '2026-08-08T00:05:00.000Z', lastRunAt: null, cron: args[args.indexOf('--cron') + 1], prompt: args[2], maxRuns: args.includes('--max-runs') ? Number(args[args.indexOf('--max-runs') + 1]) : undefined, target: agentId, logs: [] };
  out(state.heartbeats[id]);
} else if (args[0] === 'heartbeat' && args[1] === 'update') {
  const hb = state.heartbeats[args[2]];
  if (!hb) process.exit(1);
  out(hb);
} else if (args[0] === 'heartbeat' && args[1] === 'delete') {
  const hb = state.heartbeats[args[2]];
  if (!hb) process.exit(1);
  hb.status = 'deleted'; out({ id: hb.id, status: 'deleted' });
} else if (args[0] === 'schedule' && args[1] === 'inspect') {
  const hb = state.heartbeats[args[2]];
  if (!hb) process.exit(1);
  out(hb);
} else if (args[0] === 'schedule' && args[1] === 'logs') {
  const hb = state.heartbeats[args[2]];
  if (!hb) process.exit(1);
  out(hb.logs || []);
} else if (args[0] === 'schedule' && args[1] === 'update') {
  const hb = state.heartbeats[args[2]];
  if (!hb) process.exit(1);
  hb.prompt = args[args.indexOf('--prompt') + 1];
  out(hb);
} else if (args[0] === 'schedule' && args[1] === 'delete') {
  const hb = state.heartbeats[args[2]];
  if (!hb) process.exit(1);
  hb.status = 'deleted'; out({ id: hb.id, status: 'deleted' });
} else if ((args[0] === 'fire' && args[1]) || (args[0] === 'schedule' && args[1] === 'fire' && args[2])) {
  const id = args[0] === 'fire' ? args[1] : args[2];
  const hb = state.heartbeats[id];
  if (!hb) process.exit(1);
  const target = state.agents[hb.target];
  const busy = target && ['running', 'working', 'busy'].includes(String(target.Status ?? target.status).toLowerCase());
  hb.logs = hb.logs || [];
  hb.lastRunAt = '2026-08-08T00:06:00.000Z';
  hb.logs.push({ at: hb.lastRunAt, status: busy ? 'failed' : 'succeeded', reason: busy ? 'recipient busy' : 'delivered', prompt: hb.prompt });
  // A max-runs schedule is terminal after either outcome. Consumers must read
  // the run log to distinguish a delivered run from a busy failure.
  hb.status = 'completed';
  out({ id, status: hb.logs.at(-1).status });
} else if (args[0] === 'wait') {
  out({ id: args[1], status: 'idle' });
} else if (args[0] === 'send') {
  out({ status: 'sent', id: args[1] });
} else if (args[0] === 'agent' && args[1] === 'update') {
  out({ id: args[2], status: 'updated' });
} else {
  out({ ok: true });
}
