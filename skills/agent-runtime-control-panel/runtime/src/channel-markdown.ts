import type { ChannelEventKind } from './arcp.js';
import type { ChannelProjection } from './channel-projection.js';

/**
 * The one Markdown rendering of a canonical Channel projection.
 *
 * The projection stays structured data; every rendering decision — heading
 * level, status icon, field labels, progressive disclosure and escaping —
 * lives here, so a second surface cannot invent its own envelope.
 *
 * The envelope is authored by ARCP. Everything drawn from Knowledge, Result,
 * Task, Goal or Member records is agent-authored and is escaped before it
 * reaches the output, so it cannot forge a heading, a `<details>` block, raw
 * HTML or a link that impersonates a sender.
 */
export interface ChannelMarkdownOptions {
  /**
   * Whether the target renders `<details>`. When false, references fall back to
   * a plain final bullet list. Essential text is never inside `<details>`
   * either way, so a reader who cannot expand loses nothing actionable.
   */
  details?: boolean;
  /** `auto` follows the language of the projected summary. */
  locale?: 'auto' | 'en' | 'zh';
}

/** The stable icon set. Deliberately small; most kinds carry no icon. */
const ICONS: Partial<Record<ChannelEventKind, string>> = {
  task_completed: '✅',
  phase_completed: '✅',
  decision_required: '❓',
  blocker: '⚠️',
  runtime_health: '⚠️',
  transport_uncertainty: '⚠️',
  attention: '⚠️',
  permission: '⚠️',
  workspace_analysis_required: '⚠️',
  task_failed: '❌',
  task_unknown: '❌',
  phase_progress: '🔄',
  material_progress: '🔄',
  task_claimed: '🔄',
  task_candidate: '🔄',
};

const LABELS = {
  en: {
    from: 'From', subject: 'Subject', next: 'Next', references: 'References and machine detail',
    kinds: {
      decision_required: 'Decision required', decision_resolved: 'Decision resolved', task_claimed: 'Claimed',
      task_candidate: 'Candidate', task_completed: 'Completed', task_failed: 'Failed', task_unknown: 'Unknown',
      phase_progress: 'Progress', phase_completed: 'Phase completed', blocker: 'Blocker', finding: 'Finding',
      permission: 'Permission', attention: 'Attention', runtime_health: 'Runtime health',
      transport_uncertainty: 'Transport uncertain', material_progress: 'Progress',
      workspace_analysis_required: 'Analysis required', Accepted: 'Accepted', Refused: 'Refused',
    } as Record<string, string>,
  },
  zh: {
    from: '发送方', subject: '主题', next: '下一步', references: '引用与机器详情',
    kinds: {
      decision_required: '需要决策', decision_resolved: '决策已处理', task_claimed: '已认领',
      task_candidate: '候选结果', task_completed: '已完成', task_failed: '已失败', task_unknown: '状态未知',
      phase_progress: '进行中', phase_completed: '阶段完成', blocker: '阻塞', finding: '发现',
      permission: '需要授权', attention: '需要关注', runtime_health: '运行时健康',
      transport_uncertainty: '传输不确定', material_progress: '进展',
      workspace_analysis_required: '需要分析', Accepted: '已接受', Refused: '已拒绝',
    } as Record<string, string>,
  },
} as const;

const CJK = /[㐀-鿿豈-﫿぀-ヿ]/;

/**
 * Escape agent-authored text for Markdown prose.
 *
 * This is the trust boundary. A forged `**From:**` line or a forged `###`
 * heading is an impersonation, not a formatting bug, so structural characters
 * are neutralised rather than filtered: HTML becomes entities, and Markdown
 * structure characters are backslash-escaped. The projection has already
 * collapsed whitespace, so no newline survives to open a new block.
 */
export function escapeMarkdown(value: unknown): string {
  return String(value ?? '')
    .replace(/\r?\n|\r/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([`*_[\]#~|])/g, '\\$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Escape agent-authored text destined for a code span. Backslashes are literal
 * inside a code span, so the only escape that works is denying the closing
 * backtick; HTML and Markdown are already inert there.
 */
export function escapeCode(value: unknown): string {
  return String(value ?? '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

const code = (value: unknown) => {
  const text = escapeCode(value);
  return text ? `\`${text}\`` : '';
};

function localeFor(projection: ChannelProjection, requested: ChannelMarkdownOptions['locale']): 'en' | 'zh' {
  if (requested === 'en' || requested === 'zh') return requested;
  return CJK.test([projection.headline, ...projection.summary, projection.subject ?? ''].join(' ')) ? 'zh' : 'en';
}

/**
 * Render one projection as bounded, Feishu-safe Markdown.
 *
 * Layout is fixed: an `###` headline, the sender and subject, the primary
 * summary as one to three short paragraphs, the next action, and references
 * last. Nothing a reader must act on is hidden behind progressive disclosure.
 */
export function renderChannelMarkdown(projection: ChannelProjection, options: ChannelMarkdownOptions = {}): string {
  const locale = localeFor(projection, options.locale);
  const words = LABELS[locale];
  const useDetails = options.details !== false;

  const kindLabel = words.kinds[projection.label] ?? words.kinds[projection.kind] ?? projection.label;
  const icon = projection.verdict === 'refuse' ? '⏸' : projection.verdict === 'accept' ? '✅' : ICONS[projection.kind];
  const heading = ['###', icon, kindLabel, projection.stage ? `· ${escapeMarkdown(projection.stage)}` : undefined]
    .filter(Boolean).join(' ');

  // Two trailing spaces keep the sender and subject in one block with a hard
  // line break, which Feishu renders without turning them into paragraphs.
  const fields = [
    `**${words.from}:** ${escapeMarkdown(projection.sender.label)} ${code(projection.sender.role)}`.trim(),
    ...(projection.subject ? [`**${words.subject}:** ${escapeMarkdown(projection.subject)}`] : []),
  ];

  const paragraphs = projection.summary.map((line) => escapeMarkdown(line)).filter(Boolean);
  const next = projection.options.length
    ? `**${words.next}:** ${projection.options.map((option) => code(option)).filter(Boolean).join(' · ')}`
    : undefined;

  const bullets = projection.refs.map((ref) => `- ${escapeMarkdown(ref.label)}: ${code(ref.value)}`);
  const references = !bullets.length ? []
    : useDetails
      ? ['<details>', `<summary>${escapeMarkdown(words.references)}</summary>`, '', ...bullets, '', '</details>']
      : [`**${words.references}**`, '', ...bullets];

  const blocks = [
    heading,
    fields.join('  \n'),
    ...paragraphs,
    ...(next ? [next] : []),
    ...(references.length ? [references.join('\n')] : []),
  ];
  return blocks.join('\n\n');
}
