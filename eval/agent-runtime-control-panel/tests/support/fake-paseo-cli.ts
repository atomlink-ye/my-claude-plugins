import path from 'node:path';

type FakePaseoCliOptions = {
  fail?: boolean | string;
  providers?: string[];
  inspectValue?: Record<string, unknown>;
  modeListing?: unknown;
  registryListing?: unknown;
};

/**
 * Stateful Paseo boundary fake for service tests. It models only commands that
 * ARCP owns; adapter-specific fakes stay beside their specialized suites.
 */
export class FakePaseoCli {
  private lastMode = 'auto';
  readonly fail: boolean | string;
  readonly providers: string[];
  inspectValue: Record<string, unknown>;
  readonly modeListing: unknown;
  readonly registryListing: unknown;
  sends = 0;
  launches = 0;
  calls: string[][] = [];
  lastLaunchArgs: string[] = [];
  lastEnv: Record<string, string> = {};
  private workspaces: Array<Record<string, unknown>> = [];
  private laneCount = 0;
  private localCount = 0;

  constructor(options: FakePaseoCliOptions = {}) {
    this.fail = options.fail ?? false;
    this.providers = options.providers ?? ['codex'];
    this.inspectValue = options.inspectValue ?? {};
    this.modeListing = options.modeListing;
    this.registryListing = options.registryListing;
  }

  async run(args: string[], runOptions: { env?: Record<string, string> } = {}) {
    this.calls.push(args);
    if (runOptions.env) this.lastEnv = runOptions.env;
    if (this.fail && args[0] === 'run') throw new Error(typeof this.fail === 'string' ? this.fail : 'timed out');
    if (args[0] === 'provider' && args[1] === 'ls') return { value: this.providers.map((provider) => ({ provider, status: 'available', enabled: true, modes: this.modeListing ?? (provider === 'pi' ? [] : ['auto', 'plan', provider === 'claude' ? 'bypassPermissions' : 'full-access']) })), stdout: '', stderr: '' };
    if (args[0] === 'provider' && args[1] === 'models') return { value: args[2] === 'codex' ? [{ id: 'gpt-5.6-terra', thinkingOptionIds: ['medium'] }] : args[2] === 'claude' ? [{ id: 'claude-opus-5', thinkingOptionIds: ['medium'] }] : [{ id: 'grok-cli/grok-4.6', thinkingOptionIds: [] }], stdout: '', stderr: '' };
    if (args[0] === 'workspace' && args[1] === 'ls') return { value: this.workspaces, stdout: '', stderr: '' };
    if (args[0] === 'project' && args[1] === 'ls') return { value: [], stdout: '', stderr: '' };
    if (args[0] === 'project' && args[1] === 'create') return { value: { projectId: 'prj_default' }, stdout: '', stderr: '' };
    if (args[0] === 'workspace' && args[1] === 'create') {
      const worktree = args.includes('worktree');
      const workspaceId = worktree ? `wks_lane_${++this.laneCount}` : this.localCount++ ? `wks_restore_${this.localCount - 1}` : 'wks_default';
      const projectId = args[args.indexOf('--project') + 1] ?? 'prj_default';
      const cwd = worktree ? path.dirname(process.cwd()) : String(args[args.indexOf('--path') + 1]);
      const row = { workspaceId, projectId, cwd };
      this.workspaces = [...this.workspaces.filter((item) => item.workspaceId !== workspaceId), row];
      return { value: row, stdout: '', stderr: '' };
    }
    if (args[0] === 'workspace' && args[1] === 'archive') {
      this.workspaces = this.workspaces.filter((item) => item.workspaceId !== args[2]);
      return { value: { workspaceId: args[2], status: 'archived' }, stdout: '', stderr: '' };
    }
    if (args[0] === 'run') {
      this.launches += 1;
      this.lastLaunchArgs = args;
      this.lastMode = args[args.indexOf('--mode') + 1] ?? '';
      return { value: { id: 'paseo-session-1' }, stdout: '', stderr: '' };
    }
    if (args[0] === 'ls') return { value: this.registryListing ?? [{ id: 'paseo-session-1', status: 'idle' }], stdout: '', stderr: '' };
    if (args[0] === 'send' || args[0] === 'start-turn') {
      this.sends += 1;
      return { value: {}, stdout: '', stderr: '' };
    }
    if (args[0] === 'inspect') {
      const provider = this.providers[0];
      return {
        value: {
          id: 'paseo-session-1',
          status: 'idle',
          provider,
          model: provider === 'claude' ? 'claude-opus-5' : provider === 'pi' ? 'grok-cli/grok-4.6' : 'gpt-5.6-terra',
          ...(provider === 'pi' ? {} : { mode: this.lastMode }),
          thinking: 'medium',
          ...this.inspectValue,
        },
        stdout: '',
        stderr: '',
      };
    }
    return { value: [], stdout: '', stderr: '' };
  }
}
