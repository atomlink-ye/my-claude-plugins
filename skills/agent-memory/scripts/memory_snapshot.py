"""Read-only, point-in-time archives for a file-first Agent Memory registry."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import PurePosixPath
from pathlib import Path
from typing import Any

from memory_config import MemoryError, MemoryRoot


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


def restore_snapshot(archive_path: Path, *, force: bool = False) -> dict[str, object]:
    """Restore a snapshot to the original paths recorded in its manifest.

    This is intentionally explicit and refuses to overwrite existing files unless the
    caller supplies ``force``. It restores the consistent database backup, not its
    diagnostic sidecar copies, and reapplies nanosecond source mtimes for doctor/index
    consistency.
    """
    archive_path = archive_path.expanduser().resolve(strict=False)
    try:
        archive = tarfile.open(archive_path, "r:gz")
    except (OSError, tarfile.TarError) as exc:
        raise MemoryError(f"cannot open snapshot archive: {archive_path}: {exc}") from exc
    with archive:
        try:
            manifest_stream = archive.extractfile("manifest.json")
            if manifest_stream is None:
                raise MemoryError("snapshot archive has no manifest.json")
            manifest = json.load(manifest_stream)
        except (json.JSONDecodeError, tarfile.TarError) as exc:
            raise MemoryError(f"invalid snapshot manifest: {exc}") from exc
        if manifest.get("format") != 1:
            raise MemoryError(f"unsupported snapshot format: {manifest.get('format')!r}")

        settings_path = Path(manifest["settings_path"])
        database_path = Path(manifest["database_path"])
        database_meta = manifest.get("database", {})
        database_member = database_meta.get("archive_path") if isinstance(database_meta, dict) and database_meta.get("included") else None
        files = manifest.get("files", [])
        if not isinstance(files, list):
            raise MemoryError("snapshot manifest files must be an array")

        targets = [settings_path]
        if database_member:
            targets.append(database_path)
            targets.extend(Path(f"{database_path}{suffix}") for suffix in ("-wal", "-shm"))
        for item in files:
            if not isinstance(item, dict) or not isinstance(item.get("source_path"), str) or not isinstance(item.get("archive_path"), str):
                raise MemoryError("snapshot manifest contains an invalid file entry")
            _safe_archive_name(item["archive_path"])
            targets.append(Path(item["source_path"]))
        existing = [path for path in targets if path.exists()]
        if existing and not force:
            raise MemoryError("restore would overwrite existing files; pass --force: " + ", ".join(str(path) for path in existing[:5]))

        member_names = ["settings.json"] + ([database_member] if database_member else []) + [item["archive_path"] for item in files]
        try:
            for member_name in member_names:
                member = archive.getmember(_safe_archive_name(member_name))
                if not member.isfile():
                    raise MemoryError(f"snapshot member is not a regular file: {member_name}")
        except KeyError as exc:
            raise MemoryError(f"snapshot archive is missing required member: {exc}") from exc

        def write_member(member_name: str, destination: Path) -> None:
            member = archive.getmember(_safe_archive_name(member_name))
            if not member.isfile():
                raise MemoryError(f"snapshot member is not a regular file: {member_name}")
            source = archive.extractfile(member)
            if source is None:
                raise MemoryError(f"cannot read snapshot member: {member_name}")
            destination.parent.mkdir(parents=True, exist_ok=True)
            with source, destination.open("wb") as target:
                shutil.copyfileobj(source, target)
            os.chmod(destination, member.mode)

        write_member("settings.json", settings_path)
        if database_member:
            for suffix in ("-wal", "-shm"):
                sidecar = Path(f"{database_path}{suffix}")
                if sidecar.exists():
                    sidecar.unlink()
            write_member(database_member, database_path)
        for item in files:
            destination = Path(item["source_path"])
            write_member(item["archive_path"], destination)
            if isinstance(item.get("mtime_ns"), int):
                os.utime(destination, ns=(item["mtime_ns"], item["mtime_ns"]))

    return {
        "archive": str(archive_path),
        "settings": str(settings_path),
        "database": str(database_path) if database_member else None,
        "markdown_files": len(files),
        "force": force,
    }
