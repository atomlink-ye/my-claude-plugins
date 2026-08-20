"""Structured Markdown capture for self-improvement knowledge."""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from memory_config import Binding, MemoryError, _dedupe, _expand_path, _normalize_tags

KINDS = {
    "learning": "learnings",
    "drawback": "drawbacks",
    "error": "errors",
    "feature-request": "feature-requests",
}


def _slug(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:64] or "memory"


def _pick_root(binding: Binding, root: str | None = None) -> Path:
    roots = [location.path.resolve(strict=False) for location in binding.memory_roots]
    if not roots:
        raise MemoryError(f"project {binding.project!r} has no configured memory root")
    if root:
        candidate = _expand_path(root, binding.path)
        matches = [configured for configured in roots if configured == candidate]
        if len(matches) != 1:
            available = ", ".join(str(path) for path in roots)
            raise MemoryError(f"capture root is not configured for project {binding.project!r}: {candidate}; available: {available}")
        return matches[0]
    if len(roots) != 1:
        available = ", ".join(str(path) for path in roots)
        raise MemoryError(f"project {binding.project!r} has multiple memory roots; pass --root explicitly: {available}")
    return roots[0]


def _frontmatter_scalar(text: str) -> str:
    return text.replace("\n", " ").replace("\r", " ").strip().replace('"', "'")


def _related_links(note_path: Path, related: Iterable[str]) -> list[str]:
    links: list[str] = []
    for raw in related:
        target = _expand_path(raw, Path.cwd())
        href = os.path.relpath(target, note_path.parent).replace(os.sep, "/")
        links.append(f"- [{target.name}]({href})")
    return links


def capture_memory(
    binding: Binding,
    kind: str,
    summary: str,
    *,
    details: str = "",
    suggested_action: str = "",
    tags: Iterable[str] = (),
    related: Iterable[str] = (),
    root: str | None = None,
) -> dict[str, object]:
    if kind not in KINDS:
        raise MemoryError(f"unsupported capture kind {kind!r}; choose from: {', '.join(KINDS)}")
    summary = summary.strip()
    if not summary:
        raise MemoryError("capture summary must not be empty")

    memory_root = _pick_root(binding, root)
    category = KINDS[kind]
    capture_dir = memory_root / category
    capture_dir.mkdir(parents=True, exist_ok=True)

    now = datetime.now(timezone.utc)
    stem = f"{now:%Y%m%d-%H%M%S}-{_slug(summary)}"
    note_path = capture_dir / f"{stem}.md"
    suffix = 2
    while note_path.exists():
        note_path = capture_dir / f"{stem}-{suffix}.md"
        suffix += 1

    canonical_tags = _dedupe(
        _normalize_tags(
            [
                f"{binding.project}:{category}",
                f"self-improvement:{kind}",
                *tags,
            ]
        )
    )
    brief = _frontmatter_scalar(summary)[:280]
    title = _frontmatter_scalar(summary)

    lines = [
        "---",
        f'title: "{title}"',
        f'brief: "{brief}"',
        f"type: {kind}",
        "tags: [" + ", ".join(canonical_tags) + "]",
        "---",
        "",
        f"# {title}",
        "",
        f"**Kind**: {kind}",
        f"**Logged**: {now.isoformat()}",
        f"**Project**: {binding.project}",
    ]
    if details.strip():
        lines.extend(["", "## Why", "", details.strip()])
    if suggested_action.strip():
        lines.extend(["", "## How to apply", "", suggested_action.strip()])
    related_links = _related_links(note_path, related)
    if related_links:
        lines.extend(["", "## Related Files", "", *related_links])
    lines.append("")

    note_path.write_text("\n".join(lines), encoding="utf-8")
    return {
        "path": str(note_path.resolve(strict=False)),
        "project": binding.project,
        "kind": kind,
        "tags": list(canonical_tags),
    }
