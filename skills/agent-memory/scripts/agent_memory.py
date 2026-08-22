#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, sqlite3, sys
from pathlib import Path
from memory_admin import preferred_capture_root, project_inventory, tag_inventory
from memory_doctor_ext import doctor
from memory_capture import KINDS, LIFECYCLE_STATES, capture_memory
from memory_config import (
    MemoryError,
    UnboundPathError,
    collect_memory_roots,
    database_path,
    default_settings_path,
    flatten_bindings,
    init_settings,
    load_settings,
    resolve_binding,
    shared_roots,
)
from memory_format import table_dump, yaml_dump
from memory_lifecycle import update_lifecycle
from memory_snapshot import inspect_snapshot, search_snapshot, snapshot_registry
from memory_store_ext import (
    connect_db,
    link_graph,
    list_documents,
    search_documents,
    status,
    sync_index,
)


def _human_links(result):
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
                print(f"  - [{marker}] {link['label']} -> {link.get('path') or '-'}")
            else:
                print(f"  - {link['title']} <- {link['path']}")


def _emit(r, cmd, fmt):
    if fmt == "json":
        print(json.dumps(r, indent=2, ensure_ascii=False))
        return
    if fmt == "table":
        print(table_dump(cmd, r))
        return
    if fmt == "yaml":
        print(yaml_dump(r))
        return
    if cmd in {"search", "list"}:
        for x in r:
            print(
                f"[{x.get('memory_id') or x['id']}] {x['title']}\n  {x.get('brief','')}\n  path: {x['path']}\n  tags: {','.join(x.get('tags',[])) or '-'}"
            )
    elif cmd == "tags":
        for x in r:
            print(f"{x['tag']}  {x['count']}")
    elif cmd == "projects":
        for x in r:
            print(
                f"{x['project']} documents={x['documents']}\n  path: {x['path']}\n  capture: {x.get('capture_root') or '-'}"
            )
    elif cmd == "links":
        _human_links(r)
    else:
        print(json.dumps(r, indent=2, ensure_ascii=False))


def _opts(p):
    g = p.add_mutually_exclusive_group()
    g.add_argument(
        "--json",
        dest="output_format",
        action="store_const",
        const="json",
        default=argparse.SUPPRESS,
    )
    g.add_argument(
        "--table",
        dest="output_format",
        action="store_const",
        const="table",
        default=argparse.SUPPRESS,
    )
    g.add_argument(
        "--text",
        dest="output_format",
        action="store_const",
        const="text",
        default=argparse.SUPPRESS,
    )


def build_parser():
    p = argparse.ArgumentParser(prog="agent-memory")
    p.add_argument("--settings", type=Path, default=default_settings_path())
    _opts(p)
    p.set_defaults(output_format="yaml")
    s = p.add_subparsers(dest="command", required=True)

    def sub(n, h):
        q = s.add_parser(n, help=h)
        _opts(q)
        return q

    q = sub("init", "create settings")
    q.add_argument("--force", action="store_true")
    sub("status", "registry status")
    sub("sync", "re-index Markdown")
    q = sub("snapshot", "archive or inspect Agent Memory snapshots")
    q.add_argument(
        "--output",
        type=Path,
        help="directory for a generated .tar.gz (default: settings sibling snapshots/)",
    )
    snapshot_actions = q.add_subparsers(dest="snapshot_action")
    snapshot_inspect = snapshot_actions.add_parser(
        "inspect", help="show the project/root inventory recorded in a snapshot"
    )
    _opts(snapshot_inspect)
    snapshot_inspect.add_argument("archive", type=Path)
    snapshot_search = snapshot_actions.add_parser(
        "search", help="search a snapshot SQLite index without restoring it"
    )
    _opts(snapshot_search)
    snapshot_search.add_argument("archive", type=Path)
    snapshot_search.add_argument("query")
    snapshot_search.add_argument("--project")
    snapshot_search.add_argument("--tag", action="append", default=[])
    snapshot_search.add_argument("--limit", type=int, default=10)
    snapshot_search.add_argument("--no-shared", action="store_true")
    q = sub("resolve", "resolve path")
    q.add_argument("--path", type=Path, default=Path.cwd())
    for n in ("search", "list"):
        q = sub(n, n + " memory")
        if n == "search":
            q.add_argument("query")
        q.add_argument("--project")
        q.add_argument("--path", type=Path)
        q.add_argument("--tag", action="append", default=[])
        q.add_argument("--limit", type=int, default=10 if n == "search" else 100)
        q.add_argument("--no-shared", action="store_true")
    q = sub("links", "show links/backlinks")
    q.add_argument("document")
    q = sub("capture", "capture durable learning")
    q.add_argument("kind", choices=sorted(KINDS))
    q.add_argument("summary")
    q.add_argument("--path", type=Path, default=Path.cwd())
    q.add_argument("--details", default="")
    q.add_argument("--action", default="")
    q.add_argument("--tag", action="append", default=[])
    q.add_argument("--related", action="append", default=[])
    q.add_argument("--root")
    q.add_argument("--status", choices=sorted(LIFECYCLE_STATES), default="raw")
    q.add_argument("--allow-duplicate", action="store_true")
    q = sub("lifecycle", "change lifecycle")
    q.add_argument("document")
    q.add_argument("status", choices=sorted(LIFECYCLE_STATES))
    q.add_argument("--target")
    sub("projects", "list projects")
    q = sub("tags", "list tags")
    q.add_argument("--project")
    q.add_argument("--path", type=Path)
    q.add_argument("--no-shared", action="store_true")
    q = sub("doctor", "health diagnostics")
    q.add_argument("--path", type=Path)
    return p


def _fail(code, msg, path=None):
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
        "checks": [
            {
                "code": code,
                "severity": "error",
                "message": msg,
                **({"paths": [str(path)]} if path else {}),
            }
        ],
    }


def _query_project(settings, project=None, path=None):
    """Resolve the optional project scope used by read-only queries."""
    if project and path:
        raise MemoryError("use either --project or --path, not both")
    if project:
        return project
    if path is None:
        return None
    try:
        return resolve_binding(settings, path).project
    except UnboundPathError:
        return None


def main(argv=None):
    p = build_parser()
    raw = sys.argv[1:] if argv is None else argv
    if len({x for x in raw if x in {"--json", "--table", "--text"}}) > 1:
        p.error("output options are mutually exclusive")
    a = p.parse_args(raw)
    sp = a.settings.expanduser().resolve(strict=False)
    if a.command == "init":
        try:
            init_settings(sp, a.force)
            r = {"settings": str(sp)}
            _emit(r, "init", a.output_format)
            return 0
        except (MemoryError, OSError) as e:
            print(f"agent-memory: {e}", file=sys.stderr)
            return 2
    if a.command == "doctor":
        try:
            settings = load_settings(sp)
            db = database_path(settings, sp)
        except (MemoryError, OSError) as e:
            r = _fail("settings_invalid", str(e), sp)
            _emit(r, "doctor", a.output_format)
            return 2
        if not db.exists():
            r = _fail(
                "database_missing",
                "SQLite index does not exist; run agent-memory sync first",
                db,
            )
            _emit(r, "doctor", a.output_format)
            return 2
        try:
            c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            c.row_factory = sqlite3.Row
            r = doctor(c, settings, sp, db, a.path)
            c.close()
            _emit(r, "doctor", a.output_format)
            return 2 if r["status"] == "error" else 1 if r["status"] == "warn" else 0
        except Exception as e:
            r = _fail("doctor_failed", str(e), db)
            _emit(r, "doctor", a.output_format)
            return 2
    if a.command == "snapshot":
        try:
            if a.snapshot_action == "inspect":
                r = inspect_snapshot(a.archive)
            elif a.snapshot_action == "search":
                r = search_snapshot(
                    a.archive,
                    a.query,
                    project=a.project,
                    tags=tuple(a.tag),
                    limit=a.limit,
                    include_shared=not a.no_shared,
                )
            else:
                settings = load_settings(sp)
                db = database_path(settings, sp)
                r = snapshot_registry(
                    settings,
                    sp,
                    db,
                    collect_memory_roots(settings, sp),
                    a.output,
                )
            _emit(r, "snapshot", a.output_format)
            return 0
        except (MemoryError, OSError, sqlite3.Error) as e:
            print(f"agent-memory: {e}", file=sys.stderr)
            return 2
    try:
        settings = load_settings(sp)
        db = database_path(settings, sp)
        if a.command in {"search", "list", "tags"}:
            # Validate all routing config before a query opens/initializes SQLite.
            flatten_bindings(settings)
            shared_roots(settings, sp)
        c = connect_db(db)
        if a.command == "status":
            r = status(c, sp, db)
        elif a.command == "sync":
            r = sync_index(c, collect_memory_roots(settings, sp))
        elif a.command == "resolve":
            b = resolve_binding(settings, a.path)
            pref = preferred_capture_root(settings, b)
            r = {
                "path": str(a.path.resolve(strict=False)),
                "project": b.project,
                "binding": str(b.path),
                "memory": [
                    {"path": str(x.path), "tags": list(x.tags)} for x in b.memory_roots
                ],
                "capture_root": (
                    str(pref)
                    if pref
                    else (
                        str(b.memory_roots[0].path)
                        if len(b.memory_roots) == 1
                        else None
                    )
                ),
                "shared": [str(x.path) for x in shared_roots(settings, sp)],
                "tags": list(b.tags),
            }
        elif a.command in {"search", "list"}:
            project = _query_project(settings, a.project, a.path)
            r = (
                search_documents(c, a.query, project, a.tag, a.limit, not a.no_shared)
                if a.command == "search"
                else list_documents(c, project, a.tag, a.limit, not a.no_shared)
            )
        elif a.command == "links":
            r = link_graph(c, a.document)
        elif a.command == "capture":
            b = resolve_binding(settings, a.path)
            pref = preferred_capture_root(settings, b)
            r = capture_memory(
                b,
                a.kind,
                a.summary,
                details=a.details,
                suggested_action=a.action,
                tags=a.tag,
                related=a.related,
                root=a.root or (str(pref) if pref else None),
                status=a.status,
                allow_duplicate=a.allow_duplicate,
            )
            r.update(
                {"sync": sync_index(c, collect_memory_roots(settings, sp))}
                if r.get("created")
                else {}
            )
        elif a.command == "lifecycle":
            r = update_lifecycle(c, a.document, a.status, target=a.target)
            r["sync"] = sync_index(c, collect_memory_roots(settings, sp))
        elif a.command == "projects":
            r = project_inventory(c, settings)
        elif a.command == "tags":
            project = _query_project(settings, a.project, a.path)
            r = tag_inventory(c, project, not a.no_shared)
        _emit(r, a.command, a.output_format)
        c.close()
        return 0
    except (MemoryError, OSError, sqlite3.Error) as e:
        print(f"agent-memory: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
