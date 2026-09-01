import type { ReadStream, WriteStream } from 'node:tty';

type Panorama = Record<string, any>;
export type TuiOptions = {
  fetchPanorama: (refresh: boolean) => Promise<Panorama>;
  input?: ReadStream;
  output?: WriteStream;
  refreshMs?: number;
};

const count = (value: Record<string, number> | undefined) => Object.values(value ?? {}).reduce((total, item) => total + Number(item), 0);
const scalar = (value: unknown) => typeof value === 'number' ? value.toFixed(2) : String(value ?? 'unknown');

/** Deterministic, deliberately redacted panorama used by `arcp tui --snapshot`
 * and the interactive renderer.  It is presentation-only: it never mutates
 * ARCP or Companion state. */
export function renderTuiSnapshot(view: Panorama, selected = 0, tab = 0, expanded = false): string {
  const runtime = Array.isArray(view.runtime) ? view.runtime : [];
  const workspace = view.workspace ?? {};
  const roster = Array.isArray(view.roster) ? view.roster : [];
  const tasks = Array.isArray(view.tasks) ? view.tasks : [];
  const goals = Array.isArray(view.goals) ? view.goals : [];
  const legacy = view.legacy ?? {};
  const tabs = ['overview', 'runtimes', 'legacy'];
  const lines = [
    `ARCP TUI · ${workspace.purpose ?? workspace.id ?? 'workspace'}`,
    `tab=${tabs[tab]} selected=${selected + 1}/${Math.max(runtime.length, 1)} expanded=${expanded ? 'yes' : 'no'}`,
    `Workspace ${workspace.lifecycle ?? 'unknown'} · Goals ${goals.length} · Tasks ${tasks.length} · Members ${roster.length}`,
  ];
  for (const [index, item] of runtime.entries()) {
    const session = item.session ?? {}, observation = item.observation ?? {}, children = item.children ?? {}, work = item.workSummary ?? {};
    const prefix = index === selected ? '>' : ' ';
    lines.push(`${prefix} Runtime ${session.id ?? 'unknown'} ${session.provider ?? 'unknown'}/${session.model ?? 'unknown'} state=${session.state ?? 'unknown'} health=${observation.health ?? 'unknown'} cache=${observation.cache?.state ?? 'unknown'} context=${scalar(observation.context?.ratio)} compaction=${observation.compaction?.status ?? 'unknown'} children=${children.items?.length ?? 0}`);
    if (expanded && index === selected) lines.push(`  SCM dirty=${scalar(work.dirty)} diff=${JSON.stringify(work.diffstat ?? 'unknown')} provider-children=${(children.items ?? []).map((child: any) => `${child.id}:${child.status}`).join(',') || 'none'} context=${scalar(observation.context?.used)}/${scalar(observation.context?.max)}`);
  }
  lines.push(`Legacy reminders=${count(legacy.reminders)} messages=${count(legacy.messages)} trackedChildren=${legacy.trackedChildren?.total ?? 0} correctionGates=${legacy.blockedGateCount ?? 0}`);
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
    if (key === 'r') { void refresh(true); return; }
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
