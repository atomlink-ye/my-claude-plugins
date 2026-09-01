import { spawn } from 'node:child_process';
import path from 'node:path';

export type WaitSourceState = boolean | 'unknown';

/** A process-level detector for the manager's primary `paseo wait` wakeup. */
export interface WaitSourceDetector {
  detect(agentId: string): Promise<WaitSourceState>;
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote: string | undefined;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) {
      if (token) { tokens.push(token); token = ''; }
      continue;
    }
    token += char;
  }
  if (escaped) token += '\\';
  if (token) tokens.push(token);
  return tokens;
}

export function commandIsPaseoWait(command: string, agentId: string): boolean {
  const argv = tokenizeCommand(command);
  if (path.basename(argv[0] ?? '') === 'paseo') return argv[1] === 'wait' && waitTargetMatches(argv[2], agentId);
  if (path.basename(argv[0] ?? '') !== 'node') return false;
  let index = 1;
  const nodeOptionsWithValues = new Set(['-e', '--eval', '-p', '--print', '-r', '--require', '--import', '--loader', '--experimental-loader', '--conditions', '--inspect-port']);
  while (index < argv.length && argv[index].startsWith('-')) {
    const option = argv[index++];
    if (!option.includes('=') && nodeOptionsWithValues.has(option)) index++;
  }
  if (path.basename(argv[index] ?? '') !== 'paseo') return false;
  return argv[index + 1] === 'wait' && waitTargetMatches(argv[index + 2], agentId);
}

function waitTargetMatches(target: string | undefined, agentId: string): boolean {
  if (!target || !agentId) return false;
  if (target === agentId) return true;
  // Paseo may shorten UUID targets to a hexadecimal prefix (including the
  // seven-character form emitted by the real CLI). Restrict prefix matching
  // to UUID-shaped values so arbitrary command-line substrings cannot count as
  // a live wait source.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const targetIsUuid = uuid.test(target);
  const agentIsUuid = uuid.test(agentId);
  if (agentIsUuid) return /^[0-9a-f]{7,}$/i.test(target) && agentId.toLowerCase().startsWith(target.toLowerCase());
  if (targetIsUuid) return /^[0-9a-f]{7,}$/i.test(agentId) && target.toLowerCase().startsWith(agentId.toLowerCase());
  return false;
}

/** macOS-compatible implementation; it intentionally avoids a shell/grep pipeline. */
export class ProcessWaitSourceDetector implements WaitSourceDetector {
  async detect(agentId: string): Promise<WaitSourceState> {
    return new Promise((resolve) => {
      const child = spawn('ps', ['-axo', 'pid=,command='], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let settled = false;
      const finish = (value: WaitSourceState) => { if (!settled) { settled = true; resolve(value); } };
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.on('error', () => finish('unknown'));
      child.on('close', (code) => {
        if (code !== 0) { finish('unknown'); return; }
        for (const line of stdout.split(/\r?\n/)) {
          const match = line.match(/^\s*(\d+)\s+(.*)$/);
          if (!match || Number(match[1]) === process.pid) continue;
          if (commandIsPaseoWait(match[2], agentId)) { finish(true); return; }
        }
        finish(false);
      });
    });
  }
}
