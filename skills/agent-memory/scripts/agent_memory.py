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
from memory_store import (
    connect_db,
    link_graph,
    list_documents,
    search_documents,
    status,
    sync_index,
)


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
        capture = item.get("capture_root")
        if capture:
            print(f"  capture: {capture}")
        roots = item.get("memory_roots", [])
        if roots:
            print("  memory:")
            for root in roots:
                print(f"    - {root}")


def _human_tags(items: list[dict[str, object]]) -> None:
    for item in items:
        print(f"{item['tag']}  {item['count']}")


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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-memory", description="Local file-first memory registry")
    parser.add_argument("--settings", type=Path, default=default_settings_path(), help="settings.json path")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="create an empty settings.json")
    init.add_argument("--force", action="store_true")

    sub.add_parser("status", help="show registry status")
    sub.add_parser("sync", help="re-index all configured Markdown roots")

    resolve = sub.add_parser("resolve", help="resolve a working path to its nearest project binding")
    resolve.add_argument("--path", type=Path, default=Path.cwd())

    search = sub.add_parser("search", help="full-text and tag-aware search indexed memory")
    search.add_argument("query")
    search.add_argument("--project")
    search.add_argument("--path", type=Path)
    search.add_argument("--tag", action="append", default=[])
    search.add_argument("--limit", type=int, default=10)
    search.add_argument("--no-shared", action="store_true")

    ls = sub.add_parser("list", help="list indexed memory documents")
    ls.add_argument("--project")
    ls.add_argument("--path", type=Path)
    ls.add_argument("--tag", action="append", default=[])
    ls.add_argument("--limit", type=int, default=100)
    ls.add_argument("--no-shared", action="store_true")

    links = sub.add_parser("links", help="show outbound references and inbound backlinks")
    links.add_argument("document", help="document id, absolute path, or unique indexed path suffix")

    capture = sub.add_parser("capture", help="write a structured self-improvement memory and index it")
    capture.add_argument("kind", choices=sorted(KINDS))
    capture.add_argument("summary")
    capture.add_argument("--path", type=Path, default=Path.cwd(), help="actual project/worktree path used for scope resolution")
    capture.add_argument("--details", default="")
    capture.add_argument("--action", default="", help="suggested follow-up action")
    capture.add_argument("--tag", action="append", default=[])
    capture.add_argument("--related", action="append", default=[], help="related local file path; repeatable")
    capture.add_argument("--root", help="configured memory root override")

    sub.add_parser("projects", help="list configured projects, roots, and indexed document counts")

    tags = sub.add_parser("tags", help="list canonical indexed tags and usage counts")
    tags.add_argument("--project")
    tags.add_argument("--path", type=Path)
    tags.add_argument("--no-shared", action="store_true")

    check = sub.add_parser("doctor", help="diagnose settings, routing, filesystem, index, links, and capture health")
    check.add_argument("--path", type=Path, help="also resolve and diagnose one actual project/worktree path")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    settings_path = args.settings.expanduser().resolve(strict=False)

    try:
        if args.command == "init":
            init_settings(settings_path, args.force)
            result = {"settings": str(settings_path)}
            print(json.dumps(result, indent=2) if args.json else f"created {settings_path}")
            return 0

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
                    "memory": [
                        {"path": str(location.path), "tags": list(location.tags)}
                        for location in binding.memory_roots
                    ],
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
                if args.command == "search":
                    result = search_documents(conn, args.query, project, args.tag, args.limit, include_shared)
                else:
                    result = list_documents(conn, project, args.tag, args.limit, include_shared)
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
            elif args.command == "doctor":
                result = doctor(conn, settings, settings_path, db_path, args.path)
            else:
                parser.error("unknown command")
                return 2

            if args.json:
                print(json.dumps(result, indent=2, ensure_ascii=False))
            elif args.command in {"search", "list"}:
                _human_documents(result)
            elif args.command == "links":
                print(f"{result['document']['title']}\n  {result['document']['path']}")
                print("outbound:")
                for link in result["outbound"]:
                    marker = "ok" if link["resolved"] else "dangling"
                    print(f"  - [{marker}] {link['label']} -> {link['path']}")
                print("inbound:")
                for link in result["inbound"]:
                    print(f"  - {link['title']} <- {link['path']}")
            elif args.command == "projects":
                _human_projects(result)
            elif args.command == "tags":
                _human_tags(result)
            elif args.command == "doctor":
                _human_doctor(result)
            else:
                print(json.dumps(result, indent=2, ensure_ascii=False))

            if args.command == "doctor":
                return 2 if result["status"] == "error" else 1 if result["status"] == "warn" else 0
            return 0
        finally:
            conn.close()
    except (MemoryError, OSError, sqlite3.Error) as exc:
        print(f"agent-memory: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
