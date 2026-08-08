#!/usr/bin/env -S uv run --script
# /// script
# dependencies = [
#   "markdown-it-py>=3.0.0",
#   "mdit-py-plugins>=0.4.2",
# ]
# ///

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

try:
    from markdown_it import MarkdownIt
    from mdit_py_plugins.footnote import footnote_plugin
except ModuleNotFoundError:  # pragma: no cover - exercised in bare-python acceptance path
    MarkdownIt = None  # type: ignore[assignment]
    footnote_plugin = None  # type: ignore[assignment]


MONO = {"fontFamily": "Courier New", "weight": 400}
LIGHT_GRAY = {"color": {"rgbColor": {"red": 0.95, "green": 0.95, "blue": 0.95}}}
MID_GRAY = {"color": {"rgbColor": {"red": 0.45, "green": 0.45, "blue": 0.45}}}
CALLOUT_FILL = {"color": {"rgbColor": {"red": 0.92, "green": 0.96, "blue": 1.0}}}
QUOTE_BORDER = {
    "color": {"color": {"rgbColor": {"red": 0.55, "green": 0.55, "blue": 0.55}}},
    "width": {"magnitude": 2, "unit": "PT"},
    "padding": {"magnitude": 6, "unit": "PT"},
    "dashStyle": "SOLID",
}
CALLOUT_BORDER = {
    "color": {"color": {"rgbColor": {"red": 0.1, "green": 0.35, "blue": 0.75}}},
    "width": {"magnitude": 2, "unit": "PT"},
    "padding": {"magnitude": 6, "unit": "PT"},
    "dashStyle": "SOLID",
}
CALLOUT_TYPES = {"NOTE", "TIP", "WARNING", "IMPORTANT", "CAUTION"}
FOOTNOTE_PLACEHOLDER_RE = re.compile(r"\uFFF0FN\d+_\d+\uFFF1")
FOOTNOTE_PLACEHOLDER_RE = re.compile(r"\uFFF0FN(\d+)_(\d+)\uFFF1")
CALLOUT_KIND_RE = re.compile(r"^\[!([A-Z]+)\](?:[ \t]*)\n?")

IR = list[dict[str, Any]]


def _safe_cmd_for_error(cmd: list[str]) -> str:
    safe: list[str] = []
    skip_next = False
    for arg in cmd:
        if skip_next:
            safe.append(f"<redacted json body; {len(arg)} chars>")
            skip_next = False
            continue
        safe.append(arg)
        if arg == "--json":
            skip_next = True
    return " ".join(safe)


def _json_from_gws_output(stdout: str) -> dict[str, Any]:
    text = stdout.strip()
    for index, char in enumerate(text):
        if char not in "[{":
            continue
        try:
            data = json.loads(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return data
        raise RuntimeError(f"Unexpected JSON payload type from gws: {type(data).__name__}")
    preview = text[:500] + ("..." if len(text) > 500 else "")
    raise RuntimeError(f"gws did not return JSON output; stdout preview={preview!r}")


def _get_params(doc_id: str) -> dict[str, Any]:
    params: dict[str, Any] = {"documentId": doc_id}
    if _TAB_ID:
        params["includeTabsContent"] = True
    return params

def _run_gws(*args: str, json_body: dict[str, Any] | None = None, params: dict[str, Any] | None = None) -> dict[str, Any]:
    cmd = ["gws", *args, "--format", "json"]
    if params is not None:
        cmd += ["--params", json.dumps(params)]
    if json_body is not None:
        cmd += ["--json", json.dumps(json_body)]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    safe_cmd = _safe_cmd_for_error(cmd)
    if proc.returncode != 0:
        stderr = proc.stderr.strip()
        stdout = proc.stdout.strip()
        raise RuntimeError(
            f"gws failed rc={proc.returncode} cmd={safe_cmd}"
            f" stderr={stderr[:1000]!r} stdout={stdout[:1000]!r}"
        )
    try:
        return _json_from_gws_output(proc.stdout)
    except Exception as exc:
        raise RuntimeError(f"failed to parse gws JSON for cmd={safe_cmd}: {exc}") from exc


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


_TAB_ID: str | None = None

def _location(doc: dict[str, Any]) -> dict[str, Any]:
    body = _tab_body(doc)
    index = body["content"][-1]["endIndex"] - 1
    return _make_location(index)

def _make_location(index: int) -> dict[str, Any]:
    return {"index": index, "tabId": _TAB_ID} if _TAB_ID else {"index": index}

def _tab_body(doc: dict[str, Any]) -> dict[str, Any]:
    if _TAB_ID:
        for t in doc.get("tabs", []):
            if t.get("tabProperties", {}).get("tabId") == _TAB_ID:
                dt = t.get("documentTab", {})
                if "body" not in dt:
                    # Ensure body exists for empty tabs
                    dt["body"] = {"content": [{"endIndex": 1, "paragraph": {"elements": [{"endIndex": 2, "startIndex": 1, "textRun": {"content": "\n", "textStyle": {}}}], "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}}, "startIndex": 1}]}
                return dt["body"]
        raise RuntimeError(f"Tab {_TAB_ID} not found in document")
    return doc.get("body", {"content": [{"endIndex": 1}]})

def _append_index(doc: dict[str, Any]) -> int:
    return _tab_body(doc)["content"][-1]["endIndex"] - 1


def _last_body_paragraph_text(doc: dict[str, Any]) -> str:
    body = _tab_body(doc)
    for item in reversed(body.get("content", [])):
        paragraph = item.get("paragraph")
        if paragraph is None:
            continue
        return "".join(element.get("textRun", {}).get("content", "") for element in paragraph.get("elements", []))
    return ""


def _parse_to_ir_via_uv(markdown_text: str) -> IR:
    proc = subprocess.run(
        ["uv", "run", str(Path(__file__).resolve()), "--dump-ir", "-"],
        input=markdown_text,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "uv-backed IR parse failed")
    return json.loads(proc.stdout)


def _strip_frontmatter(markdown_text: str) -> tuple[str, dict[str, str]]:
    if not markdown_text.startswith("---"):
        return markdown_text, {}
    lines = markdown_text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return markdown_text, {}
    metadata: dict[str, str] = {}
    for index in range(1, len(lines)):
        if lines[index].strip() != "---":
            continue
        for raw_line in lines[1:index]:
            line = raw_line.strip()
            if not line or line.startswith("#") or ":" not in line:
                continue
            key, value = line.split(":", 1)
            key = key.strip().lower().replace("-", "_")
            value = value.strip().strip('"\'')
            if key in {"title", "gdoc_id", "document_id", "into_mode"}:
                metadata[key] = value
        return "".join(lines[index + 1 :]).lstrip("\n"), metadata
    return markdown_text, {}


def _source_hash(markdown_text: str) -> str:
    return "sha256:" + hashlib.sha256(markdown_text.encode()).hexdigest()[:12]


def _extract_callout_marker(text: str, runs: list[dict[str, Any]]) -> tuple[str | None, str, list[dict[str, Any]]]:
    match = CALLOUT_KIND_RE.match(text)
    if not match:
        return None, text, runs
    kind = match.group(1).upper()
    if kind not in CALLOUT_TYPES:
        return None, text, runs
    marker_len = _utf16_len(match.group(0))
    adjusted: list[dict[str, Any]] = []
    for run in runs:
        start = run["start"]
        end = run["end"]
        if end <= marker_len:
            continue
        adjusted.append(
            {
                "start": max(start, marker_len) - marker_len,
                "end": end - marker_len,
                "style": run["style"],
            }
        )
    return kind, text[match.end() :].lstrip(), adjusted


def _collect_footnote_defs(tokens: list[Any]) -> dict[int, dict[str, Any]]:
    defs: dict[int, dict[str, Any]] = {}
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token.type != "footnote_open":
            index += 1
            continue
        footnote_id = int(token.meta.get("id", 0))
        parts: list[str] = []
        index += 1
        while index < len(tokens) and tokens[index].type != "footnote_close":
            if tokens[index].type == "paragraph_open":
                inline = tokens[index + 1]
                if parts:
                    parts.append("\n\n")
                parts.append((inline.content or "").strip())
                index += 3
            else:
                index += 1
        defs[footnote_id] = {"text": "".join(parts).strip()}
        index += 1
    return defs


def _inline_to_text_runs_and_footnotes(
    children: list[Any], footnote_defs: dict[int, dict[str, Any]] | None = None
) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]]]:
    parts: list[str] = []
    runs: list[dict[str, Any]] = []
    footnotes: list[dict[str, Any]] = []
    offset = 0
    bold = 0
    italic = 0
    strike = 0
    link_stack: list[str] = []
    footnote_defs = footnote_defs or {}

    def add(text: str, *, code: bool = False) -> None:
        nonlocal offset
        text = FOOTNOTE_PLACEHOLDER_RE.sub("", text)
        if not text:
            return
        start = offset
        end = start + _utf16_len(text)
        offset = end
        parts.append(text)
        style: dict[str, Any] = {}
        if bold:
            style["bold"] = True
        if italic:
            style["italic"] = True
        if strike:
            style["strikethrough"] = True
        if link_stack:
            style["link"] = link_stack[-1]
        if code:
            style["code"] = True
        if style:
            runs.append({"start": start, "end": end, "style": style})

    for child in children:
        if child.type == "text":
            add(child.content)
        elif child.type in {"softbreak", "hardbreak"}:
            add(" ")
        elif child.type == "code_inline":
            add(child.content, code=True)
        elif child.type == "strong_open":
            bold += 1
        elif child.type == "strong_close":
            bold = max(0, bold - 1)
        elif child.type == "em_open":
            italic += 1
        elif child.type == "em_close":
            italic = max(0, italic - 1)
        elif child.type == "s_open":
            strike += 1
        elif child.type == "s_close":
            strike = max(0, strike - 1)
        elif child.type == "link_open":
            link_stack.append(child.attrGet("href") or "")
        elif child.type == "link_close":
            if link_stack:
                link_stack.pop()
        elif child.type == "image":
            add(child.content or child.attrGet("src") or "")
        elif child.type == "footnote_ref":
            footnote_id = int(child.meta.get("id", 0))
            placeholder = f"\uFFF0FN{footnote_id}_{len(footnotes)}\uFFF1"
            add(placeholder)
            footnotes.append({"placeholder": placeholder, "text": footnote_defs.get(footnote_id, {}).get("text", "")})
    return "".join(parts), runs, footnotes


def _inline_to_ir(children: list[Any], footnotes: dict[int, dict[str, Any]] | None = None) -> dict[str, Any]:
    parts: list[str] = []
    runs: list[dict[str, Any]] = []
    refs: list[dict[str, Any]] = []
    offset = 0
    bold = 0
    italic = 0
    strike = 0
    link_stack: list[str] = []

    def add(text: str, *, code: bool = False) -> None:
        nonlocal offset
        if not text:
            return
        start = offset
        end = start + _utf16_len(text)
        offset = end
        parts.append(text)
        style: dict[str, Any] = {}
        if bold:
            style["bold"] = True
        if italic:
            style["italic"] = True
        if strike:
            style["strikethrough"] = True
        if link_stack:
            style["link"] = link_stack[-1]
        if code:
            style["code"] = True
        if style:
            runs.append({"start": start, "end": end, "style": style})

    for child in children:
        if child.type == "text":
            add(child.content)
        elif child.type in {"softbreak", "hardbreak"}:
            add(" ")
        elif child.type == "code_inline":
            add(child.content, code=True)
        elif child.type == "strong_open":
            bold += 1
        elif child.type == "strong_close":
            bold = max(0, bold - 1)
        elif child.type == "em_open":
            italic += 1
        elif child.type == "em_close":
            italic = max(0, italic - 1)
        elif child.type == "s_open":
            strike += 1
        elif child.type == "s_close":
            strike = max(0, strike - 1)
        elif child.type == "link_open":
            link_stack.append(child.attrGet("href") or "")
        elif child.type == "link_close":
            if link_stack:
                link_stack.pop()
        elif child.type == "image":
            add(child.content or child.attrGet("src") or "")
        elif child.type == "footnote_ref":
            footnote_id = int((child.meta or {}).get("id", -1))
            if footnotes and footnote_id in footnotes:
                start = offset
                placeholder = f"\uFFF0FN{footnote_id}_{len(refs)}\uFFF1"
                add(placeholder)
                refs.append({"offset": start, "placeholder": placeholder, **footnotes[footnote_id]})
    return {"text": "".join(parts), "runs": runs, "footnotes": refs}


def _inline_to_text_and_runs(children: list[Any]) -> tuple[str, list[dict[str, Any]]]:
    inline = _inline_to_ir(children)
    return inline["text"], inline["runs"]


def _join_inline_parts(parts: list[dict[str, Any]]) -> dict[str, Any]:
    text_parts: list[str] = []
    runs: list[dict[str, Any]] = []
    footnotes: list[dict[str, Any]] = []
    offset = 0
    for part in parts:
        text = part.get("text", "")
        text_parts.append(text)
        for run in part.get("runs", []):
            runs.append({"start": offset + run["start"], "end": offset + run["end"], "style": run["style"]})
        for footnote in part.get("footnotes", []):
            footnotes.append({**footnote, "offset": offset + footnote["offset"]})
        offset += _utf16_len(text)
    return {"text": "".join(text_parts), "runs": runs, "footnotes": footnotes}


def _parse_footnotes(tokens: list[Any]) -> dict[int, dict[str, Any]]:
    notes: dict[int, dict[str, Any]] = {}
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token.type != "footnote_open":
            index += 1
            continue
        note_id = int((token.meta or {}).get("id", -1))
        label = str((token.meta or {}).get("label", note_id + 1))
        index += 1
        parts: list[dict[str, Any]] = []
        while tokens[index].type != "footnote_close":
            if tokens[index].type == "paragraph_open":
                inline = _inline_to_ir(tokens[index + 1].children or [])
                if parts and inline.get("text"):
                    parts.append({"text": "\n", "runs": [], "footnotes": []})
                parts.append(inline)
                index += 3
            else:
                index += 1
        joined = _join_inline_parts(parts)
        notes[note_id] = {"label": label, "text": joined["text"], "runs": joined["runs"]}
        index += 1
    return notes


def _strip_leading_prefix(inline: dict[str, Any], pattern: str) -> tuple[dict[str, Any], re.Match[str] | None]:
    match = re.match(pattern, inline.get("text", ""))
    if not match:
        return inline, None
    prefix_len = _utf16_len(match.group(0))
    stripped_runs = []
    for run in inline.get("runs", []):
        if run["end"] <= prefix_len:
            continue
        stripped_runs.append({"start": max(run["start"], prefix_len) - prefix_len, "end": run["end"] - prefix_len, "style": run["style"]})
    stripped_footnotes = []
    for footnote in inline.get("footnotes", []):
        if footnote["offset"] < prefix_len:
            continue
        stripped_footnotes.append({**footnote, "offset": footnote["offset"] - prefix_len})
    return {"text": inline["text"][match.end() :], "runs": stripped_runs, "footnotes": stripped_footnotes}, match


def _extract_task_marker(text: str, runs: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]], bool | None]:
    match = re.match(r"^\[([ xX])\]\s+", text)
    if not match:
        return text, runs, None
    checked = match.group(1).lower() == "x"
    marker_len = _utf16_len(match.group(0))
    adjusted: list[dict[str, Any]] = []
    for run in runs:
        start = run["start"]
        end = run["end"]
        if end <= marker_len:
            continue
        adjusted.append(
            {
                "start": max(start, marker_len) - marker_len,
                "end": end - marker_len,
                "style": run["style"],
            }
        )
    cleaned = text[match.end() :]
    if checked and cleaned:
        adjusted.append({"start": 0, "end": _utf16_len(cleaned), "style": {"strikethrough": True}})
    return cleaned, adjusted, checked


def _cell_from_inline(children: list[Any]) -> dict[str, Any]:
    text, runs = _inline_to_text_and_runs(children)
    return {"text": text, "runs": runs}


def _docs_alignment_from_token(token: Any) -> str | None:
    style = token.attrGet("style") or ""
    if "text-align:center" in style.replace(" ", ""):
        return "CENTER"
    if "text-align:right" in style.replace(" ", ""):
        return "END"
    if "text-align:left" in style.replace(" ", ""):
        return "START"
    return None


def parse_to_ir(markdown_text: str) -> IR:
    if MarkdownIt is None:
        return _parse_to_ir_via_uv(markdown_text)
    md = MarkdownIt("commonmark").enable("table").enable("strikethrough")
    if footnote_plugin is not None:
        md = md.use(footnote_plugin)
    tokens = md.parse(markdown_text)
    footnotes = _parse_footnotes(tokens)
    blocks: IR = []
    index = 0
    while index < len(tokens):
        token = tokens[index]

        if token.type == "heading_open":
            inline = _inline_to_ir(tokens[index + 1].children or [], footnotes)
            blocks.append({"type": "heading", "level": int(token.tag[1]), "text": inline["text"], "runs": inline["runs"], "footnotes": inline["footnotes"]})
            index += 3
            continue

        if token.type == "paragraph_open":
            children = tokens[index + 1].children or []
            meaningful = [
                child
                for child in children
                if child.type not in {"softbreak", "hardbreak"}
                and not (child.type == "text" and not child.content.strip())
            ]
            if len(meaningful) == 1 and meaningful[0].type == "image":
                blocks.append(
                    {
                        "type": "image",
                        "src": meaningful[0].attrGet("src") or "",
                        "alt": meaningful[0].content,
                    }
                )
            else:
                inline = _inline_to_ir(children, footnotes)
                blocks.append({"type": "paragraph", "text": inline["text"], "runs": inline["runs"], "footnotes": inline["footnotes"]})
            index += 3
            continue

        if token.type in {"bullet_list_open", "ordered_list_open"}:
            closing = "bullet_list_close" if token.type == "bullet_list_open" else "ordered_list_close"
            items: list[dict[str, Any]] = []
            index += 1
            while tokens[index].type != closing:
                if tokens[index].type == "list_item_open":
                    index += 1
                    while tokens[index].type != "list_item_close":
                        if tokens[index].type == "paragraph_open":
                            inline = _inline_to_ir(tokens[index + 1].children or [], footnotes)
                            text, runs, checked = _extract_task_marker(inline["text"], inline["runs"])
                            marker_len = len(inline["text"]) - len(text)
                            marker_utf16_len = _utf16_len(inline["text"][:marker_len])
                            item_footnotes = []
                            for footnote in inline["footnotes"]:
                                if footnote["offset"] < marker_utf16_len:
                                    continue
                                item_footnotes.append({**footnote, "offset": footnote["offset"] - marker_utf16_len})
                            items.append({"text": text, "runs": runs, "footnotes": item_footnotes, "task": checked is not None, "checked": checked is True})
                            index += 3
                        else:
                            index += 1
                else:
                    index += 1
            blocks.append({"type": "list", "ordered": closing == "ordered_list_close", "items": items})
            index += 1
            continue

        if token.type == "fence":
            blocks.append({"type": "fence", "info": token.info.strip(), "content": token.content})
            index += 1
            continue

        if token.type == "hr":
            blocks.append({"type": "horizontal_rule"})
            index += 1
            continue

        if token.type == "blockquote_open":
            paragraph_parts: list[dict[str, Any]] = []
            index += 1
            while tokens[index].type != "blockquote_close":
                if tokens[index].type == "paragraph_open":
                    inline = _inline_to_ir(tokens[index + 1].children or [], footnotes)
                    if inline["text"]:
                        paragraph_parts.append(inline)
                    index += 3
                else:
                    index += 1
            if paragraph_parts:
                first_inline, match = _strip_leading_prefix(paragraph_parts[0], r"^\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*")
                if match:
                    paragraph_parts[0] = first_inline
                    joined_parts: list[dict[str, Any]] = []
                    for part_index, part in enumerate(paragraph_parts):
                        if part_index:
                            joined_parts.append({"text": "\n", "runs": [], "footnotes": []})
                        joined_parts.append(part)
                    joined = _join_inline_parts(joined_parts)
                    blocks.append({"type": "callout", "variant": match.group(1), "text": joined["text"], "runs": joined["runs"], "footnotes": joined["footnotes"]})
                else:
                    joined_parts = []
                    for part_index, part in enumerate(paragraph_parts):
                        if part_index:
                            joined_parts.append({"text": "\n", "runs": [], "footnotes": []})
                        joined_parts.append(part)
                    joined = _join_inline_parts(joined_parts)
                    blocks.append({"type": "blockquote", "text": joined["text"], "runs": joined["runs"], "footnotes": joined["footnotes"]})
            index += 1
            continue

        if token.type == "table_open":
            rows: list[list[dict[str, Any]]] = []
            index += 1
            while tokens[index].type != "table_close":
                if tokens[index].type == "tr_open":
                    row: list[dict[str, Any]] = []
                    index += 1
                    while tokens[index].type != "tr_close":
                        if tokens[index].type in {"th_open", "td_open"}:
                            inline = _inline_to_ir(tokens[index + 1].children or [], footnotes)
                            cell = {"text": inline["text"], "runs": inline["runs"], "footnotes": inline["footnotes"]}
                            alignment = _docs_alignment_from_token(tokens[index])
                            if alignment:
                                cell["alignment"] = alignment
                            row.append(cell)
                            index += 3
                        else:
                            index += 1
                    rows.append(row)
                index += 1
            blocks.append({"type": "table", "rows": rows})
            index += 1
            continue

        index += 1

        if token.type == "footnote_block_open":
            break

    return blocks


def _title_from_ir(ir: IR, fallback: str) -> str:
    for block in ir:
        if block["type"] == "heading" and block.get("level") == 1:
            text = block.get("text", "").strip()
            if text:
                return text
    return fallback


def _text_style_request(start: int, end: int, style: dict[str, Any]) -> dict[str, Any] | None:
    body: dict[str, Any] = {}
    fields: list[str] = []
    if style.get("bold"):
        body["bold"] = True
        fields.append("bold")
    if style.get("italic"):
        body["italic"] = True
        fields.append("italic")
    if style.get("strikethrough"):
        body["strikethrough"] = True
        fields.append("strikethrough")
    if style.get("link"):
        body["link"] = {"url": style["link"]}
        fields.append("link")
    if style.get("code"):
        body["weightedFontFamily"] = MONO
        body["backgroundColor"] = LIGHT_GRAY
        fields += ["weightedFontFamily", "backgroundColor"]
    if not fields:
        return None
    return {
        "updateTextStyle": {
            "range": {"startIndex": start, "endIndex": end},
            "textStyle": body,
            "fields": ",".join(fields),
        }
    }


def _apply_requests_with_footnotes(
    doc_id: str,
    requests: list[dict[str, Any]],
    text: str,
    base_index: int,
    footnotes: list[dict[str, Any]] | None = None,
) -> None:
    footnotes = footnotes or []
    if not footnotes:
        _run_gws("docs", "documents", "batchUpdate", params={"documentId": doc_id}, json_body={"requests": requests})
        return

    by_placeholder = {footnote["placeholder"]: footnote for footnote in footnotes if footnote.get("placeholder")}
    matches = list(FOOTNOTE_PLACEHOLDER_RE.finditer(text))
    create_requests: list[tuple[int, dict[str, Any]]] = []
    for match in reversed(matches):
        placeholder = match.group(0)
        footnote = by_placeholder.get(placeholder)
        if footnote is None:
            continue
        start_index = base_index + _utf16_len(text[: match.start()])
        end_index = base_index + _utf16_len(text[: match.end()])
        requests.append({"deleteContentRange": {"range": {"startIndex": start_index, "endIndex": end_index}}})
        requests.append({"createFootnote": {"location": {"index": start_index}}})
        create_requests.append((len(requests) - 1, footnote))

    response = _run_gws("docs", "documents", "batchUpdate", params={"documentId": doc_id}, json_body={"requests": requests})
    if not create_requests:
        return

    footnote_content_requests: list[dict[str, Any]] = []
    for reply_index, footnote in create_requests:
        footnote_id = response.get("replies", [])[reply_index].get("createFootnote", {}).get("footnoteId")
        if not footnote_id:
            continue
        text = (footnote.get("text") or "").strip()
        if not text:
            continue
        footnote_content_requests.append({"deleteContentRange": {"range": {"segmentId": footnote_id, "startIndex": 0, "endIndex": 1}}})
        footnote_content_requests.append({"insertText": {"location": {"segmentId": footnote_id, "index": 0}, "text": text + "\n"}})

    if footnote_content_requests:
        _run_gws(
            "docs",
            "documents",
            "batchUpdate",
            params={"documentId": doc_id},
            json_body={"requests": footnote_content_requests},
        )


def _insert_footnotes(doc_id: str, footnotes: list[dict[str, Any]]) -> None:
    for footnote in sorted(footnotes, key=lambda item: item["index"], reverse=True):
        response = _run_gws(
            "docs",
            "documents",
            "batchUpdate",
            params={"documentId": doc_id},
            json_body={"requests": [{"createFootnote": {"location": {"index": footnote["index"]}}}]},
        )
        footnote_id = response["replies"][0]["createFootnote"]["footnoteId"]
        footnote_text = (footnote.get("text") or "").strip() or footnote.get("label") or "footnote"
        _run_gws(
            "docs",
            "documents",
            "batchUpdate",
            params={"documentId": doc_id},
            json_body={
                "requests": [
                    {"deleteContentRange": {"range": {"segmentId": footnote_id, "startIndex": 0, "endIndex": 1}}},
                    {"insertText": {"location": {"segmentId": footnote_id, "index": 0}, "text": footnote_text + "\n"}},
                ]
            },
        )


def _insert_text_block(doc_id: str, text: str, runs: list[dict[str, Any]], named_style: str = "NORMAL_TEXT", footnotes: list[dict[str, Any]] | None = None) -> None:
    doc = _run_gws("docs", "documents", "get", params=_get_params(doc_id))
    index = _append_index(doc)
    payload = text + "\n"
    end = index + _utf16_len(payload)
    requests: list[dict[str, Any]] = [{"insertText": {"location": _make_location(index), "text": payload}}]
    if named_style != "NORMAL_TEXT":
        requests.append(
            {
                "updateParagraphStyle": {
                    "range": {"startIndex": index, "endIndex": end},
                    "paragraphStyle": {"namedStyleType": named_style},
                    "fields": "namedStyleType",
                }
            }
        )
    for run in runs:
        request = _text_style_request(index + run["start"], index + run["end"], run["style"])
        if request:
            requests.append(request)
    _apply_requests_with_footnotes(doc_id, requests, payload, index, footnotes)


def _insert_list(doc_id: str, items: list[dict[str, Any]], ordered: bool) -> None:
    doc = _run_gws("docs", "documents", "get", params=_get_params(doc_id))
    index = _append_index(doc)
    payload_parts: list[str] = []
    runs: list[dict[str, Any]] = []
    footnotes: list[dict[str, Any]] = []
    paragraph_ranges: list[dict[str, Any]] = []
    offset = 0
    for item in items:
        line = item["text"] + "\n"
        payload_parts.append(line)
        start = offset
        end = offset + _utf16_len(line)
        paragraph_ranges.append({"start": start, "end": end, "task": item.get("task", False)})
        for run in item["runs"]:
            runs.append({"start": offset + run["start"], "end": offset + run["end"], "style": run["style"]})
        for footnote in item.get("footnotes", []):
            footnotes.append({**footnote, "index": index + offset + footnote["offset"]})
        offset = end
    payload = "".join(payload_parts)
    end = index + _utf16_len(payload)
    requests: list[dict[str, Any]] = [{"insertText": {"location": _make_location(index), "text": payload}}]
    current_preset: str | None = None
    current_start: int | None = None
    current_end: int | None = None
    for paragraph in paragraph_ranges:
        preset = "BULLET_CHECKBOX" if paragraph["task"] else ("NUMBERED_DECIMAL_ALPHA_ROMAN" if ordered else "BULLET_DISC_CIRCLE_SQUARE")
        absolute_start = index + paragraph["start"]
        absolute_end = index + paragraph["end"]
        if preset == current_preset and current_end == absolute_start:
            current_end = absolute_end
            continue
        if current_preset is not None and current_start is not None and current_end is not None:
            requests.append({"createParagraphBullets": {"range": {"startIndex": current_start, "endIndex": current_end}, "bulletPreset": current_preset}})
        current_preset = preset
        current_start = absolute_start
        current_end = absolute_end
    if current_preset is not None and current_start is not None and current_end is not None:
        requests.append({"createParagraphBullets": {"range": {"startIndex": current_start, "endIndex": current_end}, "bulletPreset": current_preset}})
    for run in runs:
        request = _text_style_request(index + run["start"], index + run["end"], run["style"])
        if request:
            requests.append(request)
    merged_footnotes = []
    for item in items:
        merged_footnotes.extend(item.get("footnotes", []))
    _apply_requests_with_footnotes(doc_id, requests, payload, index, merged_footnotes)


def _insert_code_block(doc_id: str, code: str, info: str = "") -> None:
    fence = f"```{info}\n{code.rstrip()}\n```"
    runs = [{"start": 0, "end": _utf16_len(fence), "style": {"code": True}}]
    _insert_text_block(doc_id, fence, runs)


def _insert_image(doc_id: str, uri: str) -> None:
    doc = _run_gws("docs", "documents", "get", params=_get_params(doc_id))
    _run_gws(
        "docs",
        "documents",
        "batchUpdate",
        params={"documentId": doc_id},
        json_body={"requests": [{"insertInlineImage": {"location": _location(doc), "uri": uri}}]},
    )
    _insert_paragraph_break(doc_id)


def _insert_paragraph_break(doc_id: str) -> None:
    doc = _run_gws("docs", "documents", "get", params=_get_params(doc_id))
    _run_gws(
        "docs",
        "documents",
        "batchUpdate",
        params={"documentId": doc_id},
        json_body={"requests": [{"insertText": {"location": _location(doc), "text": "\n"}}]},
    )


def _insert_caption(doc_id: str, text: str) -> None:
    doc = _run_gws("docs", "documents", "get", params=_get_params(doc_id))
    index = _append_index(doc)
    requests = [
        {"insertText": {"location": _make_location(index), "text": text + "\n"}},
        {
            "updateTextStyle": {
                "range": {"startIndex": index, "endIndex": index + _utf16_len(text)},
                "textStyle": {
                    "weightedFontFamily": MONO,
                    "foregroundColor": MID_GRAY,
                    "fontSize": {"magnitude": 8, "unit": "PT"},
                },
                "fields": "weightedFontFamily,foregroundColor,fontSize",
            }
        },
    ]
    _run_gws("docs", "documents", "batchUpdate", params={"documentId": doc_id}, json_body={"requests": requests})


def _insert_horizontal_rule(doc_id: str) -> None:
    doc = _run_gws("docs", "documents", "get", params=_get_params(doc_id))
    index = _append_index(doc)
    text = "────────────────────────"
    requests = [
        {"insertText": {"location": _make_location(index), "text": text + "\n"}},
        {
            "updateTextStyle": {
                "range": {"startIndex": index, "endIndex": index + _utf16_len(text)},
                "textStyle": {"foregroundColor": MID_GRAY},
                "fields": "foregroundColor",
            }
        },
        {
            "updateParagraphStyle": {
                "range": {"startIndex": index, "endIndex": index + _utf16_len(text) + 1},
                "paragraphStyle": {"alignment": "CENTER"},
                "fields": "alignment",
            }
        },
    ]
    _run_gws("docs", "documents", "batchUpdate", params={"documentId": doc_id}, json_body={"requests": requests})


def _insert_blockquote(doc_id: str, text: str, runs: list[dict[str, Any]], footnotes: list[dict[str, Any]] | None = None) -> None:
    doc = _run_gws("docs", "documents", "get", params=_get_params(doc_id))
    index = _append_index(doc)
    payload = text + "\n"
    end = index + _utf16_len(payload)
    requests: list[dict[str, Any]] = [
        {"insertText": {"location": _make_location(index), "text": payload}},
        {
            "updateParagraphStyle": {
                "range": {"startIndex": index, "endIndex": end},
                "paragraphStyle": {
                    "indentStart": {"magnitude": 36, "unit": "PT"},
                    "borderLeft": QUOTE_BORDER,
                    "shading": {"backgroundColor": LIGHT_GRAY},
                },
                "fields": "indentStart,borderLeft,shading",
            }
        },
        {
            "updateTextStyle": {
                "range": {"startIndex": index, "endIndex": end - 1},
                "textStyle": {"italic": True, "foregroundColor": MID_GRAY},
                "fields": "italic,foregroundColor",
            }
        },
    ]
    for run in runs:
        request = _text_style_request(index + run["start"], index + run["end"], run["style"])
        if request:
            requests.append(request)
    _apply_requests_with_footnotes(doc_id, requests, payload, index, footnotes)


def _insert_callout(doc_id: str, variant: str, text: str, runs: list[dict[str, Any]], footnotes: list[dict[str, Any]] | None = None) -> None:
    doc = _run_gws("docs", "documents", "get", params=_get_params(doc_id))
    index = _append_index(doc)
    prefix = f"{variant}: "
    payload = prefix + text + "\n"
    end = index + _utf16_len(payload)
    prefix_len = _utf16_len(prefix)
    requests: list[dict[str, Any]] = [
        {"insertText": {"location": _make_location(index), "text": payload}},
        {
            "updateParagraphStyle": {
                "range": {"startIndex": index, "endIndex": end},
                "paragraphStyle": {
                    "indentStart": {"magnitude": 36, "unit": "PT"},
                    "borderLeft": CALLOUT_BORDER,
                    "shading": {"backgroundColor": CALLOUT_FILL},
                },
                "fields": "indentStart,borderLeft,shading",
            }
        },
        {
            "updateTextStyle": {
                "range": {"startIndex": index, "endIndex": index + prefix_len},
                "textStyle": {"bold": True},
                "fields": "bold",
            }
        },
    ]
    for run in runs:
        request = _text_style_request(index + prefix_len + run["start"], index + prefix_len + run["end"], run["style"])
        if request:
            requests.append(request)
    adjusted_footnotes = []
    for footnote in footnotes or []:
        adjusted_footnotes.append({**footnote, "placeholder": footnote.get("placeholder"), "offset": footnote["offset"] + prefix_len})
    _apply_requests_with_footnotes(doc_id, requests, payload, index, adjusted_footnotes)


def _clear_body(doc_id: str) -> None:
    doc = _run_gws("docs", "documents", "get", params=_get_params(doc_id))
    end = _append_index(doc)
    if end <= 1:
        return
    _delete_range = {"startIndex": 1, "endIndex": end}
    if _TAB_ID:
        _delete_range["tabId"] = _TAB_ID
    _run_gws(
        "docs",
        "documents",
        "batchUpdate",
        params={"documentId": doc_id},
        json_body={"requests": [{"deleteContentRange": {"range": _delete_range}}]},
    )


def _ensure_append_boundary(doc_id: str) -> None:
    doc = _run_gws("docs", "documents", "get", params=_get_params(doc_id))
    last_text = _last_body_paragraph_text(doc)
    if last_text in {"", "\n"}:
        return
    _run_gws(
        "docs",
        "documents",
        "batchUpdate",
        params={"documentId": doc_id},
        json_body={"requests": [{"insertText": {"location": _location(doc), "text": "\n"}}]},
    )


def _mermaid_uri(source: str) -> str:
    encoded = base64.urlsafe_b64encode(source.encode()).decode().rstrip("=")
    return f"https://mermaid.ink/img/{encoded}"


def _insert_mermaid(doc_id: str, source: str) -> None:
    _insert_image(doc_id, _mermaid_uri(source))
    digest = hashlib.sha256(source.encode()).hexdigest()[:12]
    _insert_caption(doc_id, f"source_type: mermaid; source_hash: sha256:{digest}")
    _insert_code_block(doc_id, source, "mermaid")


def _latest_table(doc: dict[str, Any]) -> dict[str, Any]:
    for item in reversed(doc["body"]["content"]):
        if "table" in item:
            return item["table"]
    raise RuntimeError("table not found")


def _insert_table(doc_id: str, rows: list[list[dict[str, Any]]]) -> None:
    if not rows:
        return
    doc = _run_gws("docs", "documents", "get", params=_get_params(doc_id))
    _run_gws(
        "docs",
        "documents",
        "batchUpdate",
        params={"documentId": doc_id},
        json_body={"requests": [{"insertTable": {"rows": len(rows), "columns": len(rows[0]), "location": _location(doc)}}]},
    )
    table = _latest_table(_run_gws("docs", "documents", "get", params=_get_params(doc_id)))
    fills: list[tuple[int, dict[str, Any], bool]] = []
    for row_index, row in enumerate(table["tableRows"]):
        for column_index, cell in enumerate(row["tableCells"]):
            cell_ir = rows[row_index][column_index] if column_index < len(rows[row_index]) else {"text": "", "runs": []}
            if cell_ir.get("text"):
                fills.append((cell["content"][0]["startIndex"], cell_ir, row_index == 0))
    requests: list[dict[str, Any]] = []
    for start, cell_ir, is_header in sorted(fills, reverse=True):
        text = cell_ir["text"]
        requests.append({"insertText": {"location": _make_location(start), "text": text}})
        if is_header:
            requests.append(
                {
                    "updateTextStyle": {
                        "range": {"startIndex": start, "endIndex": start + _utf16_len(text)},
                        "textStyle": {"bold": True},
                        "fields": "bold",
                    }
                }
            )
        for run in cell_ir.get("runs", []):
            request = _text_style_request(start + run["start"], start + run["end"], run["style"])
            if request:
                requests.append(request)
        if cell_ir.get("alignment"):
            requests.append(
                {
                    "updateParagraphStyle": {
                        "range": {"startIndex": start, "endIndex": start + _utf16_len(text)},
                        "paragraphStyle": {"alignment": cell_ir["alignment"]},
                        "fields": "alignment",
                    }
                }
            )
    _run_gws("docs", "documents", "batchUpdate", params={"documentId": doc_id}, json_body={"requests": requests})
    for start, cell_ir, _is_header in sorted(fills, reverse=True):
        if cell_ir.get("footnotes"):
            _apply_requests_with_footnotes(doc_id, [], cell_ir["text"], start, cell_ir["footnotes"])


def render_ir_to_doc_metadata(ir: IR, title: str | None = None, *, into: str | None = None, into_mode: str = "replace", source_hash: str | None = None, tab_id: str | None = None) -> dict[str, str]:
    global _TAB_ID
    _TAB_ID = tab_id
    doc_title = (title or _title_from_ir(ir, "Untitled")).strip() or "Untitled"
    if into_mode not in {"replace", "append"}:
        raise ValueError("into_mode must be 'replace' or 'append'")
    if into:
        doc_id = into
        existing = _run_gws("docs", "documents", "get", params=_get_params(doc_id))
        doc_title = existing.get("title") or doc_title
        if into_mode == "replace":
            _clear_body(doc_id)
        else:
            _ensure_append_boundary(doc_id)
        mode = into_mode
    else:
        doc_id = _run_gws("docs", "documents", "create", json_body={"title": doc_title})["documentId"]
        mode = "create"

    for block in ir:
        kind = block["type"]
        if kind == "heading":
            _insert_text_block(doc_id, block["text"], block["runs"], f"HEADING_{min(block['level'], 6)}", block.get("footnotes"))
        elif kind == "paragraph":
            _insert_text_block(doc_id, block["text"], block["runs"], footnotes=block.get("footnotes"))
        elif kind == "blockquote":
            _insert_blockquote(doc_id, block["text"], block["runs"], block.get("footnotes"))
        elif kind == "callout":
            _insert_callout(doc_id, block["variant"], block["text"], block["runs"], block.get("footnotes"))
        elif kind == "list":
            _insert_list(doc_id, block["items"], block["ordered"])
        elif kind == "fence":
            info = block["info"].split()[0] if block["info"] else ""
            if info == "mermaid":
                _insert_mermaid(doc_id, block["content"].rstrip())
            else:
                _insert_code_block(doc_id, block["content"], info)
        elif kind == "table":
            _insert_table(doc_id, block["rows"])
        elif kind == "image":
            _insert_image(doc_id, block["src"])
        elif kind == "horizontal_rule":
            _insert_horizontal_rule(doc_id)

    url = f"https://docs.google.com/document/d/{doc_id}/edit"
    metadata = {"documentId": doc_id, "url": url, "title": doc_title, "mode": mode}
    if source_hash:
        metadata["sourceHash"] = source_hash
    return metadata


def render_ir_to_doc(ir: IR, title: str | None = None, *, into: str | None = None, into_mode: str = "replace") -> str:
    return render_ir_to_doc_metadata(ir, title, into=into, into_mode=into_mode)["url"]


def _conversion_inputs(markdown_text: str, fallback_title: str, title: str | None, into: str | None, into_mode: str | None) -> tuple[str, dict[str, str], str, str | None, str]:
    body, frontmatter = _strip_frontmatter(markdown_text)
    resolved_title = title or frontmatter.get("title") or fallback_title
    resolved_into = into or frontmatter.get("gdoc_id") or frontmatter.get("document_id")
    resolved_mode = into_mode or frontmatter.get("into_mode") or "replace"
    if resolved_mode not in {"replace", "append"}:
        raise ValueError("into_mode must be 'replace' or 'append'")
    return body, frontmatter, resolved_title, resolved_into, resolved_mode


def convert(path: str | Path, title: str | None = None, *, into: str | None = None, into_mode: str | None = None) -> str:
    source_path = Path(path)
    markdown_text = source_path.read_text(encoding="utf-8")
    body, _frontmatter, fallback_title, resolved_into, resolved_mode = _conversion_inputs(markdown_text, source_path.stem, title, into, into_mode)
    ir = parse_to_ir(body)
    doc_title = fallback_title if (title or _frontmatter.get("title")) else _title_from_ir(ir, fallback_title)
    return render_ir_to_doc(ir, doc_title, into=resolved_into, into_mode=resolved_mode)


def convert_metadata(path: str | Path, title: str | None = None, *, into: str | None = None, into_mode: str | None = None, tab_id: str | None = None) -> dict[str, str]:
    source_path = Path(path)
    markdown_text = source_path.read_text(encoding="utf-8")
    body, frontmatter, fallback_title, resolved_into, resolved_mode = _conversion_inputs(markdown_text, source_path.stem, title, into, into_mode)
    ir = parse_to_ir(body)
    doc_title = fallback_title if (title or frontmatter.get("title")) else _title_from_ir(ir, fallback_title)
    return render_ir_to_doc_metadata(ir, doc_title, into=resolved_into, into_mode=resolved_mode, source_hash=_source_hash(markdown_text), tab_id=tab_id)


def convert_text(markdown_str: str, title: str | None = None, *, into: str | None = None, into_mode: str | None = None) -> str:
    body, frontmatter, fallback_title, resolved_into, resolved_mode = _conversion_inputs(markdown_str, "Untitled", title, into, into_mode)
    ir = parse_to_ir(body)
    doc_title = fallback_title if (title or frontmatter.get("title")) else _title_from_ir(ir, fallback_title)
    return render_ir_to_doc(ir, doc_title, into=resolved_into, into_mode=resolved_mode)


def convert_text_metadata(markdown_str: str, title: str | None = None, *, into: str | None = None, into_mode: str | None = None, tab_id: str | None = None) -> dict[str, str]:
    body, frontmatter, fallback_title, resolved_into, resolved_mode = _conversion_inputs(markdown_str, "Untitled", title, into, into_mode)
    ir = parse_to_ir(body)
    doc_title = fallback_title if (title or frontmatter.get("title")) else _title_from_ir(ir, fallback_title)
    return render_ir_to_doc_metadata(ir, doc_title, into=resolved_into, into_mode=resolved_mode, source_hash=_source_hash(markdown_str), tab_id=tab_id)


def _extract_doc_id(value: str) -> str:
    match = re.search(r"/d/([a-zA-Z0-9_-]+)", value)
    return match.group(1) if match else value


def _markdown_from_text_style(text: str, style: dict[str, Any]) -> str:
    if not text:
        return ""
    text = text.replace("\n", "")
    if not text:
        return ""
    leading = text[: len(text) - len(text.lstrip(" "))]
    trailing = text[len(text.rstrip(" ")) :]
    core = text.strip(" ")
    if not core:
        return text
    if style.get("weightedFontFamily", {}).get("fontFamily") == "Courier New" or style.get("backgroundColor"):
        return f"{leading}`{core}`{trailing}"
    if style.get("link", {}).get("url"):
        core = f"[{core}]({style['link']['url']})"
    if style.get("bold"):
        core = f"**{core}**"
    if style.get("italic"):
        core = f"*{core}*"
    if style.get("strikethrough"):
        core = f"~~{core}~~"
    return f"{leading}{core}{trailing}"


def _footnote_definition_markdown(doc: dict[str, Any], footnote_id: str, seen: dict[str, str]) -> str:
    parts: list[str] = []
    for item in doc.get("footnotes", {}).get(footnote_id, {}).get("content", []):
        paragraph = item.get("paragraph")
        if not paragraph:
            continue
        parts.append(_inline_markdown_from_paragraph(paragraph, doc, seen, allow_images=False).strip())
    return " ".join(part for part in parts if part).strip()


def _inline_markdown_from_paragraph(
    paragraph: dict[str, Any],
    doc: dict[str, Any],
    seen_footnotes: dict[str, str],
    *,
    allow_images: bool,
) -> str:
    parts: list[str] = []
    for element in paragraph.get("elements", []):
        text_run = element.get("textRun")
        if text_run is not None:
            parts.append(_markdown_from_text_style(text_run.get("content", ""), text_run.get("textStyle", {})))
            continue
        footnote_ref = element.get("footnoteReference")
        if footnote_ref is not None:
            footnote_id = footnote_ref.get("footnoteId", "")
            number = footnote_ref.get("footnoteNumber") or str(len(seen_footnotes) + 1)
            seen_footnotes.setdefault(footnote_id, number)
            parts.append(f"[^{number}]")
            continue
        if allow_images and element.get("inlineObjectElement") is not None:
            parts.append("[[INLINE_IMAGE]]")
    return "".join(parts).strip()


def _is_caption_paragraph(paragraph: dict[str, Any]) -> bool:
    runs = [element.get("textRun", {}) for element in paragraph.get("elements", []) if element.get("textRun")]
    if not runs:
        return False
    return all(
        run.get("textStyle", {}).get("weightedFontFamily", {}).get("fontFamily") == "Courier New"
        and run.get("textStyle", {}).get("fontSize", {}).get("magnitude") == 8
        for run in runs
        if run.get("content", "").strip()
    )


def _paragraph_is_code_block(paragraph: dict[str, Any]) -> bool:
    runs = [element.get("textRun", {}) for element in paragraph.get("elements", []) if element.get("textRun")]
    visible = [run for run in runs if run.get("content", "").strip()]
    return bool(visible) and all(
        run.get("textStyle", {}).get("weightedFontFamily", {}).get("fontFamily") == "Courier New"
        and "backgroundColor" in run.get("textStyle", {})
        for run in visible
    )


def _image_markdown_from_content(content: list[dict[str, Any]], start_index: int, doc: dict[str, Any]) -> tuple[str, int]:
    paragraph = content[start_index]["paragraph"]
    image_id = next(
        (
            element.get("inlineObjectElement", {}).get("inlineObjectId")
            for element in paragraph.get("elements", [])
            if element.get("inlineObjectElement")
        ),
        None,
    )
    if not image_id:
        return "", start_index + 1
    embedded = doc.get("inlineObjects", {}).get(image_id, {}).get("inlineObjectProperties", {}).get("embeddedObject", {})
    image_props = embedded.get("imageProperties", {})
    source = image_props.get("sourceUri") or image_props.get("contentUri") or f"inline-object:{image_id}"
    title = (embedded.get("title") or "").strip()
    description = (embedded.get("description") or "").strip()

    if start_index + 2 < len(content):
        next_paragraph = content[start_index + 1].get("paragraph")
        code_paragraph = content[start_index + 2].get("paragraph")
        if next_paragraph and code_paragraph:
            caption_text = _inline_markdown_from_paragraph(next_paragraph, doc, {}, allow_images=False).strip()
            code_start = _inline_markdown_from_paragraph(code_paragraph, doc, {}, allow_images=False).strip()
            if caption_text.startswith("source_type: mermaid") and code_start == "```mermaid":
                lines: list[str] = []
                cursor = start_index + 3
                while cursor < len(content):
                    para = content[cursor].get("paragraph")
                    if not para:
                        break
                    text = _inline_markdown_from_paragraph(para, doc, {}, allow_images=False).strip()
                    if text == "```":
                        return "```mermaid\n" + "\n".join(lines).rstrip() + "\n```", cursor + 1
                    lines.append(text)
                    cursor += 1

    alt = title or description.splitlines()[0].strip()
    return f"![{alt}]({source})", start_index + 1


def _list_prefix(paragraph: dict[str, Any], doc: dict[str, Any]) -> str:
    bullet = paragraph.get("bullet", {})
    list_id = bullet.get("listId")
    if not list_id:
        return ""
    level = int(bullet.get("nestingLevel", 0))
    levels = (doc.get("lists", {}).get(list_id, {}).get("listProperties", {}).get("nestingLevels", []) or [{}])
    level_def = levels[min(level, len(levels) - 1)] if levels else {}
    if level_def.get("glyphType") == "CHECKBOX" or (
        level_def.get("glyphType") == "GLYPH_TYPE_UNSPECIFIED" and "glyphSymbol" not in level_def and level_def.get("glyphFormat") == "%0"
    ):
        non_empty_runs = [run.get("textStyle", {}) for run in paragraph.get("elements", []) if run.get("textRun", {}).get("content", "").strip()]
        checked = bool(non_empty_runs) and all(style.get("strikethrough") is True for style in non_empty_runs)
        return f"- [{'x' if checked else ' '}] "
    if str(level_def.get("glyphFormat", "")).startswith("%"):
        return "1. "
    return "- "


def doc_to_markdown(value: str) -> str:
    document_id = _extract_doc_id(value)
    doc = _run_gws("docs", "documents", "get", params={"documentId": document_id})
    content = doc.get("body", {}).get("content", [])
    seen_footnotes: dict[str, str] = {}
    blocks: list[tuple[str, str]] = []
    index = 0
    while index < len(content):
        item = content[index]
        if "table" in item:
            table = item["table"]
            rows: list[list[str]] = []
            for row in table.get("tableRows", []):
                cells: list[str] = []
                for cell in row.get("tableCells", []):
                    parts: list[str] = []
                    for sub_item in cell.get("content", []):
                        paragraph = sub_item.get("paragraph")
                        if paragraph:
                            parts.append(_inline_markdown_from_paragraph(paragraph, doc, seen_footnotes, allow_images=False).strip())
                    cells.append("<br>".join(part for part in parts if part))
                rows.append(cells)
            if rows:
                aligns = []
                for cell in table.get("tableRows", [])[0].get("tableCells", []):
                    paragraphs = [sub.get("paragraph") for sub in cell.get("content", []) if sub.get("paragraph")]
                    alignment = (paragraphs[0].get("paragraphStyle", {}).get("alignment") if paragraphs else "START") or "START"
                    aligns.append(":---:" if alignment == "CENTER" else ("---:" if alignment == "END" else ":---"))
                header = "| " + " | ".join(rows[0]) + " |"
                divider = "| " + " | ".join(aligns or ["---"] * len(rows[0])) + " |"
                body_rows = ["| " + " | ".join(row) + " |" for row in rows[1:]]
                blocks.append(("table", "\n".join([header, divider, *body_rows])))
            index += 1
            continue

        paragraph = item.get("paragraph")
        if not paragraph:
            index += 1
            continue

        if any(element.get("inlineObjectElement") for element in paragraph.get("elements", [])):
            block, next_index = _image_markdown_from_content(content, index, doc)
            if block:
                blocks.append(("block", block))
            index = next_index
            continue

        text = _inline_markdown_from_paragraph(paragraph, doc, seen_footnotes, allow_images=False)
        named_style = paragraph.get("paragraphStyle", {}).get("namedStyleType", "NORMAL_TEXT")
        if text == "────────────────────────":
            blocks.append(("block", "---"))
            index += 1
            continue
        if paragraph.get("bullet"):
            blocks.append(("list", _list_prefix(paragraph, doc) + text))
            index += 1
            continue
        if named_style.startswith("HEADING_"):
            level = int(named_style.split("_")[-1])
            blocks.append(("block", "#" * level + " " + text))
            index += 1
            continue
        style = paragraph.get("paragraphStyle", {})
        if style.get("borderLeft") and style.get("shading"):
            match = re.match(r"^(NOTE|TIP|WARNING|IMPORTANT|CAUTION):\s*(.*)$", text, re.DOTALL)
            if match:
                body = match.group(2).strip()
                lines = [f"> [!{match.group(1)}]"] + ([f"> {line}" for line in body.splitlines()] if body else [])
                blocks.append(("block", "\n".join(lines)))
            else:
                blocks.append(("block", "> " + text.replace("\n", "\n> ")))
            index += 1
            continue
        if style.get("borderLeft") or style.get("indentStart", {}).get("magnitude", 0) > 0:
            blocks.append(("block", "> " + text.replace("\n", "\n> ")))
            index += 1
            continue
        if text:
            blocks.append(("block", text))
        index += 1

    chunks: list[str] = []
    previous_kind = ""
    for kind, value in blocks:
        if not value:
            continue
        if chunks:
            chunks.append("\n" if kind == previous_kind == "list" else "\n\n")
        chunks.append(value)
        previous_kind = kind

    if seen_footnotes:
        footnote_lines = []
        for footnote_id, number in sorted(seen_footnotes.items(), key=lambda item: int(item[1]) if str(item[1]).isdigit() else 9999):
            definition = _footnote_definition_markdown(doc, footnote_id, seen_footnotes)
            footnote_lines.append(f"[^{number}]: {definition}".rstrip())
        if chunks:
            chunks.append("\n\n")
        chunks.append("\n".join(footnote_lines))
    return "".join(chunks).strip() + "\n"


def _extract_doc_id(value: str) -> str:
    match = re.search(r"/d/([a-zA-Z0-9_-]+)", value)
    return match.group(1) if match else value


def _code_style(style: dict[str, Any]) -> bool:
    return style.get("weightedFontFamily", {}).get("fontFamily") == "Courier New" and "backgroundColor" in style


def _wrap_markdown(text: str, style: dict[str, Any]) -> str:
    wrapped = text.replace("\n", " ")
    if _code_style(style):
        wrapped = f"`{wrapped}`"
    if style.get("strikethrough"):
        wrapped = f"~~{wrapped}~~"
    if style.get("italic"):
        wrapped = f"*{wrapped}*"
    if style.get("bold"):
        wrapped = f"**{wrapped}**"
    if style.get("link", {}).get("url"):
        wrapped = f"[{wrapped}]({style['link']['url']})"
    return wrapped


def _inline_markdown_from_elements(elements: list[dict[str, Any]], footnote_numbers: dict[str, int]) -> str:
    parts: list[str] = []
    for element in elements:
        if element.get("textRun"):
            run = element["textRun"]
            content = run.get("content", "")
            if content == "\n":
                continue
            parts.append(_wrap_markdown(content, run.get("textStyle", {})))
        elif element.get("footnoteReference"):
            footnote_id = element["footnoteReference"]["footnoteId"]
            if footnote_id not in footnote_numbers:
                footnote_numbers[footnote_id] = len(footnote_numbers) + 1
            parts.append(f"[^{footnote_numbers[footnote_id]}]")
    return "".join(parts).strip()


def _paragraph_text(paragraph: dict[str, Any]) -> str:
    return "".join(element.get("textRun", {}).get("content", "") for element in paragraph.get("elements", [])).strip()


def _is_checkbox_list(paragraph: dict[str, Any], doc: dict[str, Any]) -> bool:
    list_id = paragraph.get("bullet", {}).get("listId")
    if not list_id:
        return False
    level = (doc.get("lists", {}).get(list_id, {}).get("listProperties", {}).get("nestingLevels", [{}]) or [{}])[0]
    return level.get("glyphType") == "CHECKBOX" or (level.get("glyphType") == "GLYPH_TYPE_UNSPECIFIED" and "glyphSymbol" not in level and level.get("glyphFormat") == "%0")


def _is_ordered_list(paragraph: dict[str, Any], doc: dict[str, Any]) -> bool:
    list_id = paragraph.get("bullet", {}).get("listId")
    if not list_id:
        return False
    level = (doc.get("lists", {}).get(list_id, {}).get("listProperties", {}).get("nestingLevels", [{}]) or [{}])[0]
    return level.get("glyphType") in {"DECIMAL", "ROMAN", "ALPHA", "UPPERALPHA", "UPPERROMAN"} or str(level.get("glyphFormat", "")).startswith("%0.")


def _paragraph_fully_struck(paragraph: dict[str, Any]) -> bool:
    saw_text = False
    for element in paragraph.get("elements", []):
        run = element.get("textRun")
        if not run:
            continue
        content = run.get("content", "").strip()
        if not content:
            continue
        saw_text = True
        if not run.get("textStyle", {}).get("strikethrough"):
            return False
    return saw_text


def _callout_variant_from_paragraph(paragraph: dict[str, Any]) -> str | None:
    text = _paragraph_text(paragraph)
    for variant in CALLOUT_TYPES:
        if text.startswith(f"{variant}: "):
            return variant
    return None


def _image_markdown(paragraph: dict[str, Any], doc: dict[str, Any], caption: str | None) -> str | None:
    for element in paragraph.get("elements", []):
        inline = element.get("inlineObjectElement")
        if not inline:
            continue
        object_id = inline.get("inlineObjectId")
        embedded = doc.get("inlineObjects", {}).get(object_id, {}).get("inlineObjectProperties", {}).get("embeddedObject", {})
        uri = embedded.get("imageProperties", {}).get("contentUri") or embedded.get("imageProperties", {}).get("sourceUri")
        alt = embedded.get("title") or embedded.get("description") or caption or ""
        if uri:
            return f"![{alt}]({uri})"
    return None


def _footnote_definition_markdown(footnote: dict[str, Any], footnote_numbers: dict[str, int]) -> str:
    parts: list[str] = []
    for item in footnote.get("content", []):
        paragraph = item.get("paragraph")
        if not paragraph:
            continue
        text = _inline_markdown_from_elements(paragraph.get("elements", []), footnote_numbers)
        if text:
            parts.append(text)
    return " ".join(parts).strip()


def doc_to_markdown(doc_id_or_url: str) -> str:
    doc = _run_gws("docs", "documents", "get", params={"documentId": _extract_doc_id(doc_id_or_url)})
    content = doc.get("body", {}).get("content", [])
    footnote_numbers: dict[str, int] = {}
    lines: list[str] = []
    index = 0
    while index < len(content):
        item = content[index]
        paragraph = item.get("paragraph")
        if paragraph:
            para_text = _paragraph_text(paragraph)
            if any(element.get("horizontalRule") for element in paragraph.get("elements", [])) or para_text == "────────────────────────":
                lines.append("---")
                index += 1
                continue
            if _paragraph_is_code_block(paragraph):
                code_lines = [para_text.rstrip("\n")]
                index += 1
                while index < len(content):
                    next_para = content[index].get("paragraph")
                    if not next_para or not _paragraph_is_code_block(next_para):
                        break
                    code_lines.append(_paragraph_text(next_para).rstrip("\n"))
                    if _paragraph_text(next_para).strip() == "```":
                        index += 1
                        break
                    index += 1
                lines.append("\n".join(code_lines).rstrip())
                continue
            if any(element.get("inlineObjectElement") for element in paragraph.get("elements", [])):
                next_para = content[index + 1].get("paragraph") if index + 1 < len(content) and content[index + 1].get("paragraph") else None
                next_text = _paragraph_text(next_para) if next_para else ""
                third_para = content[index + 2].get("paragraph") if index + 2 < len(content) and content[index + 2].get("paragraph") else None
                third_text = _paragraph_text(third_para) if third_para else ""
                if next_text.startswith("source_type: mermaid") and third_text.startswith("```mermaid"):
                    lines.append(third_text)
                    index += 3
                    continue
                image_md = _image_markdown(paragraph, doc, None)
                if image_md:
                    lines.append(image_md)
                index += 1
                continue
            named_style = paragraph.get("paragraphStyle", {}).get("namedStyleType", "")
            inline_md = _inline_markdown_from_elements(paragraph.get("elements", []), footnote_numbers)
            if named_style.startswith("HEADING_"):
                level = int(named_style.split("_")[-1])
                lines.append(f"{'#' * level} {inline_md}".rstrip())
            elif paragraph.get("bullet"):
                if _is_checkbox_list(paragraph, doc):
                    marker = "[x]" if _paragraph_fully_struck(paragraph) else "[ ]"
                    lines.append(f"- {marker} {inline_md}".rstrip())
                elif _is_ordered_list(paragraph, doc):
                    lines.append(f"1. {inline_md}".rstrip())
                else:
                    lines.append(f"- {inline_md}".rstrip())
            elif paragraph.get("paragraphStyle", {}).get("borderLeft"):
                variant = _callout_variant_from_paragraph(paragraph)
                if variant:
                    body = para_text.strip()
                    if body.startswith(f"{variant}: "):
                        body = body[len(f"{variant}: ") :].strip()
                    lines.append(f"> [!{variant}]")
                    if body:
                        for part in body.split("\n"):
                            lines.append(f"> {part}".rstrip())
                else:
                    for part in inline_md.split("\n"):
                        lines.append(f"> {part}".rstrip())
            elif inline_md:
                lines.append(inline_md)
            index += 1
            continue
        table = item.get("table")
        if table:
            rows_md: list[list[str]] = []
            aligns: list[str] = []
            for row in table.get("tableRows", []):
                row_md: list[str] = []
                row_aligns: list[str] = []
                for cell in row.get("tableCells", []):
                    cell_para = next((entry.get("paragraph") for entry in cell.get("content", []) if entry.get("paragraph")), {"elements": [], "paragraphStyle": {}})
                    row_md.append(_inline_markdown_from_elements(cell_para.get("elements", []), footnote_numbers))
                    row_aligns.append(cell_para.get("paragraphStyle", {}).get("alignment", "START"))
                rows_md.append(row_md)
                if not aligns:
                    aligns = row_aligns
            if rows_md:
                lines.append("| " + " | ".join(rows_md[0]) + " |")
                align_markers = {"START": ":---", "CENTER": ":---:", "END": "---:"}
                lines.append("| " + " | ".join(align_markers.get(alignment, "---") for alignment in aligns) + " |")
                for row in rows_md[1:]:
                    lines.append("| " + " | ".join(row) + " |")
            index += 1
            continue
        index += 1
    if footnote_numbers:
        lines.append("")
        for footnote_id, number in sorted(footnote_numbers.items(), key=lambda item: item[1]):
            definition = _footnote_definition_markdown(doc.get("footnotes", {}).get(footnote_id, {}), footnote_numbers)
            lines.append(f"[^{number}]: {definition}".rstrip())
    return "\n\n".join(line for line in lines if line is not None).strip() + "\n"


def _build_parser() -> argparse.ArgumentParser:
    return argparse.ArgumentParser(
        description="Convert Markdown into a structurally-native Google Doc.",
        epilog=(
            "CLI mode:\n"
            "  python md_to_gdoc.py [--title TITLE] [--json-output] [--into DOC_ID] [--into-mode replace|append] markdown_file\n"
            "  python md_to_gdoc.py --doc-to-markdown <doc_id_or_url>\n"
            "  python md_to_gdoc.py --json-output - < input.md\n"
            "  default output is the plain document URL; --json-output emits documentId/url/title JSON.\n"
            "  --into defaults to replace; --into-mode append appends to the existing document body.\n\n"
            "Library mode:\n"
            "  from md_to_gdoc import convert, convert_text, convert_metadata, convert_text_metadata, parse_to_ir"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    parser.add_argument("--dump-ir", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("markdown_file", nargs="?", help="Markdown file path, or '-' to read from stdin")
    parser.add_argument("--title", help="Override the Google Doc title")
    parser.add_argument("--into", help="Replace the body of an existing Google Doc ID instead of creating a new doc")
    parser.add_argument("--into-mode", choices=["replace", "append"], help="Existing-doc write mode when --into/frontmatter gdoc_id is used (default: replace)")
    parser.add_argument("--doc-to-markdown", help="Export an existing Google Doc ID or URL back to Markdown")
    parser.add_argument("--json-output", action="store_true", help="Print JSON metadata instead of the plain URL")
    parser.add_argument("--tab-id", help="Target a specific document tab for content insertion")
    args = parser.parse_args(argv)

    try:
        if args.doc_to_markdown:
            print(doc_to_markdown(args.doc_to_markdown), end="")
            return 0
        if not args.markdown_file:
            parser.error("markdown_file is required unless --doc-to-markdown is used")
        if args.markdown_file == "-":
            payload = sys.stdin.read()
            if args.dump_ir:
                print(json.dumps(parse_to_ir(_strip_frontmatter(payload)[0]), ensure_ascii=False))
                return 0
            metadata = convert_text_metadata(payload, title=args.title, into=args.into, into_mode=args.into_mode, tab_id=args.tab_id)
        else:
            if args.dump_ir:
                print(json.dumps(parse_to_ir(_strip_frontmatter(Path(args.markdown_file).read_text(encoding="utf-8"))[0]), ensure_ascii=False))
                return 0
            metadata = convert_metadata(Path(args.markdown_file), title=args.title, into=args.into, into_mode=args.into_mode, tab_id=args.tab_id)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(metadata, ensure_ascii=False) if args.json_output else metadata["url"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
