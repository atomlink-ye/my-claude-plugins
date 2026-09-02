import type { ReadStream, WriteStream } from 'node:tty';
import { renderChannelCard, type ChannelProjection } from './channel-projection.js';

type Panorama = Record<string, any>;
export type TuiOptions = {
  fetchPanorama: (refresh: boolean) => Promise<Panorama>;
  input?: ReadStream;
  output?: WriteStream;
  refreshMs?: number;
};

/** How many Channel cards the snapshot shows; the rest stay one line of count. */
export const TUI_EVENT_CARDS = 3;

const scalar = (value: unknown) => typeof value === 'number' ? value.toFixed(2) : String(value ?? 'unknown');

/** Deterministic, deliberately redacted panorama used by `arcp tui --snapshot`
 * and the interactive renderer.  It is presentation-only: it never mutates
 * ARCP state. */
export function renderTuiSnapshot(view: Panorama, selected = 0, tab = 0, expanded = false): string {
  const runtime = Array.isArray(view.runtime) ? view.runtime : [];
  const workspace = view.workspace ?? {};
  const roster = Array.isArray(view.roster) ? view.roster : [];
  const tasks = Array.isArray(view.tasks) ? view.tasks : [];
  const goals = Array.isArray(view.goals) ? view.goals : [];
  const blocked = Array.isArray(view.blocked) ? view.blocked : [];
  const blockedByRuntime = new Map<string, any>(blocked.map((item: any) => [String(item.runtimeSessionId), item]));
  const budget = view.providerBudget ?? { status: 'source_unavailable' };
  const minutes = (ms: unknown) => typeof ms === 'number' && Number.isFinite(ms) ? `${Math.floor(ms / 60000)}m` : 'unknown';
  const tabs = ['overview', 'runtimes', 'temporal'];
  const lines = [
    `ARCP TUI · ${workspace.purpose ?? workspace.id ?? 'workspace'}`,
    `tab=${tabs[tab]} selected=${selected + 1}/${Math.max(runtime.length, 1)} expanded=${expanded ? 'yes' : 'no'}`,
    `Workspace ${workspace.lifecycle ?? 'unknown'} · Goals ${goals.length} · Tasks ${tasks.length} · Members ${roster.length}`,
  ];
  if (budget.snapshot) {
    lines.push(`Provider budget ${budget.snapshot.source.id} observed=${budget.snapshot.source.observedAt}`);
    for (const provider of budget.snapshot.providers ?? []) lines.push(`  ${provider.providerId} ${provider.status} ${provider.windows.map((window: any) => `${window.id}:${window.remainingPct ?? 'unknown'}%`).join(' ') || (provider.error ?? 'no windows')}`);
    for (const decision of budget.admissions ?? []) lines.push(`  admission ${decision.providerId}/${decision.model}: ${decision.action} · ${decision.reasons?.[0] ?? ''}`);
  } else lines.push(`Provider budget ${budget.status ?? 'source_unavailable'}`);
  if (tab === 2) {
    const temporal = view.temporal ?? {}; const groups = Array.isArray(temporal.groups) ? temporal.groups : [];
    lines.push(`Temporal ${groups.length} subject timelines · problems ${(temporal.problems ?? []).length}`);
    for (const group of groups) {
      const card = group.active ?? group.history?.[0]; if (!card) continue;
      lines.push(`  ${group.subject?.label ?? 'Workspace'} · ${card.disposition} · ${card.transport?.state}`);
      lines.push(`    ${card.headline} · next: ${card.nextAction}`);
      if (card.problems?.length) lines.push(`    problems: ${card.problems.join(', ')}`);
    }
    lines.push('Keys: arrows select · tab view · enter details · r refresh · q quit');
    return lines.join('\n');
  }
  for (const [index, item] of runtime.entries()) {
    const session = item.session ?? {}, observation = item.observation ?? {}, children = item.children ?? {}, work = item.workSummary ?? {};
    const prefix = index === selected ? '>' : ' ';
    lines.push(`${prefix} Runtime ${session.id ?? 'unknown'} ${session.provider ?? 'unknown'}/${session.model ?? 'unknown'} state=${session.state ?? 'unknown'} health=${observation.health ?? 'unknown'} cache=${observation.cache?.state ?? 'unknown'} context=${scalar(observation.context?.ratio)} compaction=${observation.compaction?.status ?? 'unknown'} children=${children.items?.length ?? 0}`);
    const parked = blockedByRuntime.get(String(session.id));
    // A runtime blocked on an unanswered decision reports the same provider
    // status as a healthy one, so the blocked record is the only thing that can
    // put it on screen. Round 2 lost over an hour to exactly this blind spot.
    if (parked) lines.push(`    BLOCKED on decision ${parked.eventId} age=${minutes(parked.ageMs)} options=${(parked.options ?? []).length}`);
    const burn = observation.burn;
    if (burn?.samples) lines.push(`    burn turns=${burn.turnCount} rate5m=${scalar(burn.velocities?.fiveMinute)} cacheRead=${scalar(burn.cacheReadTokens)} wakes=${burn.staleWakeCount} signals=${burn.signals?.join(',') || 'none'}`);
    if (expanded && index === selected) lines.push(`  SCM dirty=${scalar(work.dirty)} diff=${JSON.stringify(work.diffstat ?? 'unknown')} provider-children=${(children.items ?? []).map((child: any) => `${child.id}:${child.status}`).join(',') || 'none'} context=${scalar(observation.context?.used)}/${scalar(observation.context?.max)}`);
  }
  lines.push(`Blocked ${blocked.length}${blocked.length ? ` · oldest ${minutes(blocked[0]?.ageMs)}` : ''}`);
  // Channel cards come from the one canonical projection builder. The TUI must
  // never format event text itself, or it drifts back to opaque ids on screen.
  const events = (Array.isArray(view.events) ? view.events : []).filter((item: any) => item?.projection);
  const recent = events.slice(-TUI_EVENT_CARDS);
  lines.push(`Channel ${events.length}${recent.length ? ` · latest ${recent.length}` : ''}`);
  for (const item of recent) {
    for (const line of renderChannelCard(item.projection as ChannelProjection).split('\n')) lines.push(`  ${line}`);
  }
  lines.push('Keys: arrows select · tab view · enter details · r refresh · q quit');
  return lines.join('\n');
}

export async function runTui(options: TuiOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY) throw new Error('arcp tui requires a TTY; use arcp tui --snapshot for deterministic output');
  let selected = 0, tab = 0, expanded = false, closed = false, refreshing = false;
  let view: Panorama = {};
  const redraw = () => output.write(`\x1b[H\x1b[2J${renderTuiSnapshot(view, selected, tab, expanded)}\n`);
  const refresh = async (force = false) => {
    if (refreshing) return;
    refreshing = true;
    try { view = await options.fetchPanorama(force); selected = Math.min(selected, Math.max((view.runtime?.length ?? 1) - 1, 0)); redraw(); }
    catch (error) { output.write(`\x1b[H\x1b[2JARCP TUI error: ${error instanceof Error ? error.message : String(error)}\n`); }
    finally { refreshing = false; }
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer); input.off('data', onKey); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); process.off('SIGHUP', onSignal); output.off('resize', redraw);
    if (typeof input.setRawMode === 'function') input.setRawMode(false);
    output.write('\x1b[?1049l\x1b[?25h');
  };
  const onSignal = () => cleanup();
  const onKey = (chunk: Buffer) => {
    const key = chunk.toString('utf8'); const total = Math.max(view.runtime?.length ?? 1, 1);
    if (key === 'q' || key === '\u0003') { cleanup(); return; }
    // Refresh is intentionally projection-only. A TUI key must never invoke
    // the mutating observe/pump path or start a runtime turn.
    if (key === 'r') { void refresh(false); return; }
    if (key === '\t') { tab = (tab + 1) % 3; redraw(); return; }
    if (key === '\r') { expanded = !expanded; redraw(); return; }
    if (key === '\x1b[A') { selected = (selected + total - 1) % total; redraw(); return; }
    if (key === '\x1b[B') { selected = (selected + 1) % total; redraw(); }
  };
  const timer = setInterval(() => { void refresh(false); }, options.refreshMs ?? 5_000);
  timer.unref();
  output.write('\x1b[?1049h\x1b[?25l');
  input.setRawMode(true); input.resume(); input.on('data', onKey); process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal); process.on('SIGHUP', onSignal); output.on('resize', redraw);
  await refresh(false);
  await new Promise<void>((resolve) => {
    const watcher = setInterval(() => { if (closed) { clearInterval(watcher); resolve(); } }, 25);
    watcher.unref();
  });
}
