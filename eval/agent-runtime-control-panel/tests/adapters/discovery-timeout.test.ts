import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArcpService } from '../../../../skills/agent-runtime-control-panel/runtime/src/arcp.js';
import { PaseoCli } from '../../../../skills/agent-runtime-control-panel/runtime/src/cli.js';

/**
 * R3-discover-timeout: the Paseo adapter's discovery-plane calls
 * (`provider ls`, `ls -g`, `inspect`) back preflight()'s and doctor's
 * live/available verdicts. A daemon carrying ~100 agents measured ~5.8s to
 * answer `provider ls --json`, which exceeded the old hardcoded 5s budget and
 * made a genuinely live daemon read as unavailable (preflight held every
 * launch). These tests exercise the real PaseoCli/child-process path (not the
 * in-memory FakeCli the rest of the suite uses) against a fixture CLI whose
 * response latency is controlled by an env var, so the timeout math is
 * exercised for real rather than asserted on its own configured value.
 */

let root: string | undefined;
const priorTimeoutEnv = process.env.ARCP_DISCOVERY_TIMEOUT_MS;
const priorSleepEnv = process.env.ARCP_TEST_CLI_SLEEP_MS;

afterEach(() => {
  if (priorTimeoutEnv === undefined) delete process.env.ARCP_DISCOVERY_TIMEOUT_MS; else process.env.ARCP_DISCOVERY_TIMEOUT_MS = priorTimeoutEnv;
  if (priorSleepEnv === undefined) delete process.env.ARCP_TEST_CLI_SLEEP_MS; else process.env.ARCP_TEST_CLI_SLEEP_MS = priorSleepEnv;
});

/** A real, spawnable CLI fixture: it answers `provider ls --json` for
 * codex after sleeping ARCP_TEST_CLI_SLEEP_MS (inherited from the parent
 * env, matching how PaseoCli.run forwards process.env to the child), and
 * answers `provider models codex --json` immediately so only the discovery
 * call under test is slow. */
async function fixtureCli(): Promise<PaseoCli> {
  root = await mkdtemp(path.join(os.tmpdir(), 'arcp-discovery-timeout-'));
  const script = path.join(root, 'fixture-paseo');
  await writeFile(script, `#!/usr/bin/env node
const args = process.argv.slice(2);
const sleepMs = Number(process.env.ARCP_TEST_CLI_SLEEP_MS || '0');
function respond(value) { process.stdout.write(JSON.stringify(value)); process.exit(0); }
if (args[0] === 'provider' && args[1] === 'ls') {
  setTimeout(() => respond([{ provider: 'codex', status: 'available', enabled: true, modes: ['auto', 'plan', 'full-access'] }]), sleepMs);
} else if (args[0] === 'provider' && args[1] === 'models') {
  respond([{ id: 'gpt-5.6-terra', thinkingOptionIds: ['medium'] }]);
} else {
  respond([]);
}
`, 'utf8');
  await chmod(script, 0o755);
  return new PaseoCli(script);
}

// The SDK mode client is stubbed with a fixed, non-empty mode list so these
// tests exercise only the discovery-plane CLI timeout budget under test, not
// the separate SDK-empty-modes CLI-fallback behavior covered elsewhere.
const modeClient = () => ({ connect: async () => {}, close: async () => {}, providers: { listModes: async () => ({ modes: [{ id: 'auto' }, { id: 'plan' }, { id: 'full-access' }] }) } });

describe('ARCP Paseo discovery timeout', () => {
  it('treats a slow-but-successful discovery as live, not unavailable', async () => {
    const cli = await fixtureCli();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'arcp-discovery-timeout-state-'));
    // Measured on the daemon this bug was reported against: ~5.8s, comfortably
    // past the old hardcoded 5s budget but well inside the new default.
    process.env.ARCP_TEST_CLI_SLEEP_MS = '5300';
    delete process.env.ARCP_DISCOVERY_TIMEOUT_MS; // exercise the shipped default, not a test-only override
    const service = new ArcpService(dataDir, cli, undefined, modeClient);
    await service.init();
    const preflight = await service.preflight({ profileId: 'codex-worker' });
    expect(preflight.action).toBe('launch');
    expect(preflight.launchable).toBe(true);
    expect(preflight.liveModes).toEqual(expect.arrayContaining(['auto']));
    const discovery = await service.discovery();
    expect(discovery.available).toBe(true);
    expect(discovery.profiles.find((profile) => profile.id === 'codex-worker')).toMatchObject({ available: true });
  }, 20_000);

  it('still holds on a genuine timeout instead of fabricating availability', async () => {
    const cli = await fixtureCli();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'arcp-discovery-timeout-state-'));
    // The fixture sleeps longer than the configured budget, so this proves
    // the fail-closed path survives the fix: a call that really exceeds its
    // budget must still throw and read as unavailable/hold, never "available".
    process.env.ARCP_DISCOVERY_TIMEOUT_MS = '100';
    process.env.ARCP_TEST_CLI_SLEEP_MS = '400';
    const service = new ArcpService(dataDir, cli, undefined, modeClient);
    await service.init();
    const preflight = await service.preflight({ profileId: 'codex-worker' });
    expect(preflight.action).toBe('hold');
    expect(preflight.launchable).toBe(false);
    expect(preflight.liveModes).toEqual([]);
    const discovery = await service.discovery();
    expect(discovery.available).toBe(false);
    expect(discovery.profiles.every((profile) => profile.available === false)).toBe(true);
  }, 10_000);
});
