"""Read-only, point-in-time archives for a file-first Agent Memory registry."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import PurePosixPath
from pathlib import Path
from typing import Any

from memory_config import MemoryError, MemoryRoot
from memory_store import search_documents


def default_snapshot_directory(settings_path: Path) -> Path:
    return settings_path.parent / "snapshots"


def _archive_name(output_dir: Path, now: datetime) -> Path:
    stem = f"agent-memory-{now:%Y%m%dT%H%M%SZ}"
    candidate = output_dir / f"{stem}.tar.gz"
    suffix = 2
    while candidate.exists():
        candidate = output_dir / f"{stem}-{suffix}.tar.gz"
        suffix += 1
    return candidate


def _root_id(path: Path, index: int) -> str:
    digest = hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:12]
    return f"roots/{index:03d}-{digest}"


def _add_file(archive: tarfile.TarFile, path: Path, arcname: str) -> None:
    info = archive.gettarinfo(str(path), arcname=arcname)
    with path.open("rb") as source:
        archive.addfile(info, source)


def _sqlite_backup(source_path: Path, destination: Path) -> None:
    source = sqlite3.connect(f"file:{source_path}?mode=ro", uri=True)
    destination_conn = sqlite3.connect(destination)
    try:
        source.backup(destination_conn)
    finally:
        destination_conn.close()
        source.close()


def snapshot_registry(
    settings: dict[str, Any],
    settings_path: Path,
    database: Path,
    roots: list[MemoryRoot],
    output_dir: Path | None = None,
) -> dict[str, object]:
    """Archive configured Markdown sources, settings, and a consistent SQLite copy.

    Sources are never modified. Missing/unreadable roots and unavailable index files are
    reported in the manifest/result while the rest of the archive remains usable.
    """
    now = datetime.now(timezone.utc)
    output_dir = (output_dir or default_snapshot_directory(settings_path)).expanduser().resolve(strict=False)
    output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = _archive_name(output_dir, now)

    root_map: dict[Path, str] = {}
    for root in roots:
        if root.path not in root_map:
            root_map[root.path] = _root_id(root.path, len(root_map) + 1)

    root_entries: list[dict[str, object]] = []
    for root in roots:
        root_entries.append(
            {
                "path": str(root.path),
                "archive_path": root_map[root.path],
                "scope": root.scope,
                "shared": root.shared,
                "tags": list(root.tags),
            }
        )

    missing_roots: list[str] = []
    unreadable_roots: list[str] = []
    skipped_files: list[str] = []
    files: list[dict[str, object]] = []
    markdown_files = 0
    index_included = False
    index_sidecars: list[str] = []

    with tempfile.TemporaryDirectory(dir=output_dir, prefix=".agent-memory-snapshot-") as temp_dir:
        temp = Path(temp_dir)
        backup_path = temp / "index.sqlite3"
        if database.exists() and database.is_file():
            try:
                _sqlite_backup(database, backup_path)
                index_included = True
            except (OSError, sqlite3.Error):
                skipped_files.append(str(database))
        elif database.exists():
            skipped_files.append(str(database))

        manifest: dict[str, object] = {
            "format": 1,
            "created_at": now.isoformat(),
            "settings_path": str(settings_path),
            "database_path": str(database),
            "roots": root_entries,
            "missing_roots": missing_roots,
            "unreadable_roots": unreadable_roots,
            "skipped_files": skipped_files,
            "files": files,
            "database": {"archive_path": "database/index.sqlite3", "included": index_included, "sidecars": index_sidecars},
        }

        with tarfile.open(archive_path, "w:gz") as archive:
            _add_file(archive, settings_path, "settings.json")
            if index_included:
                _add_file(archive, backup_path, "database/index.sqlite3")
            for suffix in ("-wal", "-shm"):
                sidecar = Path(f"{database}{suffix}")
                if sidecar.exists() and sidecar.is_file():
                    try:
                        archive_name = f"database/sidecars/index.sqlite3{suffix}"
                        _add_file(archive, sidecar, archive_name)
                        index_sidecars.append(archive_name)
                    except OSError:
                        skipped_files.append(str(sidecar))

            for root_path, root_id in root_map.items():
                if not root_path.exists():
                    missing_roots.append(str(root_path))
                    continue
                if not root_path.is_dir() or not os.access(root_path, os.R_OK):
                    unreadable_roots.append(str(root_path))
                    continue
                try:
                    markdown_paths = sorted((path for path in root_path.rglob("*.md") if path.is_file()), key=str)
                except OSError:
                    unreadable_roots.append(str(root_path))
                    continue
                for path in markdown_paths:
                    try:
                        relative = path.relative_to(root_path).as_posix()
                        archive_name = f"{root_id}/{relative}"
                        _add_file(archive, path, archive_name)
                        stat = path.stat()
                        files.append({"archive_path": archive_name, "source_path": str(path), "mtime_ns": stat.st_mtime_ns, "size": stat.st_size})
                        markdown_files += 1
                    except OSError:
                        skipped_files.append(str(path))

            manifest["markdown_files"] = markdown_files
            manifest_bytes = json.dumps(manifest, indent=2, ensure_ascii=False).encode("utf-8")
            manifest_info = tarfile.TarInfo("manifest.json")
            manifest_info.size = len(manifest_bytes)
            archive.addfile(manifest_info, _bytes_reader(manifest_bytes))

    return {
        "path": str(archive_path),
        "created_at": now.isoformat(),
        "settings": str(settings_path),
        "database": {"path": str(database), "included": index_included, "sidecars": index_sidecars},
        "roots": root_entries,
        "markdown_files": markdown_files,
        "missing_roots": missing_roots,
        "unreadable_roots": unreadable_roots,
        "skipped_files": skipped_files,
    }


def _bytes_reader(content: bytes):
    import io

    return io.BytesIO(content)


def _safe_archive_name(name: str) -> str:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        raise MemoryError(f"unsafe archive member path: {name}")
    return str(path)


def _open_snapshot(archive_path: Path) -> tuple[Path, tarfile.TarFile, dict[str, Any]]:
    archive_path = archive_path.expanduser().resolve(strict=False)
    try:
        archive = tarfile.open(archive_path, "r:gz")
    except (OSError, tarfile.TarError) as exc:
        raise MemoryError(f"cannot open snapshot archive: {archive_path}: {exc}") from exc
    try:
        manifest_stream = archive.extractfile("manifest.json")
        if manifest_stream is None:
            raise MemoryError("snapshot archive has no manifest.json")
        manifest = json.load(manifest_stream)
    except (json.JSONDecodeError, tarfile.TarError) as exc:
        archive.close()
        raise MemoryError(f"invalid snapshot manifest: {exc}") from exc
    if not isinstance(manifest, dict) or manifest.get("format") != 1:
        archive.close()
        raise MemoryError(f"unsupported snapshot format: {manifest.get('format') if isinstance(manifest, dict) else None!r}")
    return archive_path, archive, manifest


def inspect_snapshot(archive_path: Path) -> dict[str, object]:
    """Return the root/project inventory recorded in a snapshot manifest."""
    path, archive, manifest = _open_snapshot(archive_path)
    try:
        roots = manifest.get("roots", [])
        if not isinstance(roots, list):
            raise MemoryError("snapshot manifest roots must be an array")
        projects: dict[str, list[str]] = {}
        for root in roots:
            if not isinstance(root, dict) or not isinstance(root.get("scope"), str) or not isinstance(root.get("path"), str):
                raise MemoryError("snapshot manifest contains an invalid root entry")
            projects.setdefault(root["scope"], []).append(root["path"])
        return {
            "archive": str(path),
            "created_at": manifest.get("created_at"),
            "markdown_files": manifest.get("markdown_files", 0),
            "database_included": bool(isinstance(manifest.get("database"), dict) and manifest["database"].get("included")),
            "projects": [{"project": project, "memory_roots": paths} for project, paths in sorted(projects.items())],
            "roots": roots,
            "missing_roots": manifest.get("missing_roots", []),
            "unreadable_roots": manifest.get("unreadable_roots", []),
            "skipped_files": manifest.get("skipped_files", []),
        }
    finally:
        archive.close()


def search_snapshot(
    archive_path: Path,
    query: str,
    *,
    project: str | None = None,
    tags: tuple[str, ...] = (),
    limit: int = 10,
    include_shared: bool = True,
) -> dict[str, object]:
    """Search the snapshot's SQLite index without touching the live registry."""
    path, archive, manifest = _open_snapshot(archive_path)
    try:
        database = manifest.get("database", {})
        member_name = database.get("archive_path") if isinstance(database, dict) and database.get("included") else None
        if not isinstance(member_name, str):
            raise MemoryError("snapshot has no SQLite index; inspect it or rebuild after manual recovery")
        try:
            member = archive.getmember(_safe_archive_name(member_name))
        except KeyError as exc:
            raise MemoryError(f"snapshot archive is missing SQLite index: {member_name}") from exc
        if not member.isfile():
            raise MemoryError(f"snapshot SQLite member is not a regular file: {member_name}")
        source = archive.extractfile(member)
        if source is None:
            raise MemoryError(f"cannot read snapshot SQLite index: {member_name}")
        with tempfile.TemporaryDirectory(prefix="agent-memory-snapshot-search-") as temp_dir:
            database_path = Path(temp_dir) / "index.sqlite3"
            with source, database_path.open("wb") as target:
                target.write(source.read())
            # ``immutable=1`` keeps SQLite from probing or creating journal side files
            # beside the disposable extracted copy; the archive stores a coherent backup.
            conn = sqlite3.connect(f"file:{database_path}?mode=ro&immutable=1", uri=True)
            conn.row_factory = sqlite3.Row
            try:
                documents = search_documents(conn, query, project, tags, limit, include_shared)
            finally:
                conn.close()
        return {"archive": str(path), "query": query, "documents": documents}
    finally:
        archive.close()
