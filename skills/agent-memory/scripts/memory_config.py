"""Settings and project-scope resolution for Agent Memory."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

SHARED_SCOPE = "_shared"
SCHEMA_VERSION = 1


class MemoryError(RuntimeError):
    pass


@dataclass(frozen=True)
class MemoryLocation:
    path: Path
    tags: tuple[str, ...] = ()


@dataclass(frozen=True)
class MemoryRoot:
    path: Path
    scope: str
    tags: tuple[str, ...]
    shared: bool = False


@dataclass(frozen=True)
class Binding:
    path: Path
    project: str
    memory_roots: tuple[MemoryLocation, ...]
    tags: tuple[str, ...]
    depth: int


def _dedupe(items: Iterable[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(item for item in items if item))


def _expand_path(value: str, base: Path | None = None) -> Path:
    expanded = os.path.expandvars(os.path.expanduser(value))
    path = Path(expanded)
    if not path.is_absolute():
        path = (base or Path.cwd()) / path
    return path.resolve(strict=False)


def default_settings_path() -> Path:
    explicit = os.environ.get("AGENT_MEMORY_SETTINGS")
    if explicit:
        return _expand_path(explicit)
    home = os.environ.get("AGENT_MEMORY_HOME")
    base = _expand_path(home) if home else Path.home() / ".agent-memory"
    return (base / "settings.json").resolve(strict=False)


def default_settings() -> dict[str, Any]:
    return {
        "version": 1,
        "database": "~/.agent-memory/index.sqlite3",
        "shared": [],
        "bindings": [],
    }


def init_settings(path: Path, force: bool = False) -> None:
    if path.exists() and not force:
        raise MemoryError(f"settings already exist: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(default_settings(), indent=2) + "\n", encoding="utf-8")


def load_settings(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise MemoryError(f"settings not found: {path}; run `agent-memory init` first") from exc
    except json.JSONDecodeError as exc:
        raise MemoryError(f"invalid JSON in {path}: {exc}") from exc
    if data.get("version") != SCHEMA_VERSION:
        raise MemoryError(f"unsupported settings version: {data.get('version')!r}")
    if not isinstance(data.get("bindings", []), list) or not isinstance(data.get("shared", []), list):
        raise MemoryError("settings `bindings` and `shared` must be arrays")
    return data


def database_path(settings: dict[str, Any], settings_path: Path) -> Path:
    value = settings.get("database", "~/.agent-memory/index.sqlite3")
    if not isinstance(value, str):
        raise MemoryError("settings `database` must be a path string")
    return _expand_path(value, settings_path.parent)


def _normalize_tag(value: Any) -> str:
    tag = str(value).strip()
    if not tag:
        raise MemoryError("tag must not be empty")
    parts = [part.strip() for part in tag.split(":")]
    if any(not part for part in parts):
        raise MemoryError(f"tag hierarchy contains an empty segment: {tag!r}")
    return ":".join(parts)


def _normalize_tags(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        value = [part.strip() for part in value.split(",")]
    if not isinstance(value, list):
        raise MemoryError("tags must be a string or array")
    return _dedupe(_normalize_tag(item) for item in value if str(item).strip())


def _merge_locations(items: Iterable[MemoryLocation]) -> tuple[MemoryLocation, ...]:
    merged: dict[Path, list[str]] = {}
    for item in items:
        merged.setdefault(item.path, []).extend(item.tags)
    return tuple(MemoryLocation(path, _dedupe(tags)) for path, tags in merged.items())


def _memory_locations(value: Any, binding_path: Path) -> tuple[MemoryLocation, ...]:
    if value is None:
        return ()
    if isinstance(value, (str, dict)):
        value = [value]
    if not isinstance(value, list):
        raise MemoryError("binding `memory` must be a path/object or array")
    locations: list[MemoryLocation] = []
    for item in value:
        if isinstance(item, str):
            locations.append(MemoryLocation(_expand_path(item, binding_path)))
        elif isinstance(item, dict) and isinstance(item.get("path"), str):
            locations.append(
                MemoryLocation(
                    _expand_path(item["path"], binding_path),
                    _normalize_tags(item.get("tags")),
                )
            )
        else:
            raise MemoryError("each binding `memory` entry must be a path string or {path,tags} object")
    return _merge_locations(locations)


def flatten_bindings(settings: dict[str, Any]) -> list[Binding]:
    flattened: list[Binding] = []

    def visit(node: dict[str, Any], parent: Path | None, inherited_memory: tuple[MemoryLocation, ...], inherited_tags: tuple[str, ...]) -> None:
        raw_path = node.get("path")
        project = node.get("project")
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise MemoryError("every binding needs a non-empty `path`")
        if not isinstance(project, str) or not project.strip():
            raise MemoryError(f"binding {raw_path!r} needs a non-empty `project`")

        expanded_raw = Path(os.path.expandvars(os.path.expanduser(raw_path)))
        if parent is None and not expanded_raw.is_absolute():
            raise MemoryError(f"top-level binding path must be absolute (or use ~): {raw_path}")
        binding_path = _expand_path(raw_path, parent)
        own_memory = _memory_locations(node.get("memory"), binding_path)
        inherit_memory = bool(node.get("inherit_memory", False))
        memory_locations = _merge_locations((inherited_memory if inherit_memory else ()) + own_memory)

        tags = _dedupe((*inherited_tags, *_normalize_tags(node.get("tags"))))
        flattened.append(
            Binding(
                path=binding_path,
                project=project.strip(),
                memory_roots=memory_locations,
                tags=tags,
                depth=len(binding_path.parts),
            )
        )

        children = node.get("projects", [])
        if not isinstance(children, list):
            raise MemoryError(f"binding {raw_path!r} `projects` must be an array")
        for child in children:
            if not isinstance(child, dict):
                raise MemoryError(f"binding {raw_path!r} contains a non-object child")
            visit(child, binding_path, memory_locations, tags)

    for root in settings.get("bindings", []):
        if not isinstance(root, dict):
            raise MemoryError("each binding must be an object")
        visit(root, None, (), ())
    return flattened


def shared_roots(settings: dict[str, Any], settings_path: Path) -> list[MemoryRoot]:
    roots: list[MemoryRoot] = []
    for item in settings.get("shared", []):
        if isinstance(item, str):
            item = {"path": item}
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise MemoryError("each shared entry needs a `path`")
        roots.append(
            MemoryRoot(
                path=_expand_path(item["path"], settings_path.parent),
                scope=SHARED_SCOPE,
                tags=_normalize_tags(item.get("tags")),
                shared=True,
            )
        )
    return roots


def collect_memory_roots(settings: dict[str, Any], settings_path: Path) -> list[MemoryRoot]:
    roots = shared_roots(settings, settings_path)
    for binding in flatten_bindings(settings):
        roots.extend(
            MemoryRoot(
                path=location.path,
                scope=binding.project,
                tags=_dedupe((*binding.tags, *location.tags)),
            )
            for location in binding.memory_roots
        )
    # Keep repeated physical roots because one root may intentionally be visible in multiple scopes.
    return roots


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def resolve_binding(settings: dict[str, Any], target: Path) -> Binding:
    target = target.resolve(strict=False)
    matches = [binding for binding in flatten_bindings(settings) if _is_within(target, binding.path)]
    if not matches:
        raise MemoryError(f"no project binding matches path: {target}")
    max_depth = max(binding.depth for binding in matches)
    winners = [binding for binding in matches if binding.depth == max_depth]
    if len(winners) != 1:
        projects = ", ".join(sorted(binding.project for binding in winners))
        raise MemoryError(f"ambiguous project binding for {target}: {projects}")
    return winners[0]
