from __future__ import annotations

import json
import re
import subprocess
import sys


def extract_doc_id(value: str) -> str:
    match = re.search(r"/d/([a-zA-Z0-9_-]+)", value)
    return match.group(1) if match else value


def get_doc(document_id: str) -> dict:
    proc = subprocess.run(
        ["gws", "docs", "documents", "get", "--format", "json", "--params", json.dumps({"documentId": document_id})],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise SystemExit(
            f"gws get failed rc={proc.returncode} stderr={proc.stderr.strip()!r} stdout={proc.stdout.strip()[:1000]!r}"
        )
    return json_from_gws_output(proc.stdout)


def json_from_gws_output(stdout: str) -> dict:
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
        raise SystemExit(f"Unexpected gws JSON payload type: {type(data).__name__}")
    raise SystemExit(f"gws did not return JSON output; stdout preview={text[:500]!r}")


def walk_paragraphs(content: list[dict]):
    for item in content:
        if "paragraph" in item:
            yield item["paragraph"]
        if "table" in item:
            for row in item["table"].get("tableRows", []):
                for cell in row.get("tableCells", []):
                    yield from walk_paragraphs(cell.get("content", []))


def paragraph_text(paragraph: dict) -> str:
    return "".join(element.get("textRun", {}).get("content", "") for element in paragraph.get("elements", []))


def all_text(content: list[dict]) -> str:
    return "".join(paragraph_text(paragraph) for paragraph in walk_paragraphs(content))


def top_level_paragraphs(content: list[dict]) -> list[dict]:
    return [item["paragraph"] for item in content if "paragraph" in item]


def paragraph_runs(paragraph: dict) -> list[dict]:
    return [element.get("textRun", {}) for element in paragraph.get("elements", []) if element.get("textRun")]


def has_centered_horizontal_rule(content: list[dict]) -> bool:
    for paragraph in walk_paragraphs(content):
        if "────" not in paragraph_text(paragraph):
            continue
        if paragraph.get("paragraphStyle", {}).get("alignment") != "CENTER":
            continue
        return True
    return False


def has_table_style(content: list[dict], predicate) -> bool:
    for item in content:
        table = item.get("table")
        if not table:
            continue
        for row in table.get("tableRows", []):
            for cell in row.get("tableCells", []):
                for paragraph in walk_paragraphs(cell.get("content", [])):
                    for run in paragraph_runs(paragraph):
                        if predicate(run):
                            return True
    return False


def has_expected_table_alignment(content: list[dict]) -> bool:
    alignments: dict[str, str] = {}
    for item in content:
        table = item.get("table")
        if not table:
            continue
        for row in table.get("tableRows", []):
            for cell in row.get("tableCells", []):
                for paragraph in walk_paragraphs(cell.get("content", [])):
                    text = paragraph_text(paragraph).strip()
                    if text in {"Name", "Qty", "Note", "Apples", "3", "Bold cell with italic"}:
                        alignments[text] = paragraph.get("paragraphStyle", {}).get("alignment", "START")
    return alignments.get("Qty") == "CENTER" and alignments.get("Note") == "END"


def has_run_style(content: list[dict], text: str, predicate) -> bool:
    for paragraph in walk_paragraphs(content):
        for run in paragraph_runs(paragraph):
            if run.get("content", "").strip() == text and predicate(run.get("textStyle", {})):
                return True
    return False


def has_blockquote_fallback(content: list[dict]) -> bool:
    for paragraph in walk_paragraphs(content):
        if "Blockquote fallback" not in paragraph_text(paragraph):
            continue
        style = paragraph.get("paragraphStyle", {})
        if style.get("indentStart", {}).get("magnitude", 0) <= 0:
            continue
        if "borderLeft" not in style:
            continue
        if any(run.get("textStyle", {}).get("italic") is True for run in paragraph_runs(paragraph)):
            return True
    return False


def has_callout_fallback(content: list[dict]) -> bool:
    for paragraph in walk_paragraphs(content):
        if not paragraph_text(paragraph).strip().startswith("NOTE: Callout body"):
            continue
        style = paragraph.get("paragraphStyle", {})
        if style.get("indentStart", {}).get("magnitude", 0) <= 0:
            continue
        if "borderLeft" in style and "shading" in style:
            return True
    return False


def has_native_checklist(doc: dict, content: list[dict]) -> bool:
    lists = doc.get("lists", {})
    task_paragraphs = [p for p in walk_paragraphs(content) if "task item" in paragraph_text(p)]
    has_task_bullets = len(task_paragraphs) >= 2 and all("bullet" in p for p in task_paragraphs)
    task_list_ids = {p.get("bullet", {}).get("listId") for p in task_paragraphs if p.get("bullet", {}).get("listId")}
    has_checkbox_list_def = False
    for list_id in task_list_ids:
        first_level = (lists.get(list_id, {}).get("listProperties", {}).get("nestingLevels", [{}]) or [{}])[0]
        if first_level.get("glyphType") == "CHECKBOX" or (
            first_level.get("glyphType") == "GLYPH_TYPE_UNSPECIFIED" and "glyphSymbol" not in first_level and first_level.get("glyphFormat") == "%0"
        ):
            has_checkbox_list_def = True
    markers_removed = "[ ]" not in all_text(content) and "[x]" not in all_text(content) and "☐" not in all_text(content) and "☑" not in all_text(content)
    checked_struck = has_run_style(content, "checked task item", lambda style: style.get("strikethrough") is True)
    return has_checkbox_list_def and has_task_bullets and markers_removed and checked_struck


def heading_count(content: list[dict], text: str = "Sample Document") -> int:
    return sum(1 for paragraph in top_level_paragraphs(content) if paragraph_text(paragraph).strip() == text)


def appended_heading_starts_cleanly(content: list[dict]) -> bool:
    matches = [paragraph for paragraph in top_level_paragraphs(content) if paragraph_text(paragraph).strip() == "Sample Document"]
    return len(matches) < 2 or all(paragraph.get("paragraphStyle", {}).get("namedStyleType") == "HEADING_1" for paragraph in matches)


def main() -> int:
    document_id = extract_doc_id(sys.argv[1])
    doc = get_doc(document_id)
    content = doc["body"]["content"]
    has_heading_1 = any(p.get("paragraphStyle", {}).get("namedStyleType") == "HEADING_1" for p in walk_paragraphs(content))
    has_bullets = any("bullet" in p for p in walk_paragraphs(content))
    has_table = any(len(item.get("table", {}).get("tableRows", [])) >= 2 for item in content if "table" in item)
    has_image = len(doc.get("inlineObjects", {})) >= 1
    has_footnotes = len(doc.get("footnotes", {})) >= 1
    text = all_text(content)
    has_native_tasks = has_native_checklist(doc, content)
    has_horizontal_rule = has_centered_horizontal_rule(content)
    has_strikethrough = has_run_style(content, "strikethrough", lambda style: style.get("strikethrough") is True)
    has_blockquote = has_blockquote_fallback(content)
    has_callout = has_callout_fallback(content)
    has_table_bold = has_table_style(content, lambda run: run.get("content", "").strip() == "Bold cell" and run.get("textStyle", {}).get("bold") is True)
    has_table_code = has_table_style(
        content,
        lambda run: run.get("content", "").strip() == "code cell"
        and run.get("textStyle", {}).get("weightedFontFamily", {}).get("fontFamily") == "Courier New"
        and "backgroundColor" in run.get("textStyle", {}),
    )
    has_table_link = has_table_style(
        content,
        lambda run: run.get("content", "").strip() == "linked cell"
        and run.get("textStyle", {}).get("link", {}).get("url") == "https://example.com/table",
    )
    has_rich_table_text = has_table_bold and has_table_code and has_table_link
    has_table_alignment = has_expected_table_alignment(content)
    frontmatter_stripped = "into_mode:" not in text and "gdoc_id:" not in text
    append_boundary_ok = appended_heading_starts_cleanly(content)
    if all([has_heading_1, has_bullets, has_table, has_image, has_footnotes, has_native_tasks, has_horizontal_rule, has_rich_table_text, has_table_alignment, has_strikethrough, has_blockquote, has_callout, frontmatter_stripped, append_boundary_ok]):
        print("PASS")
        return 0
    print(
        "FAIL",
        json.dumps(
            {
                "has_heading_1": has_heading_1,
                "has_bullets": has_bullets,
                "has_table": has_table,
                "has_image": has_image,
                "has_footnotes": has_footnotes,
                "has_native_tasks": has_native_tasks,
                "has_horizontal_rule": has_horizontal_rule,
                "has_rich_table_text": has_rich_table_text,
                "has_table_alignment": has_table_alignment,
                "has_strikethrough": has_strikethrough,
                "has_blockquote": has_blockquote,
                "has_callout": has_callout,
                "frontmatter_stripped": frontmatter_stripped,
                "append_boundary_ok": append_boundary_ok,
                "sample_heading_count": heading_count(content),
            },
            indent=2,
        ),
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
