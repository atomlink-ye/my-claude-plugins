"""Administrative discovery and read-only health checks for Agent Memory."""

from __future__ import annotations

import os
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

from memory_config import (
    Binding,
    MemoryError,
    SHARED_SCOPE,
    _expand_path,
    collect_memory_roots,
    flatten_bindings,
    resolve_binding,
)

SEVERITY_ORDER = {"info": 0, "warning": 1, "error": 2}


def _iter_binding_nodes(
    settings: dict[str, Any],
) -> Iterable[tuple[dict[str, Any], Path]]:
    def visit(
        node: dict[str, Any], parent: Path | None
    ) -> Iterable[tuple[dict[str, Any], Path]]:
        raw = node.get("path")
        if not isinstance(raw, str) or not raw.strip():
            return
        path = _expand_path(raw, parent)
        yield node, path
        for child in (
            node.get("projects", [])
            if isinstance(node.get("projects", []), list)
            else []
        ):
            if isinstance(child, dict):
                yield from visit(child, path)

    for node in settings.get("bindings", []):
        if isinstance(node, dict):
            yield from visit(node, None)


def _binding_node(settings: dict[str, Any], binding: Binding) -> dict[str, Any] | None:
    matches = [
        node
        for node, path in _iter_binding_nodes(settings)
        if path == binding.path and node.get("project") == binding.project
    ]
    if len(matches) > 1:
        raise MemoryError(
            f"multiple settings nodes describe binding {binding.project!r} at {binding.path}"
        )
    return matches[0] if matches else None


def _memory_entries(
    node: dict[str, Any] | None, binding_path: Path
) -> list[tuple[Path, bool]]:
    if node is None:
        return []
    raw = node.get("memory", [])
    if raw is None:
        return []
    if isinstance(raw, (str, dict)):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    result: list[tuple[Path, bool]] = []
    for item in raw:
        if isinstance(item, str):
            result.append((_expand_path(item, binding_path), False))
        elif isinstance(item, dict) and isinstance(item.get("path"), str):
            result.append(
                (_expand_path(item["path"], binding_path), item.get("capture") is True)
            )
    return result


def preferred_capture_root(settings: dict[str, Any], binding: Binding) -> Path | None:
    marked = [
        path
        for path, capture in _memory_entries(
            _binding_node(settings, binding), binding.path
        )
        if capture
    ]
    if len(marked) > 1:
        raise MemoryError(
            f"project {binding.project!r} has multiple memory roots marked capture=true: "
            + ", ".join(str(path) for path in marked)
        )
    return marked[0] if marked else None


def project_inventory(
    conn: sqlite3.Connection, settings: dict[str, Any]
) -> list[dict[str, Any]]:
    counts = {
        row["scope"]: int(row["count"])
        for row in conn.execute(
            "SELECT scope,count(DISTINCT document_id) AS count FROM document_scopes GROUP BY scope"
        )
    }
    result = []
    for binding in sorted(
        flatten_bindings(settings), key=lambda item: (item.project, str(item.path))
    ):
        capture = preferred_capture_root(settings, binding)
        result.append(
            {
                "project": binding.project,
                "path": str(binding.path),
                "documents": counts.get(binding.project, 0),
                "memory_roots": [
                    str(location.path) for location in binding.memory_roots
                ],
                "capture_root": str(capture) if capture else None,
                "tags": list(binding.tags),
            }
        )
    return result


def tag_inventory(
    conn: sqlite3.Connection, project: str | None = None, include_shared: bool = True
) -> list[dict[str, Any]]:
    sql = "SELECT t.tag,count(DISTINCT t.document_id) AS count FROM document_tags t WHERE 1=1"
    params: list[Any] = []
    if project:
        scopes = [project] + ([SHARED_SCOPE] if include_shared else [])
        placeholders = ",".join("?" for _ in scopes)
        sql += f" AND EXISTS (SELECT 1 FROM document_scopes s WHERE s.document_id=t.document_id AND s.scope IN ({placeholders}))"
        params.extend(scopes)
    sql += " GROUP BY t.tag ORDER BY count DESC,lower(t.tag),t.tag"
    return [
        {"tag": row["tag"], "count": int(row["count"])}
        for row in conn.execute(sql, params)
    ]


def _finding(
    code: str,
    severity: str,
    message: str,
    *,
    project: str | None = None,
    paths: Iterable[str | Path] = (),
    suggested_action: str | None = None,
) -> dict[str, Any]:
    item: dict[str, Any] = {"code": code, "severity": severity, "message": message}
    if project:
        item["project"] = project
    path_list = [str(path) for path in paths]
    if path_list:
        item["paths"] = path_list
    if suggested_action:
        item["suggested_action"] = suggested_action
    return item


def _directory_writable(path: Path) -> bool:
    probe = path
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    return probe.is_dir() and os.access(probe, os.W_OK)


def doctor(
    conn: sqlite3.Connection,
    settings: dict[str, Any],
    settings_path: Path,
    db_path: Path,
    target_path: Path | None = None,
) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    bindings = flatten_bindings(settings)
    roots = collect_memory_roots(settings, settings_path)

    by_path: dict[Path, list[Binding]] = defaultdict(list)
    by_project: dict[str, list[Binding]] = defaultdict(list)
    for binding in bindings:
        by_path[binding.path].append(binding)
        by_project[binding.project].append(binding)
        if not binding.memory_roots:
            findings.append(
                _finding(
                    "project_has_no_memory_root",
                    "warning",
                    "project has no configured memory root",
                    project=binding.project,
                    paths=[binding.path],
                )
            )
        entries = _memory_entries(_binding_node(settings, binding), binding.path)
        marked = [path for path, capture in entries if capture]
        if len(marked) > 1:
            findings.append(
                _finding(
                    "capture_root_multiple",
                    "error",
                    "project has multiple memory roots marked capture=true",
                    project=binding.project,
                    paths=marked,
                    suggested_action="leave capture=true on exactly one memory root",
                )
            )
        elif len(binding.memory_roots) > 1 and not marked:
            findings.append(
                _finding(
                    "capture_root_ambiguous",
                    "warning",
                    "project has multiple memory roots and no default capture root",
                    project=binding.project,
                    paths=[location.path for location in binding.memory_roots],
                    suggested_action="mark one memory root with capture=true",
                )
            )
        elif marked and not _directory_writable(marked[0]):
            findings.append(
                _finding(
                    "capture_root_not_writable",
                    "error",
                    "configured capture root is not writable",
                    project=binding.project,
                    paths=marked,
                )
            )

    for path, values in by_path.items():
        if len(values) > 1:
            findings.append(
                _finding(
                    "binding_path_duplicate",
                    "error",
                    "multiple project bindings resolve to the same filesystem path",
                    paths=[path],
                )
            )
    for project, values in by_project.items():
        unique_paths = sorted({binding.path for binding in values}, key=str)
        if len(unique_paths) > 1:
            findings.append(
                _finding(
                    "project_name_reused",
                    "warning",
                    "the same project name is bound to multiple filesystem paths",
                    project=project,
                    paths=unique_paths,
                )
            )

    physical_scopes: dict[Path, set[str]] = defaultdict(set)
    for root in roots:
        physical_scopes[root.path].add(root.scope)
        if not root.path.exists():
            findings.append(
                _finding(
                    "memory_root_missing",
                    "warning",
                    "configured memory root does not exist",
                    project=None if root.shared else root.scope,
                    paths=[root.path],
                    suggested_action="create the directory or remove the stale settings entry",
                )
            )
        elif not root.path.is_dir():
            findings.append(
                _finding(
                    "memory_root_not_directory",
                    "error",
                    "memory root is not a directory",
                    paths=[root.path],
                )
            )
        elif not os.access(root.path, os.R_OK):
            findings.append(
                _finding(
                    "memory_root_not_readable",
                    "error",
                    "memory root is not readable",
                    paths=[root.path],
                )
            )
    for path, scopes in physical_scopes.items():
        project_scopes = [scope for scope in scopes if scope != SHARED_SCOPE]
        if len(project_scopes) > 1:
            findings.append(
                _finding(
                    "memory_root_multi_scope",
                    "warning",
                    "one physical memory root is visible in multiple project scopes",
                    paths=[path],
                    suggested_action="verify this overlap is intentional; use shared roots for intentionally global knowledge",
                )
            )

    if not _directory_writable(db_path.parent):
        findings.append(
            _finding(
                "database_parent_not_writable",
                "error",
                "database directory is not writable",
                paths=[db_path.parent],
            )
        )
    quick = conn.execute("PRAGMA quick_check").fetchone()[0]
    if str(quick).lower() != "ok":
        findings.append(
            _finding(
                "sqlite_quick_check_failed",
                "error",
                f"SQLite quick_check returned: {quick}",
                paths=[db_path],
            )
        )

    indexed_rows = list(conn.execute("SELECT id,path,mtime_ns,size FROM documents"))
    indexed_paths = {Path(row["path"]).resolve(strict=False) for row in indexed_rows}
    stale = 0
    changed = 0
    for row in indexed_rows:
        path = Path(row["path"])
        if not path.exists():
            stale += 1
            findings.append(
                _finding(
                    "indexed_file_missing",
                    "warning",
                    "indexed Markdown source no longer exists",
                    paths=[path],
                    suggested_action="run agent-memory sync",
                )
            )
        else:
            stat = path.stat()
            changed += int(
                stat.st_mtime_ns != int(row["mtime_ns"])
                or stat.st_size != int(row["size"])
            )
    if changed:
        findings.append(
            _finding(
                "index_source_changed",
                "warning",
                f"{changed} indexed Markdown file(s) changed since the last sync",
                suggested_action="run agent-memory sync",
            )
        )

    source_paths: set[Path] = set()
    for root in roots:
        if root.path.is_dir():
            source_paths.update(
                path.resolve(strict=False)
                for path in root.path.rglob("*.md")
                if path.is_file()
            )
    unindexed = sorted(source_paths - indexed_paths, key=str)
    if unindexed:
        findings.append(
            _finding(
                "markdown_unindexed",
                "warning",
                f"{len(unindexed)} Markdown file(s) under configured roots are not indexed",
                paths=unindexed[:20],
                suggested_action="run agent-memory sync",
            )
        )

    dangling = 0
    external_local = 0
    # Check the filesystem for every local link, not only links that were unresolved
    # when the last sync ran. A previously indexed target can be deleted afterwards;
    # its stored target_document_id remains non-null until sync removes that document.
    for row in conn.execute("SELECT target_path,target_document_id FROM links"):
        target = Path(row["target_path"])
        if not target.exists():
            dangling += 1
            findings.append(
                _finding(
                    "link_target_missing",
                    "warning",
                    "local Markdown link target does not exist",
                    paths=[target],
                )
            )
        elif row["target_document_id"] is None:
            external_local += 1
    if external_local:
        findings.append(
            _finding(
                "links_external_local",
                "info",
                f"{external_local} local link(s) point to existing files outside the indexed memory graph",
            )
        )

    tags = [
        row[0]
        for row in conn.execute("SELECT DISTINCT tag FROM document_tags ORDER BY tag")
    ]
    case_groups: dict[str, set[str]] = defaultdict(set)
    separator_groups: dict[str, set[str]] = defaultdict(set)
    for tag in tags:
        case_groups[tag.casefold()].add(tag)
        separator_groups[tag.casefold().replace("_", "-")].add(tag)
    for variants in case_groups.values():
        if len(variants) > 1:
            findings.append(
                _finding(
                    "tag_case_collision",
                    "warning",
                    "tags differ only by case",
                    paths=sorted(variants),
                )
            )
    for variants in separator_groups.values():
        if len(variants) > 1:
            findings.append(
                _finding(
                    "tag_separator_collision",
                    "warning",
                    "tags differ only by hyphen/underscore separators",
                    paths=sorted(variants),
                )
            )

    resolved: dict[str, Any] | None = None
    if target_path is not None:
        binding = resolve_binding(settings, target_path)
        capture = preferred_capture_root(settings, binding)
        resolved = {
            "path": str(target_path.resolve(strict=False)),
            "project": binding.project,
            "binding": str(binding.path),
            "memory_roots": [str(location.path) for location in binding.memory_roots],
            "capture_root": (
                str(capture)
                if capture
                else (
                    str(binding.memory_roots[0].path)
                    if len(binding.memory_roots) == 1
                    else None
                )
            ),
        }

    counts = Counter(item["severity"] for item in findings)
    state = "error" if counts["error"] else "warn" if counts["warning"] else "ok"
    findings.sort(
        key=lambda item: (
            -SEVERITY_ORDER[item["severity"]],
            item["code"],
            item.get("project", ""),
        )
    )
    return {
        "status": state,
        "summary": {
            "errors": counts["error"],
            "warnings": counts["warning"],
            "info": counts["info"],
            "bindings": len(bindings),
            "documents": len(indexed_rows),
            "dangling_links": dangling,
            "unindexed_markdown": len(unindexed),
            "stale_documents": stale,
        },
        "resolved": resolved,
        "checks": findings,
    }
