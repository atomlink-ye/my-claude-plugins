#!/usr/bin/env python3
"""CLI for the local, file-first Agent Memory registry."""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

from memory_admin import doctor, preferred_capture_root, project_inventory, tag_inventory
from memory_capture import KINDS, capture_memory
from memory_config import (
    MemoryError,
    collect_memory_roots,
    database_path,
    default_settings_path,
    init_settings,
    load_settings,
    resolve_binding,
    shared_roots,
)
from memory_format import table_dump, yaml_dump
from memory_snapshot import inspect_snapshot, search_snapshot, snapshot_registry
from memory_store import connect_db, link_graph, list_documents, search_documents, status, sync_index


def _human_documents(items: list[dict[str, object]]) -> None:
    for item in items:
        scopes = ",".join(item["projects"])
        tags = ",".join(item["tags"])
        score = f" score={item['score']:.3f}" if "score" in item else ""
        print(f"[{item['id']}] {item['title']}{score}")
        if item["brief"]:
            print(f"  {item['brief']}")
        print(f"  path: {item['path']}")
        print(f"  projects: {scopes or '-'}  tags: {tags or '-'}")


def _human_projects(items: list[dict[str, object]]) -> None:
    for item in items:
        print(f"{item['project']}  documents={item['documents']}")
        print(f"  path: {item['path']}")
        if item.get("capture_root"):
            print(f"  capture: {item['capture_root']}")
        if item.get("memory_roots"):
            print("  memory:")
            for root in item["memory_roots"]:
                print(f"    - {root}")


def _human_tags(items: list[dict[str, object]]) -> None:
    for item in items:
        print(f"{item['tag']}  {item['count']}")


def _human_links(result: dict[str, object]) -> None:
    document = result.get("document")
    if isinstance(document, dict):
        print(f"{document['title']}\n  {document['path']}")
    for direction in ("outbound", "inbound"):
        print(f"{direction}:")
        links = result.get(direction, [])
        if not links:
            print("  - (none)")
            continue
        for link in links:
            if direction == "outbound":
                marker = "ok" if link.get("resolved") else "dangling"
                print(f"  - [{marker}] {link['label']} -> {link['path']}")
            else:
                print(f"  - {link['title']} <- {link['path']}")


def _human_doctor(result: dict[str, object]) -> None:
    print("Agent Memory Doctor")
    resolved = result.get("resolved")
    if isinstance(resolved, dict):
        print(f"\nResolved project: {resolved['project']}")
        print(f"  binding: {resolved['binding']}")
        print(f"  capture: {resolved.get('capture_root') or '-'}")
    summary = result["summary"]
    print("\nSummary")
    print(
        f"  status={result['status']} errors={summary['errors']} warnings={summary['warnings']} "
        f"info={summary['info']} documents={summary['documents']} bindings={summary['bindings']}"
    )
    checks = result.get("checks", [])
    if checks:
        print("\nFindings")
        marker = {"error": "ERROR", "warning": "WARN", "info": "INFO"}
        for item in checks:
            scope = f" project={item['project']}" if item.get("project") else ""
            print(f"  {marker[item['severity']]} {item['code']}{scope}: {item['message']}")
            for path in item.get("paths", []):
                print(f"    {path}")
            if item.get("suggested_action"):
                print(f"    action: {item['suggested_action']}")
    else:
        print("\nNo problems found.")


def _doctor_failure(code: str, message: str, path: Path | None = None) -> dict[str, object]:
    finding: dict[str, object] = {"code": code, "severity": "error", "message": message}
    if path is not None:
        finding["paths"] = [str(path)]
    return {
        "status": "error",
        "summary": {
            "errors": 1,
            "warnings": 0,
            "info": 0,
            "bindings": 0,
            "documents": 0,
            "dangling_links": 0,
            "unindexed_markdown": 0,
            "stale_documents": 0,
        },
        "resolved": None,
        "checks": [finding],
    }


def _emit(result: object, command: str, output_format: str) -> None:
    if output_format == "json":
        print(json.dumps(result, indent=2, ensure_ascii=False))
    elif output_format == "table":
        print(table_dump(command, result))
    elif output_format == "text":
        if command in {"search", "list"} and isinstance(result, list):
            _human_documents(result)
        elif command == "projects" and isinstance(result, list):
            _human_projects(result)
        elif command == "tags" and isinstance(result, list):
            _human_tags(result)
        elif command == "links" and isinstance(result, dict):
            _human_links(result)
        elif command == "doctor" and isinstance(result, dict):
            _human_doctor(result)
        elif command == "init" and isinstance(result, dict):
            print(f"created {result['settings']}")
        else:
            print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(yaml_dump(result))


def _emit_doctor(result: dict[str, object], output_format: str) -> int:
    _emit(result, "doctor", output_format)
    return 2 if result["status"] == "error" else 1 if result["status"] == "warn" else 0


def _add_output_options(parser: argparse.ArgumentParser) -> None:
    """Add output switches to a parser without overriding a global selection.

    Registering the switches on both the root parser and each subparser means common
    forms such as ``agent-memory tags --table`` work alongside the established
    ``agent-memory --table tags`` spelling.  ``SUPPRESS`` matters here: a subparser
    with no output switch must leave a root-level choice intact.
    """
    formats = parser.add_mutually_exclusive_group()
    formats.add_argument("--json", dest="output_format", action="store_const", const="json", default=argparse.SUPPRESS, help="emit JSON")
    formats.add_argument("--table", dest="output_format", action="store_const", const="table", default=argparse.SUPPRESS, help="emit a box-drawing table")
    formats.add_argument("--text", dest="output_format", action="store_const", const="text", default=argparse.SUPPRESS, help="emit legacy human-readable text")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-memory", description="Local file-first memory registry")
    parser.add_argument("--settings", type=Path, default=default_settings_path(), help="settings.json path")
    _add_output_options(parser)
    parser.set_defaults(output_format="yaml")
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="create an empty settings.json")
    init.add_argument("--force", action="store_true")
    _add_output_options(init)
    status_parser = sub.add_parser("status", help="show registry status")
    _add_output_options(status_parser)
    sync_parser = sub.add_parser("sync", help="re-index all configured Markdown roots")
    _add_output_options(sync_parser)
    snapshot = sub.add_parser("snapshot", help="archive configured Markdown sources, settings, and SQLite index")
    _add_output_options(snapshot)
    snapshot.add_argument("--output", type=Path, help="directory for the generated .tar.gz (default: settings sibling snapshots/)")
    snapshot_actions = snapshot.add_subparsers(dest="snapshot_action")
    snapshot_inspect = snapshot_actions.add_parser("inspect", help="show project/root inventory recorded in a snapshot")
    _add_output_options(snapshot_inspect)
    snapshot_inspect.add_argument("archive", type=Path)
    snapshot_search = snapshot_actions.add_parser("search", help="search a snapshot's SQLite index without restoring it")
    _add_output_options(snapshot_search)
    snapshot_search.add_argument("archive", type=Path)
    snapshot_search.add_argument("query")
    snapshot_search.add_argument("--project")
    snapshot_search.add_argument("--tag", action="append", default=[])
    snapshot_search.add_argument("--limit", type=int, default=10)
    snapshot_search.add_argument("--no-shared", action="store_true")

    resolve = sub.add_parser("resolve", help="resolve a working path to its nearest project binding")
    _add_output_options(resolve)
    resolve.add_argument("--path", type=Path, default=Path.cwd())

    search = sub.add_parser("search", help="full-text and tag-aware search indexed memory")
    _add_output_options(search)
    search.add_argument("query")
    search.add_argument("--project")
    search.add_argument("--path", type=Path)
    search.add_argument("--tag", action="append", default=[])
    search.add_argument("--limit", type=int, default=10)
    search.add_argument("--no-shared", action="store_true")

    ls = sub.add_parser("list", help="list indexed memory documents")
    _add_output_options(ls)
    ls.add_argument("--project")
    ls.add_argument("--path", type=Path)
    ls.add_argument("--tag", action="append", default=[])
    ls.add_argument("--limit", type=int, default=100)
    ls.add_argument("--no-shared", action="store_true")

    links = sub.add_parser("links", help="show outbound references and inbound backlinks")
    _add_output_options(links)
    links.add_argument("document", help="document id, absolute path, or unique indexed path suffix")

    capture = sub.add_parser("capture", help="write a structured self-improvement memory and index it")
    _add_output_options(capture)
    capture.add_argument("kind", choices=sorted(KINDS))
    capture.add_argument("summary")
    capture.add_argument("--path", type=Path, default=Path.cwd(), help="actual project/worktree path used for scope resolution")
    capture.add_argument("--details", default="")
    capture.add_argument("--action", default="", help="suggested follow-up action")
    capture.add_argument("--tag", action="append", default=[])
    capture.add_argument("--related", action="append", default=[], help="related local file path; repeatable")
    capture.add_argument("--root", help="configured memory root override")

    projects = sub.add_parser("projects", help="list configured projects, roots, and indexed document counts")
    _add_output_options(projects)

    tags = sub.add_parser("tags", help="list canonical indexed tags and usage counts")
    _add_output_options(tags)
    tags.add_argument("--project")
    tags.add_argument("--path", type=Path)
    tags.add_argument("--no-shared", action="store_true")

    check = sub.add_parser("doctor", help="diagnose settings, routing, filesystem, index, links, and capture health")
    _add_output_options(check)
    check.add_argument("--path", type=Path, help="also resolve and diagnose one actual project/worktree path")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    raw_argv = sys.argv[1:] if argv is None else argv
    selected_formats = {argument for argument in raw_argv if argument in {"--json", "--table", "--text"}}
    if len(selected_formats) > 1:
        parser.error("--json, --table, and --text are mutually exclusive")
    args = parser.parse_args(raw_argv)
    settings_path = args.settings.expanduser().resolve(strict=False)

    if args.command == "init":
        try:
            init_settings(settings_path, args.force)
            result = {"settings": str(settings_path)}
            _emit(result, "init", args.output_format)
            return 0
        except (MemoryError, OSError) as exc:
            print(f"agent-memory: {exc}", file=sys.stderr)
            return 2

    # Doctor must diagnose bad/missing setup without creating or mutating the index.
    if args.command == "doctor":
        try:
            settings = load_settings(settings_path)
        except (MemoryError, OSError) as exc:
            return _emit_doctor(_doctor_failure("settings_invalid", str(exc), settings_path), args.output_format)
        try:
            db_path = database_path(settings, settings_path)
        except MemoryError as exc:
            return _emit_doctor(_doctor_failure("database_path_invalid", str(exc), settings_path), args.output_format)
        if not db_path.exists():
            return _emit_doctor(
                _doctor_failure("database_missing", "SQLite index does not exist; run agent-memory sync first", db_path),
                args.output_format,
            )
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            conn.row_factory = sqlite3.Row
            try:
                result = doctor(conn, settings, settings_path, db_path, args.path)
            finally:
                conn.close()
            return _emit_doctor(result, args.output_format)
        except (MemoryError, OSError, sqlite3.Error) as exc:
            return _emit_doctor(_doctor_failure("doctor_failed", str(exc), db_path), args.output_format)

    # Snapshot is source-read-only: do not open the registry through connect_db(),
    # which may create a missing database or alter connection pragmas.
    if args.command == "snapshot":
        try:
            if args.snapshot_action == "inspect":
                result = inspect_snapshot(args.archive)
            elif args.snapshot_action == "search":
                result = search_snapshot(
                    args.archive,
                    args.query,
                    project=args.project,
                    tags=tuple(args.tag),
                    limit=args.limit,
                    include_shared=not args.no_shared,
                )
            else:
                settings = load_settings(settings_path)
                db_path = database_path(settings, settings_path)
                result = snapshot_registry(
                    settings,
                    settings_path,
                    db_path,
                    collect_memory_roots(settings, settings_path),
                    args.output,
                )
            _emit(result, "snapshot", args.output_format)
            return 0
        except (MemoryError, OSError, sqlite3.Error) as exc:
            print(f"agent-memory: {exc}", file=sys.stderr)
            return 2

    try:
        settings = load_settings(settings_path)
        db_path = database_path(settings, settings_path)
        conn = connect_db(db_path)
        try:
            if args.command == "status":
                result = status(conn, settings_path, db_path)
            elif args.command == "sync":
                result = sync_index(conn, collect_memory_roots(settings, settings_path))
            elif args.command == "resolve":
                binding = resolve_binding(settings, args.path)
                preferred = preferred_capture_root(settings, binding)
                result = {
                    "path": str(args.path.resolve(strict=False)),
                    "project": binding.project,
                    "binding": str(binding.path),
                    "memory": [{"path": str(location.path), "tags": list(location.tags)} for location in binding.memory_roots],
                    "capture_root": str(preferred) if preferred else (str(binding.memory_roots[0].path) if len(binding.memory_roots) == 1 else None),
                    "shared": [str(root.path) for root in shared_roots(settings, settings_path)],
                    "tags": list(binding.tags),
                }
            elif args.command in {"search", "list"}:
                if args.project and args.path:
                    raise MemoryError("use either --project or --path, not both")
                project = args.project
                if args.path:
                    project = resolve_binding(settings, args.path).project
                include_shared = not args.no_shared
                result = search_documents(conn, args.query, project, args.tag, args.limit, include_shared) if args.command == "search" else list_documents(conn, project, args.tag, args.limit, include_shared)
            elif args.command == "links":
                result = link_graph(conn, args.document)
            elif args.command == "capture":
                binding = resolve_binding(settings, args.path)
                preferred = preferred_capture_root(settings, binding)
                root = args.root or (str(preferred) if preferred else None)
                result = capture_memory(
                    binding,
                    args.kind,
                    args.summary,
                    details=args.details,
                    suggested_action=args.action,
                    tags=args.tag,
                    related=args.related,
                    root=root,
                )
                result["sync"] = sync_index(conn, collect_memory_roots(settings, settings_path))
            elif args.command == "projects":
                result = project_inventory(conn, settings)
            elif args.command == "tags":
                if args.project and args.path:
                    raise MemoryError("use either --project or --path, not both")
                project = args.project
                if args.path:
                    project = resolve_binding(settings, args.path).project
                result = tag_inventory(conn, project, not args.no_shared)
            else:
                parser.error("unknown command")
                return 2

            _emit(result, args.command, args.output_format)
            return 0
        finally:
            conn.close()
    except (MemoryError, OSError, sqlite3.Error) as exc:
        print(f"agent-memory: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
