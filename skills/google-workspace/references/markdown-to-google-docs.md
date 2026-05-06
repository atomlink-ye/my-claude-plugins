Implementation: ../scripts/md_to_gdoc.py

Version: v0.1 · 2026-05-06

# 📘 Markdown → Google Docs 原生映射手册 v0.1

## 1. 目标

把一份 Markdown 渲染成**结构上尽量原生**的 Google Doc，而不是把整份内容当作纯文本粘贴进去。

目标是让最终文档在 Google Docs 内部仍然是可继续编辑的原生结构：标题是标题、列表是列表、表格是表格、图片是图片，而不是单纯保留外观。

## 2. MVP 范围

v0.1 只覆盖以下能力：

| Markdown 输入 | Google Docs 输出 |
| --- | --- |
| `#` ~ `######` | `HEADING_1` ~ `HEADING_6` |
| 普通段落 | `NORMAL_TEXT` 段落 |
| `**bold**` | bold 文本样式 |
| `*italic*` | italic 文本样式 |
| `` `code` `` | monospace + 浅灰背景 |
| `[text](url)` | Docs link |
| 无序列表 | 原生 bullets |
| 有序列表 | 原生 numbered list |
| 围栏代码块 | 保留围栏文本并整体套用 code 样式 |
| CommonMark 表格 | 原生 Docs table |
| 外部图片 URL | inline image |
| Mermaid fenced block | 通过 `mermaid.ink` 渲染成图片后插入 |

## 3. 总体原则

1. 以 **Google Docs 原生结构** 为第一优先级。
2. 只做 v0.1 已确认可稳定工作的映射，不扩张范围。
3. 若 Docs API 没有稳定的结构语义入口，就采用最小可行回退。

## 4. 输入与输出

- 输入：一份 CommonMark 风格 Markdown 文本。
- 输出：一个新的 Google Doc。
- 输出结果应返回标准文档 URL：

```text
https://docs.google.com/document/d/<DOC_ID>/edit
```

## 5. 文档标题

文档标题规则：

1. 显式传入标题时，优先使用显式标题。
2. 否则取第一条 H1 文本作为标题。
3. 若没有 H1，文件输入回退到文件名 stem；纯文本输入回退到 `Untitled`。

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
4. v0.1 不处理单元格内复杂富文本，也不处理对齐扩展语法。

## 13. 外部图片

当一个段落只包含单张 Markdown 图片时：

```markdown
![Alt](https://example.com/image.png)
```

渲染为 Google Docs inline image。

v0.1 只支持可直接访问的外部图片 URL；不处理本地文件上传。

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

v0.1 的做法：

1. 插入 Mermaid 图片；
2. 紧跟一个小号灰色等宽 caption 段落：

```text
source_type: mermaid; source_hash: sha256:<12-hex>
```

3. 再把完整 Mermaid 源码按 fenced code block 形式写回文档。

## 16. Mermaid 可访问性限制

在当前这条 `gws docs documents batchUpdate` 工作流下，**没有确认可用的 inline image alt-text 写回路径**。

因此 v0.1 **保留 caption-paragraph fallback**，不移除。

也就是说：Mermaid 图片的来源说明目前不是通过图片自身 alt text 挂载，而是通过紧随其后的辅助说明段落表达。

## 17. Google Docs API 批量写入策略

整个实现围绕 Docs API `batchUpdate`：

1. 获取文档末尾索引；
2. 构造结构化 request 列表；
3. 一次写入文本、段落样式、文字样式、列表、表格或图片；
4. 必要时再次读取文档，以获取后续结构（例如新插入表格的单元格起始位置）。

索引计算按 UTF-16 code unit 处理，以匹配 Google Docs API 的索引语义。

## 18. 非目标与暂不支持

v0.1 明确**不**扩展以下范围：

- 嵌套复杂列表
- 引用块
- 任务列表 / checkbox
- HTML 块
- 本地图片上传
- 脚注
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

对应实现与示例见：

- 实现脚本：`../scripts/md_to_gdoc.py`
- 示例输入：`../scripts/sample.md`
- 验证脚本：`../scripts/verify.py`
