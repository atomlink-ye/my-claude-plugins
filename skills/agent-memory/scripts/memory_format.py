"""Deterministic stdlib-only output renderers for the Agent Memory CLI.

The YAML writer intentionally emits a small JSON-compatible YAML subset.  JSON
quoted strings, JSON booleans/null, and simple block collections are understood
by both YAML 1.1 and YAML 1.2 parsers without adding a runtime dependency.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any, Iterable

_PLAIN_KEY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_-]*\Z")
_YAML_BOOL_OR_NULL = {"null", "true", "false", "yes", "no", "on", "off", "y", "n", "~"}
_YAML_NUMBER_RE = re.compile(
    r"[-+]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?\Z"
)


def _yaml_key(value: object) -> str:
    """Render a mapping key while avoiding YAML's implicit key typing."""
    text = str(value)
    lowered = text.casefold()
    if (
        _PLAIN_KEY_RE.fullmatch(text)
        and lowered not in _YAML_BOOL_OR_NULL
        and not _YAML_NUMBER_RE.fullmatch(text)
    ):
        return text
    return json.dumps(text, ensure_ascii=False)


def _yaml_scalar(value: object) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            return ".nan"
        if math.isinf(value):
            return ".inf" if value > 0 else "-.inf"
        return str(value)
    # JSON strings are valid YAML double-quoted scalars. Always quoting strings
    # avoids YAML's implicit typing (for example, a title of "yes" stays a string).
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    raise TypeError(f"unsupported YAML scalar: {type(value).__name__}")


def _is_scalar(value: object) -> bool:
    return value is None or isinstance(value, (str, int, float, bool))


def _yaml_mapping_item(
    key: object, value: object, indent: int, prefix: str = ""
) -> list[str]:
    """Render one mapping item, including nested collections."""
    key_text = _yaml_key(key)
    if _is_scalar(value):
        return [f"{prefix}{key_text}: {_yaml_scalar(value)}"]
    if isinstance(value, dict) and not value:
        return [f"{prefix}{key_text}: {{}}"]
    if isinstance(value, list) and not value:
        return [f"{prefix}{key_text}: []"]
    return [f"{prefix}{key_text}:", yaml_dump(value, indent + 2)]


def yaml_dump(value: object, indent: int = 0) -> str:
    """Serialize JSON-shaped data to a deterministic, parseable YAML subset."""
    prefix = " " * indent
    if _is_scalar(value):
        return prefix + _yaml_scalar(value)
    if isinstance(value, dict):
        if not value:
            return prefix + "{}"
        lines: list[str] = []
        for key, item in value.items():
            lines.extend(_yaml_mapping_item(key, item, indent, prefix))
        return "\n".join(lines)
    if isinstance(value, list):
        if not value:
            return prefix + "[]"
        lines: list[str] = []
        for item in value:
            if _is_scalar(item):
                lines.append(f"{prefix}- {_yaml_scalar(item)}")
            elif isinstance(item, dict):
                if not item:
                    lines.append(f"{prefix}- {{}}")
                    continue
                first, *rest = item.items()
                lines.extend(
                    _yaml_mapping_item(first[0], first[1], indent + 2, f"{prefix}- ")
                )
                for key, child in rest:
                    lines.extend(
                        _yaml_mapping_item(key, child, indent + 2, f"{prefix}  ")
                    )
            elif isinstance(item, (dict, list)):
                lines.append(f"{prefix}-")
                lines.append(yaml_dump(item, indent + 2))
            else:
                raise TypeError(f"unsupported YAML value: {type(item).__name__}")
        return "\n".join(lines)
    raise TypeError(f"unsupported YAML value: {type(value).__name__}")


def _display(value: object, limit: int = 64) -> str:
    if value is None:
        text = ""
    elif isinstance(value, list):
        text = ", ".join(_display(item, limit=limit) for item in value)
    elif isinstance(value, dict):
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    elif isinstance(value, float):
        text = f"{value:.3f}"
    else:
        text = str(value)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def render_table(headers: Iterable[str], rows: Iterable[Iterable[object]]) -> str:
    """Render a compact box-drawing table without terminal-width dependencies."""
    header_cells = [str(header) for header in headers]
    if not header_cells:
        return "(no columns)"
    raw_rows = [list(row) for row in rows]
    row_cells = [
        [_display(value) for value in row[: len(header_cells)]]
        + [""] * max(0, len(header_cells) - len(row))
        for row in raw_rows
    ]
    widths = [len(header) for header in header_cells]
    for row in row_cells:
        widths = [max(width, len(cell)) for width, cell in zip(widths, row)]

    def border(left: str, middle: str, right: str) -> str:
        return left + middle.join("─" * (width + 2) for width in widths) + right

    def line(cells: list[str]) -> str:
        return (
            "│"
            + "│".join(f" {cell:<{width}} " for cell, width in zip(cells, widths))
            + "│"
        )

    output = [border("┌", "┬", "┐"), line(header_cells), border("├", "┼", "┤")]
    output.extend(line(row) for row in row_cells)
    output.append(border("└", "┴", "┘"))
    return "\n".join(output)


def _links_table(result: dict[str, Any]) -> str:
    document = result.get("document")
    sections: list[str] = []
    if isinstance(document, dict):
        sections.append(
            "Document\n"
            + render_table(
                ["id", "title", "path", "projects", "tags"],
                [
                    [
                        document.get("id", ""),
                        document.get("title", ""),
                        document.get("path", ""),
                        document.get("projects", ""),
                        document.get("tags", ""),
                    ]
                ],
            )
        )
    outbound = result.get("outbound", [])
    outbound_rows = []
    if isinstance(outbound, list):
        outbound_rows = [
            [
                "ok" if item.get("resolved") else "dangling",
                item.get("label", ""),
                item.get("href", ""),
                item.get("title") or "",
                item.get("path", ""),
            ]
            for item in outbound
            if isinstance(item, dict)
        ]
    sections.append(
        "Outbound\n"
        + render_table(
            ["status", "label", "href", "title", "path"],
            outbound_rows or [["", "(none)", "", "", ""]],
        )
    )
    inbound = result.get("inbound", [])
    inbound_rows = []
    if isinstance(inbound, list):
        inbound_rows = [
            [
                item.get("title", ""),
                item.get("label", ""),
                item.get("href", ""),
                item.get("path", ""),
            ]
            for item in inbound
            if isinstance(item, dict)
        ]
    sections.append(
        "Inbound\n"
        + render_table(
            ["title", "label", "href", "path"], inbound_rows or [["(none)", "", "", ""]]
        )
    )
    return "\n\n".join(sections)


def _doctor_table(result: dict[str, Any]) -> str:
    summary = result.get("summary")
    if isinstance(summary, dict):
        summary_text = " ".join(
            f"{key}={summary[key]}"
            for key in ("errors", "warnings", "info", "bindings", "documents")
            if key in summary
        )
    else:
        summary_text = _display(summary)
    sections = [f"status: {result.get('status', '')}", f"summary: {summary_text}"]
    checks = result.get("checks", [])
    rows = []
    if isinstance(checks, list):
        rows = [
            [
                item.get("severity", ""),
                item.get("code", ""),
                item.get("project", ""),
                item.get("message", ""),
                item.get("paths", ""),
                item.get("suggested_action", ""),
            ]
            for item in checks
            if isinstance(item, dict)
        ]
    sections.append(
        "Findings\n"
        + render_table(
            ["severity", "code", "project", "message", "paths", "suggested_action"],
            rows or [["", "(none)", "", "No problems found.", "", ""]],
        )
    )
    return "\n\n".join(sections)


def table_dump(command: str, result: object) -> str:
    """Choose concise columns for each CLI result shape."""
    if command in {"search", "list"} and isinstance(result, list):
        headers = ["id", "title", "brief", "projects", "tags"]
        if any(isinstance(item, dict) and "score" in item for item in result):
            headers.append("score")
        return render_table(
            headers,
            (
                [item.get(header, "") for header in headers]
                for item in result
                if isinstance(item, dict)
            ),
        )
    if command == "links" and isinstance(result, dict):
        return _links_table(result)
    if command == "projects" and isinstance(result, list):
        headers = [
            "project",
            "documents",
            "path",
            "capture_root",
            "memory_roots",
            "tags",
        ]
        return render_table(
            headers,
            (
                [item.get(header, "") for header in headers]
                for item in result
                if isinstance(item, dict)
            ),
        )
    if command == "tags" and isinstance(result, list):
        return render_table(
            ["tag", "count"],
            (
                [item.get("tag", ""), item.get("count", "")]
                for item in result
                if isinstance(item, dict)
            ),
        )
    if command == "browse" and isinstance(result, dict):
        rows = []
        for group in result.get("groups", []):
            if not isinstance(group, dict):
                continue
            scope = group.get("project", "")
            label = "shared" if scope == "_shared" else scope
            for document in group.get("documents", []):
                if isinstance(document, dict):
                    rows.append(
                        [
                            label,
                            document.get("title", ""),
                            document.get("brief", ""),
                            document.get("path", ""),
                        ]
                    )
        return render_table(
            ["scope", "title", "brief", "path"],
            rows or [["", "(none)", "", ""]],
        )
    if command == "doctor" and isinstance(result, dict):
        return _doctor_table(result)
    if isinstance(result, dict):
        return render_table(
            ["field", "value"], ((key, value) for key, value in result.items())
        )
    if isinstance(result, list):
        return render_table(["value"], ((item,) for item in result))
    return render_table(["value"], [(result,)])
