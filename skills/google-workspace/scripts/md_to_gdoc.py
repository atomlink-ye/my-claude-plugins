#!/usr/bin/env -S uv run --script
# /// script
# dependencies = [
#   "markdown-it-py>=3.0.0",
# ]
# ///

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

try:
    from markdown_it import MarkdownIt
except ModuleNotFoundError:  # pragma: no cover - exercised in bare-python acceptance path
    MarkdownIt = None  # type: ignore[assignment]


MONO = {"fontFamily": "Courier New", "weight": 400}
LIGHT_GRAY = {"color": {"rgbColor": {"red": 0.95, "green": 0.95, "blue": 0.95}}}
MID_GRAY = {"color": {"rgbColor": {"red": 0.45, "green": 0.45, "blue": 0.45}}}

IR = list[dict[str, Any]]


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
    raise RuntimeError("gws did not return JSON output")


def _run_gws(*args: str, json_body: dict[str, Any] | None = None, params: dict[str, Any] | None = None) -> dict[str, Any]:
    cmd = ["gws", *args]
    if params is not None:
        cmd += ["--params", json.dumps(params)]
    if json_body is not None:
        cmd += ["--json", json.dumps(json_body)]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or f"gws failed: {' '.join(cmd)}")
    return _json_from_gws_output(proc.stdout)


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def _append_index(doc: dict[str, Any]) -> int:
    return doc["body"]["content"][-1]["endIndex"] - 1


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


def _inline_to_text_and_runs(children: list[Any]) -> tuple[str, list[dict[str, Any]]]:
    parts: list[str] = []
    runs: list[dict[str, Any]] = []
    offset = 0
    bold = 0
    italic = 0
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
        elif child.type == "link_open":
            link_stack.append(child.attrGet("href") or "")
        elif child.type == "link_close":
            if link_stack:
                link_stack.pop()
        elif child.type == "image":
            add(child.content or child.attrGet("src") or "")
    return "".join(parts), runs


def parse_to_ir(markdown_text: str) -> IR:
    if MarkdownIt is None:
        return _parse_to_ir_via_uv(markdown_text)
    md = MarkdownIt("commonmark").enable("table")
    tokens = md.parse(markdown_text)
    blocks: IR = []
    index = 0
    while index < len(tokens):
        token = tokens[index]

        if token.type == "heading_open":
            text, runs = _inline_to_text_and_runs(tokens[index + 1].children or [])
            blocks.append({"type": "heading", "level": int(token.tag[1]), "text": text, "runs": runs})
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
                text, runs = _inline_to_text_and_runs(children)
                blocks.append({"type": "paragraph", "text": text, "runs": runs})
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
                            text, runs = _inline_to_text_and_runs(tokens[index + 1].children or [])
                            items.append({"text": text, "runs": runs})
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

        if token.type == "table_open":
            rows: list[list[str]] = []
            index += 1
            while tokens[index].type != "table_close":
                if tokens[index].type == "tr_open":
                    row: list[str] = []
                    index += 1
                    while tokens[index].type != "tr_close":
                        if tokens[index].type in {"th_open", "td_open"}:
                            row.append(_inline_to_text_and_runs(tokens[index + 1].children or [])[0])
                            index += 3
                        else:
                            index += 1
                    rows.append(row)
                index += 1
            blocks.append({"type": "table", "rows": rows})
            index += 1
            continue

        index += 1

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


def _insert_text_block(doc_id: str, text: str, runs: list[dict[str, Any]], named_style: str = "NORMAL_TEXT") -> None:
    doc = _run_gws("docs", "documents", "get", params={"documentId": doc_id})
    index = _append_index(doc)
    payload = text + "\n"
    end = index + _utf16_len(payload)
    requests: list[dict[str, Any]] = [{"insertText": {"location": {"index": index}, "text": payload}}]
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
    _run_gws("docs", "documents", "batchUpdate", params={"documentId": doc_id}, json_body={"requests": requests})


def _insert_list(doc_id: str, items: list[dict[str, Any]], ordered: bool) -> None:
    doc = _run_gws("docs", "documents", "get", params={"documentId": doc_id})
    index = _append_index(doc)
    payload_parts: list[str] = []
    runs: list[dict[str, Any]] = []
    offset = 0
    for item in items:
        line = item["text"] + "\n"
        payload_parts.append(line)
        for run in item["runs"]:
            runs.append({"start": offset + run["start"], "end": offset + run["end"], "style": run["style"]})
        offset += _utf16_len(line)
    payload = "".join(payload_parts)
    end = index + _utf16_len(payload)
    requests: list[dict[str, Any]] = [
        {"insertText": {"location": {"index": index}, "text": payload}},
        {
            "createParagraphBullets": {
                "range": {"startIndex": index, "endIndex": end},
                "bulletPreset": "NUMBERED_DECIMAL_ALPHA_ROMAN" if ordered else "BULLET_DISC_CIRCLE_SQUARE",
            }
        },
    ]
    for run in runs:
        request = _text_style_request(index + run["start"], index + run["end"], run["style"])
        if request:
            requests.append(request)
    _run_gws("docs", "documents", "batchUpdate", params={"documentId": doc_id}, json_body={"requests": requests})


def _insert_code_block(doc_id: str, code: str, info: str = "") -> None:
    fence = f"```{info}\n{code.rstrip()}\n```"
    runs = [{"start": 0, "end": _utf16_len(fence), "style": {"code": True}}]
    _insert_text_block(doc_id, fence, runs)


def _insert_image(doc_id: str, uri: str) -> None:
    doc = _run_gws("docs", "documents", "get", params={"documentId": doc_id})
    _run_gws(
        "docs",
        "documents",
        "batchUpdate",
        params={"documentId": doc_id},
        json_body={"requests": [{"insertInlineImage": {"location": {"index": _append_index(doc)}, "uri": uri}}]},
    )


def _insert_caption(doc_id: str, text: str) -> None:
    doc = _run_gws("docs", "documents", "get", params={"documentId": doc_id})
    index = _append_index(doc)
    requests = [
        {"insertText": {"location": {"index": index}, "text": text + "\n"}},
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


def _insert_table(doc_id: str, rows: list[list[str]]) -> None:
    if not rows:
        return
    doc = _run_gws("docs", "documents", "get", params={"documentId": doc_id})
    _run_gws(
        "docs",
        "documents",
        "batchUpdate",
        params={"documentId": doc_id},
        json_body={"requests": [{"insertTable": {"rows": len(rows), "columns": len(rows[0]), "location": {"index": _append_index(doc)}}}]},
    )
    table = _latest_table(_run_gws("docs", "documents", "get", params={"documentId": doc_id}))
    fills: list[tuple[int, str, bool]] = []
    for row_index, row in enumerate(table["tableRows"]):
        for column_index, cell in enumerate(row["tableCells"]):
            text = rows[row_index][column_index] if column_index < len(rows[row_index]) else ""
            if text:
                fills.append((cell["content"][0]["startIndex"], text, row_index == 0))
    requests: list[dict[str, Any]] = []
    for start, text, is_header in sorted(fills, reverse=True):
        requests.append({"insertText": {"location": {"index": start}, "text": text}})
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
    _run_gws("docs", "documents", "batchUpdate", params={"documentId": doc_id}, json_body={"requests": requests})


def render_ir_to_doc(ir: IR, title: str | None = None, *, into: str | None = None) -> str:
    if into:
        raise NotImplementedError("--into / append-into-existing-doc mode is reserved for future work and is not implemented in v0.1")
    doc_title = (title or _title_from_ir(ir, "Untitled")).strip() or "Untitled"
    doc_id = _run_gws("docs", "documents", "create", json_body={"title": doc_title})["documentId"]

    for block in ir:
        kind = block["type"]
        if kind == "heading":
            _insert_text_block(doc_id, block["text"], block["runs"], f"HEADING_{min(block['level'], 6)}")
        elif kind == "paragraph":
            _insert_text_block(doc_id, block["text"], block["runs"])
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

    return f"https://docs.google.com/document/d/{doc_id}/edit"


def convert(path: str | Path, title: str | None = None, *, into: str | None = None) -> str:
    source_path = Path(path)
    markdown_text = source_path.read_text(encoding="utf-8")
    ir = parse_to_ir(markdown_text)
    doc_title = title or _title_from_ir(ir, source_path.stem)
    return render_ir_to_doc(ir, doc_title, into=into)


def convert_text(markdown_str: str, title: str | None = None, *, into: str | None = None) -> str:
    ir = parse_to_ir(markdown_str)
    doc_title = title or _title_from_ir(ir, "Untitled")
    return render_ir_to_doc(ir, doc_title, into=into)


def _build_parser() -> argparse.ArgumentParser:
    return argparse.ArgumentParser(
        description="Convert Markdown into a structurally-native Google Doc.",
        epilog=(
            "CLI mode:\n"
            "  python md_to_gdoc.py [--title TITLE] [--into DOC_ID] markdown_file\n"
            "  python md_to_gdoc.py - < input.md\n\n"
            "Library mode:\n"
            "  from md_to_gdoc import convert, convert_text, parse_to_ir, render_ir_to_doc"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    parser.add_argument("--dump-ir", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("markdown_file", help="Markdown file path, or '-' to read from stdin")
    parser.add_argument("--title", help="Override the Google Doc title")
    parser.add_argument("--into", help="Append into an existing Google Doc ID (reserved for future work)")
    args = parser.parse_args(argv)

    try:
        if args.markdown_file == "-":
            payload = sys.stdin.read()
            if args.dump_ir:
                print(json.dumps(parse_to_ir(payload), ensure_ascii=False))
                return 0
            url = convert_text(payload, title=args.title, into=args.into)
        else:
            if args.dump_ir:
                print(json.dumps(parse_to_ir(Path(args.markdown_file).read_text(encoding="utf-8")), ensure_ascii=False))
                return 0
            url = convert(Path(args.markdown_file), title=args.title, into=args.into)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print(url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
