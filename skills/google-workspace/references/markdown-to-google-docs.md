Implementation: ../scripts/md_to_gdoc.py

Version: v0.1+ · 2026-05-06

# 📘 Markdown → Google Docs 原生映射手册 v0.1+

## 1. 目标

把一份 Markdown 渲染成**结构上尽量原生**的 Google Doc，而不是把整份内容当作纯文本粘贴进去。

目标是让最终文档在 Google Docs 内部仍然是可继续编辑的原生结构：标题是标题、列表是列表、表格是表格、图片是图片，而不是单纯保留外观。

## 2. MVP 范围

v0.1+ 覆盖以下能力：

| Markdown 输入 | Google Docs 输出 |
| --- | --- |
| `#` ~ `######` | `HEADING_1` ~ `HEADING_6` |
| 普通段落 | `NORMAL_TEXT` 段落 |
| `**bold**` | bold 文本样式 |
| `*italic*` | italic 文本样式 |
| `~~strike~~` | strikethrough 文本样式 |
| `` `code` `` | monospace + 浅灰背景 |
| `[text](url)` | Docs link |
| `[^1]` / `[^1]: ...` | 原生 Docs footnote |
| 无序列表 | 原生 bullets |
| 有序列表 | 原生 numbered list |
| 任务列表标记 `[ ]` / `[x]` | 原生 Docs checklist bullets；`[x]` 文本加 strikethrough 表示完成 |
| blockquote | 缩进 + 灰色斜体段落 fallback |
| `> [!NOTE]` 等 callout | 带 label prefix + 边框/底色的可见 fallback |
| thematic break / horizontal rule | 居中的灰色分隔线文本 fallback |
| 围栏代码块 | 保留围栏文本并整体套用 code 样式 |
| CommonMark 表格 | 原生 Docs table |
| 表格单元格中的 bold / italic / code / links | 单元格内对应 Docs text style |
| 表格对齐 `:---` / `:---:` / `---:` | 单元格段落 `START` / `CENTER` / `END` alignment |
| 顶部简单 frontmatter | 读取 `title` / `gdoc_id` / `document_id` / `into_mode` 并从正文剥离 |
| 外部图片 URL | inline image；若已有 alt metadata 可在导出时读回，否则不额外生成可见说明 |
| Mermaid fenced block | 通过 `mermaid.ink` 渲染成图片后插入 |

## 3. 总体原则

1. 以 **Google Docs 原生结构** 为第一优先级。
2. 只做 v0.1 已确认可稳定工作的映射，不扩张范围。
3. 若 Docs API 没有稳定的结构语义入口，就采用最小可行回退。

## 4. 输入与输出

- 输入：一份 CommonMark 风格 Markdown 文本。
- 输出：默认创建一个新的 Google Doc；若传入 `--into <documentId>` 或 frontmatter 提供 `gdoc_id` / `document_id`，则写入既有文档。
- 既有文档写入模式由 `--into-mode replace|append` 或 frontmatter `into_mode` 控制；默认安全行为为 `replace`，即清空并替换既有文档 body；`append` 会先确保段落边界，再追加到 body 末尾，避免并入或重设既有最后段落样式。
- 输出结果应返回标准文档 URL：

```text
https://docs.google.com/document/d/<DOC_ID>/edit
```

CLI 默认只打印纯 URL，方便人工复制。传入 `--json-output` 时打印机器可读元数据；`sourceHash` 计算对象是完整原始 Markdown 输入（包含 frontmatter），用于标识真实源文件/字符串：

```json
{"documentId":"<DOC_ID>","url":"https://docs.google.com/document/d/<DOC_ID>/edit","title":"<TITLE>","mode":"create|replace|append","sourceHash":"sha256:<12-hex>"}
```

所有 `gws` shell-out 都显式使用 `--format json`；实现保留对 keyring preamble / stdout noise 的容错 JSON 解析，并在执行或解析失败时报告命令、返回码和输出预览。错误消息中的 `--json` request body 会被 redacted/truncated，避免把巨大批量 payload 原样刷屏。

## 4.1 轻量 frontmatter

若 Markdown 顶部是简单 YAML-style frontmatter：

```markdown
---
title: Report
gdoc_id: <DOC_ID>
into_mode: append
---
```

实现会读取 `title`、`gdoc_id`、`document_id`（`gdoc_id` alias）、`into_mode`。解析器只支持简单 `key: value` 行，不引入 YAML 依赖，不支持嵌套结构。frontmatter 会从渲染正文中剥离。CLI flag 优先级高于 frontmatter。

## 4.2 Docs → Markdown 导出

CLI 也支持把现有 Google Doc 导出回 Markdown：

```bash
python md_to_gdoc.py --doc-to-markdown <doc_id_or_url>
```

当前导出覆盖标题、段落行内样式、列表/任务列表、表格、图片、blockquote/callout fallback、Mermaid fallback、footnotes。

## 5. 文档标题

文档标题规则：

1. 显式传入标题时，优先使用显式标题。
2. 否则取第一条 H1 文本作为标题。
3. 若没有 H1，文件输入回退到文件名 stem；纯文本输入回退到 `Untitled`。
4. `--into` / frontmatter existing-doc 模式只写入 body 内容，不重命名既有 Google Doc；JSON metadata 的 `title` 反映既有文档标题。

## 6. 标题映射（H1–H6）

Markdown 标题映射到 Google Docs 段落命名样式：

| Markdown | Docs namedStyleType |
| --- | --- |
| `#` | `HEADING_1` |
| `##` | `HEADING_2` |
| `###` | `HEADING_3` |
| `####` | `HEADING_4` |
| `#####` | `HEADING_5` |
| `######` | `HEADING_6` |

标题的行内样式继续按正文规则应用。

## 7. 段落映射

普通段落映射为 `NORMAL_TEXT` 段落。

段落内容保持文本顺序；Markdown 中的软换行与硬换行，在 v0.1 中统一折叠为空格，不引入复杂行内换行语义。

## 8. 行内样式映射

支持的行内样式如下：

| Markdown | Docs 样式 |
| --- | --- |
| `**bold**` | `bold: true` |
| `*italic*` | `italic: true` |
| `~~strike~~` | `strikethrough: true` |
| `` `code` `` | `weightedFontFamily = Courier New` + 浅灰背景 |
| `[text](url)` | `link.url = ...` |

多种样式可以在同一段文本上叠加。

## 9. 无序列表

Markdown 无序列表插入为原生 Google Docs bullets。

实现方式：

1. 先批量插入每个列表项文本；
2. 再对对应段落范围调用 `createParagraphBullets`。

v0.1 只保证简单列表项稳定；不扩展到复杂嵌套块级结构。

## 10. 有序列表

Markdown 有序列表插入为原生 Google Docs numbered list。

与无序列表一样，先插入文本，再调用 `createParagraphBullets`，但使用编号预设。

## 10.1 任务列表标记

当简单列表项文本以 GitHub-style task marker 开头时：

```markdown
- [ ] todo
- [x] done
```

实现会移除可见的 `[ ]` / `[x]` marker，并使用 Docs `createParagraphBullets` 的 `BULLET_CHECKBOX` preset 创建 checklist bullets：

由于当前 Docs API 路径未确认支持显式设置 checklist checked-state，`[x]` 不会真正勾选 checkbox；作为可见完成状态 fallback，完成项正文会应用 `strikethrough`。

普通列表项仍按 bullet / numbered list 渲染；同一简单列表中可以混合普通 bullets 与 checklist bullets。

## 10.2 Thematic breaks / horizontal rules

Markdown thematic break（例如 `---`）映射为一个 Docs-friendly fallback 段落：居中的灰色分隔线文本。当前不尝试使用 Docs 专用水平线对象。

## 10.3 Blockquote fallback

Markdown blockquote 映射为带左边框的缩进段落，并整体应用灰色斜体，以保留“引用”视觉语义。当前不实现复杂嵌套引用块或引用内多种块级结构。

## 10.4 Callout fallback

支持常见 GFM-style callout marker：`[!NOTE]`、`[!TIP]`、`[!WARNING]`、`[!IMPORTANT]`、`[!CAUTION]`。写入 Docs 时会转成带可见 label prefix、左边框、底色和缩进的 fallback 段落。

## 11.1 Footnotes

支持常见 paragraph-style footnotes：`[^1]` 引用与 `[^1]: ...` 定义。写入 Docs 时使用原生 `createFootnote`，再将 footnote 文本写入 footnote segment。当前实现以常见单段 footnote 为主，不追求复杂嵌套结构全覆盖。

## 11. 围栏代码块

围栏代码块在 v0.1 中采用“保留 Markdown 围栏文本”的最小可行实现：

````markdown
```python
print("hello")
```
````

输出时：

1. 保留开闭围栏；
2. 整段应用 monospace + 浅灰背景；
3. 不尝试实现 Docs 原生 code block 语义，也不做语言级高亮。

## 12. 表格

Markdown 表格映射为 Google Docs 原生表格。

例如：

| Name | Qty | Note |
| --- | --- | --- |
| Apples | 3 | Fresh |

映射规则：

1. 使用 Markdown 表格的行列数创建 Docs table；
2. 按单元格填充文本；
3. 第一行视为表头并加粗；
4. v0.1+ 保留单元格内的 bold / italic / inline code / links；
5. 使用 markdown-it token attrs 保留 `:---` / `:---:` / `---:` 对齐到 Docs table cell paragraph alignment；仍不处理复杂块级内容。

## 13. 外部图片

当一个段落只包含单张 Markdown 图片时：

```markdown
![Alt](https://example.com/image.png)
```

渲染为 Google Docs inline image。

若 Google Doc 里的 inline image 本身已经带有 `title` / `description`（alt text），`--doc-to-markdown` 会优先把它读回并作为 Markdown image alt text 导出。

独立图片仍会作为 inline image 插入，但如果当前 API 路径无法稳定写入 inline image 自身的 alt text，本工具不会再为普通图片额外生成任何可见 caption / 说明段落。

导出方向上，若 Docs inline image 已有 title / description 等可读 alt 元数据，导出时会优先用作 Markdown alt text；否则导出为空 alt text（例如 `![](url)`）。

v0.1+ 只支持可直接访问的外部图片 URL；不处理本地文件上传。

## 14. Mermaid

Mermaid fenced block：

````markdown
```mermaid
flowchart TD
  A --> B
```
````

映射流程：

1. 读取 Mermaid 源文本；
2. 用 `https://mermaid.ink/img/<base64url>` 生成可插入图片 URL；
3. 把该图片作为 inline image 插入文档。

## 15. Mermaid 源保留

Mermaid 生成图片后，仍需保留来源信息，便于复核与追溯。

v0.1+ 的做法保持不变：

1. 插入 Mermaid 图片；
2. 紧跟一个小号灰色等宽 caption 段落：

```text
source_type: mermaid; source_hash: sha256:<12-hex>
```

3. 再把完整 Mermaid 源码按 fenced code block 形式写回文档。

## 16. Mermaid 可访问性限制

在当前这条 `gws docs documents batchUpdate` 工作流下，**没有确认可用的 inline image alt-text 写回路径**。

因此 v0.1+ **保留 caption-paragraph fallback**，不移除。

也就是说：Mermaid 图片的来源说明目前不是通过图片自身 alt text 挂载，而是通过紧随其后的辅助说明段落表达。

## 17. Google Docs API 批量写入策略

整个实现围绕 Docs API `batchUpdate`：

1. 创建新文档，或在 `--into` / frontmatter gdoc_id 模式读取既有文档；`replace` 用 `deleteContentRange` 删除 body 内容（保留最后结构边界），`append` 先插入必要换段边界再写入末尾；
2. 获取文档末尾索引；
3. 构造结构化 request 列表；
4. 一次写入文本、段落样式、文字样式、列表、表格或图片；
5. 必要时再次读取文档，以获取后续结构（例如新插入表格的单元格起始位置）。

索引计算按 UTF-16 code unit 处理，以匹配 Google Docs API 的索引语义。

## 18. 非目标与暂不支持

v0.1+ 明确**不**扩展以下范围：

- 嵌套复杂列表
- 复杂引用块/引用内嵌套块级结构
- 显式控制 Docs checklist checked-state（`[x]` 用 strikethrough 作为完成状态 fallback）
- HTML 块
- 本地图片上传
- true inline image alt-text 写回（普通图片在无官方稳定 API 时不再生成可见 caption；但已有 alt text 可在导出模式读回）
- 任意复杂 footnote 嵌套结构的完整 round-trip
- 完整 YAML frontmatter（只支持简单顶层 `key: value`）
- 数学公式
- 语法高亮
- Docs 原生代码块高级语义
- 超出上述 MVP 范围的 Markdown 扩展

## 19. 验证方式

验收时至少确认以下结构已经真实落入 Docs：

1. 至少一个 `HEADING_1`
2. 至少一处原生 bullet / numbered list
3. 至少一个原生表格
4. 至少一张 inline image
5. 原生 checklist bullets，且 Markdown task marker 不出现在正文中
6. thematic break fallback 分隔线
7. 表格单元格富文本内容与至少 center/right 对齐
8. strikethrough、blockquote fallback、callout fallback
9. 至少一个 native footnote
10. `--doc-to-markdown` 导出结果中可见 callout marker / footnote / Mermaid fence / image markdown

对应实现与示例见：

- 实现脚本：`../scripts/md_to_gdoc.py`
- 示例输入：`../scripts/sample.md`
- 验证脚本：`../scripts/verify.py`
