"""Test bootstrap for importing vendored skill-creator scripts."""

from __future__ import annotations

import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
SKILL_CREATOR_ROOT = REPO_ROOT / "skills" / "skill-creator"


def enable_script_imports() -> None:
    """Put the vendored skill-creator root on sys.path."""
    path = str(SKILL_CREATOR_ROOT)
    if path not in sys.path:
        sys.path.insert(0, path)
