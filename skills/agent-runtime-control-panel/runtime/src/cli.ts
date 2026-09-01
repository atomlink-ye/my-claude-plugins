import { spawn } from 'node:child_process';

export interface CliResult<T = unknown> {
  value: T;
  stdout: string;
  stderr: string;
}

export class PaseoCli {
  readonly bin: string;
  readonly timeoutMs: number;

  constructor(bin = process.env.PASEO_BIN || 'paseo', timeoutMs = 30_000) {
    this.bin = bin;
    this.timeoutMs = timeoutMs;
  }

  async run(args: string[], options: { agentId?: string; cwd?: string; timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string> } = {}): Promise<CliResult> {
    const env = { ...process.env } as Record<string, string>;
    // Caller identity is request-scoped; do not inherit a launch-time identity.
    delete env.PASEO_AGENT_ID;
    if (options.agentId) env.PASEO_AGENT_ID = options.agentId;
    if (options.env) Object.assign(env, options.env);
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        options.signal?.removeEventListener('abort', abort);
        reject(new Error(`paseo command timed out: ${args.join(' ')}`));
      }, options.timeoutMs ?? this.timeoutMs);
      const abort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.kill('SIGTERM');
        reject(new Error('paseo command aborted'));
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', (err) => {
        if (!settled) { settled = true; clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); reject(err); }
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abort);
        if (code !== 0) {
          reject(new Error(`paseo exited ${code}: ${stderr.trim() || stdout.trim()}`));
          return;
        }
        resolve({ value: parseJson(stdout), stdout, stderr });
      });
    });
  }
}

export function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed); } catch { return trimmed; }
}

export function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}
