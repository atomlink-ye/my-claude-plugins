"""SQLite index, Markdown metadata, and link graph for Agent Memory."""

from __future__ import annotations

import hashlib
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote, urlparse

from memory_config import (
    MemoryError,
    MemoryRoot,
    SHARED_SCOPE,
    _dedupe,
    _expand_path,
    _normalize_tag,
    _normalize_tags,
)

MD_LINK_RE = re.compile(r"(?<!!)\[([^\]]*)\]\(([^)]+)\)")
WIKI_LINK_RE = re.compile(r"\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]")


def connect_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS documents (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            brief TEXT NOT NULL,
            mtime_ns INTEGER NOT NULL,
            size INTEGER NOT NULL,
            sha256 TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS document_scopes (
            document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            scope TEXT NOT NULL,
            PRIMARY KEY (document_id, scope)
        );
        CREATE TABLE IF NOT EXISTS document_tags (
            document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            tag TEXT NOT NULL,
            PRIMARY KEY (document_id, tag)
        );
        CREATE TABLE IF NOT EXISTS links (
            id INTEGER PRIMARY KEY,
            source_document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            target_path TEXT NOT NULL,
            target_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
            href TEXT NOT NULL,
            label TEXT NOT NULL,
            anchor TEXT,
            UNIQUE(source_document_id, href, label)
        );
        CREATE INDEX IF NOT EXISTS idx_scopes_scope ON document_scopes(scope);
        CREATE INDEX IF NOT EXISTS idx_tags_tag ON document_tags(tag);
        CREATE INDEX IF NOT EXISTS idx_links_target_path ON links(target_path);
        """)
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(title, brief, content)"
    )
    return conn


def _parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end < 0:
        return {}, text
    raw = text[4:end]
    body = text[end + 5 :]
    meta: dict[str, Any] = {}
    current_list: str | None = None
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if current_list and stripped.startswith("-"):
            meta.setdefault(current_list, []).append(stripped[1:].strip().strip("\"'"))
            continue
        current_list = None
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key, value = key.strip(), value.strip()
        if not value:
            meta[key] = []
            current_list = key
        elif value.startswith("[") and value.endswith("]"):
            inner = value[1:-1].strip()
            meta[key] = [
                part.strip().strip("\"'") for part in inner.split(",") if part.strip()
            ]
        else:
            meta[key] = value.strip("\"'")
    return meta, body


def _derive_metadata(
    path: Path, text: str, root_tags: Iterable[str]
) -> tuple[str, str, tuple[str, ...], str]:
    meta, body = _parse_frontmatter(text)
    title = str(meta.get("title") or "").strip()
    if not title:
        heading = re.search(r"^#\s+(.+?)\s*$", body, flags=re.MULTILINE)
        title = (
            heading.group(1).strip()
            if heading
            else path.stem.replace("-", " ").replace("_", " ")
        )

    brief = str(meta.get("brief") or "").strip()
    if not brief:
        paragraphs = re.split(r"\n\s*\n", body)
        for paragraph in paragraphs:
            cleaned = " ".join(
                line.strip()
                for line in paragraph.splitlines()
                if line.strip() and not line.lstrip().startswith("#")
            )
            if cleaned:
                brief = cleaned[:280]
                break
    tags = _dedupe((*root_tags, *_normalize_tags(meta.get("tags"))))
    return title, brief, tags, body


def _tag_search_text(tags: Iterable[str]) -> str:
    """Produce hidden FTS aliases while preserving canonical stored/display tags.

    ``agent-server:learnings`` contributes ``agent-server``, ``agent``, ``server``, and
    ``learnings``. This lets a normal free-text query such as ``learnings agent server``
    recall the note without requiring the user to remember hierarchy order or hyphens.
    """
    aliases: list[str] = []
    for tag in tags:
        canonical = _normalize_tag(tag)
        aliases.append(canonical)
        for segment in canonical.split(":"):
            aliases.append(segment)
            aliases.extend(part for part in re.split(r"[-_\s]+", segment) if part)
    return " ".join(_dedupe(aliases))


def _resolve_link_target(source: Path, href: str) -> tuple[Path | None, str | None]:
    href = href.strip().strip("<>")
    if not href or href.startswith("#"):
        return None, href[1:] if href.startswith("#") else None
    if " " in href and not href.startswith("file://"):
        href = href.split(maxsplit=1)[0]
    parsed = urlparse(href)
    if parsed.scheme and parsed.scheme != "file":
        return None, parsed.fragment or None
    anchor = parsed.fragment or None
    raw_path = unquote(
        parsed.path if parsed.scheme == "file" else href.split("#", 1)[0]
    )
    if not raw_path:
        return None, anchor
    target = Path(raw_path)
    if not target.is_absolute():
        target = source.parent / target
    return target.resolve(strict=False), anchor


def _extract_links(source: Path, body: str) -> list[dict[str, str | None]]:
    found: list[dict[str, str | None]] = []
    for match in MD_LINK_RE.finditer(body):
        label, href = match.group(1).strip(), match.group(2).strip()
        target, anchor = _resolve_link_target(source, href)
        if target is None:
            continue
        found.append(
            {
                "target_path": str(target),
                "href": href,
                "label": label or target.name,
                "anchor": anchor,
            }
        )
    for match in WIKI_LINK_RE.finditer(body):
        raw_target, anchor, alias = (
            match.group(1).strip(),
            match.group(2),
            match.group(3),
        )
        if not Path(raw_target).suffix:
            raw_target += ".md"
        target, _ = _resolve_link_target(source, raw_target)
        if target is None:
            continue
        href = raw_target + (f"#{anchor}" if anchor else "")
        found.append(
            {
                "target_path": str(target),
                "href": href,
                "label": (alias or Path(raw_target).stem).strip(),
                "anchor": anchor,
            }
        )
    unique: dict[tuple[str, str], dict[str, str | None]] = {}
    for item in found:
        unique[(str(item["href"]), str(item["label"]))] = item
    return list(unique.values())


def sync_index(conn: sqlite3.Connection, roots: list[MemoryRoot]) -> dict[str, int]:
    aggregated: dict[Path, dict[str, set[str]]] = {}
    missing_roots = 0
    for root in roots:
        if not root.path.exists():
            missing_roots += 1
            continue
        if not root.path.is_dir():
            raise MemoryError(f"memory root is not a directory: {root.path}")
        for path in root.path.rglob("*.md"):
            if not path.is_file():
                continue
            canonical = path.resolve(strict=False)
            entry = aggregated.setdefault(canonical, {"scopes": set(), "tags": set()})
            entry["scopes"].add(root.scope)
            entry["tags"].update(root.tags)

    seen_paths: set[str] = set()
    indexed = 0
    with conn:
        for path, visibility in aggregated.items():
            text = path.read_text(encoding="utf-8", errors="replace")
            stat = path.stat()
            digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
            title, brief, tags, body = _derive_metadata(path, text, visibility["tags"])
            seen_paths.add(str(path))

            existing = conn.execute(
                "SELECT id FROM documents WHERE path=?", (str(path),)
            ).fetchone()
            if existing:
                doc_id = int(existing["id"])
                conn.execute(
                    "UPDATE documents SET title=?, brief=?, mtime_ns=?, size=?, sha256=? WHERE id=?",
                    (title, brief, stat.st_mtime_ns, stat.st_size, digest, doc_id),
                )
                conn.execute("DELETE FROM document_fts WHERE rowid=?", (doc_id,))
            else:
                cur = conn.execute(
                    "INSERT INTO documents(path,title,brief,mtime_ns,size,sha256) VALUES(?,?,?,?,?,?)",
                    (str(path), title, brief, stat.st_mtime_ns, stat.st_size, digest),
                )
                doc_id = int(cur.lastrowid)

            indexed_content = body + "\n\n" + _tag_search_text(tags)
            conn.execute(
                "INSERT INTO document_fts(rowid,title,brief,content) VALUES(?,?,?,?)",
                (doc_id, title, brief, indexed_content),
            )
            conn.execute("DELETE FROM document_scopes WHERE document_id=?", (doc_id,))
            conn.executemany(
                "INSERT INTO document_scopes(document_id,scope) VALUES(?,?)",
                [(doc_id, scope) for scope in sorted(visibility["scopes"])],
            )
            conn.execute("DELETE FROM document_tags WHERE document_id=?", (doc_id,))
            conn.executemany(
                "INSERT INTO document_tags(document_id,tag) VALUES(?,?)",
                [(doc_id, tag) for tag in sorted(tags)],
            )
            conn.execute("DELETE FROM links WHERE source_document_id=?", (doc_id,))
            for link in _extract_links(path, body):
                conn.execute(
                    "INSERT OR IGNORE INTO links(source_document_id,target_path,href,label,anchor) VALUES(?,?,?,?,?)",
                    (
                        doc_id,
                        link["target_path"],
                        link["href"],
                        link["label"],
                        link["anchor"],
                    ),
                )
            indexed += 1

        stale = [
            row["id"]
            for row in conn.execute("SELECT id,path FROM documents")
            if row["path"] not in seen_paths
        ]
        for doc_id in stale:
            conn.execute("DELETE FROM document_fts WHERE rowid=?", (doc_id,))
            conn.execute("DELETE FROM documents WHERE id=?", (doc_id,))

        conn.execute(
            "UPDATE links SET target_document_id=(SELECT id FROM documents d WHERE d.path=links.target_path)"
        )

    return {
        "indexed": indexed,
        "removed": len(stale),
        "missing_roots": missing_roots,
        "roots": len(roots),
    }


def _fts_terms(text: str) -> list[str]:
    terms = re.findall(r"[\w-]+", text, flags=re.UNICODE)
    if not terms:
        raise MemoryError("search query has no searchable terms")
    return terms


def _fts_query(text: str, operator: str = "AND") -> str:
    terms = _fts_terms(text)
    if operator not in {"AND", "OR"}:
        raise ValueError(f"unsupported FTS operator: {operator}")
    return f" {operator} ".join('"' + term.replace('"', '""') + '"' for term in terms)


def _append_tag_filter(sql: str, params: list[Any], tag: str) -> str:
    """Match hierarchy segments without requiring the stored hierarchy order.

    ``agent-server:learnings`` can therefore be filtered by ``learnings``,
    ``agent-server:learnings``, or ``learnings:agent-server``. Stored/displayed tags stay
    canonical, and every requested segment must match a complete colon-delimited segment.
    """
    canonical = _normalize_tag(tag)
    segments = canonical.split(":")
    conditions = [
        "instr(':' || lower(t.tag) || ':', ':' || lower(?) || ':') > 0"
        for _ in segments
    ]
    sql += (
        " AND EXISTS (SELECT 1 FROM document_tags t WHERE t.document_id=d.id AND "
        + " AND ".join(conditions)
        + ")"
    )
    params.extend(segments)
    return sql


def _doc_payload(
    conn: sqlite3.Connection, row: sqlite3.Row, score: float | None = None
) -> dict[str, Any]:
    doc_id = int(row["id"])
    payload: dict[str, Any] = {
        "id": doc_id,
        "title": row["title"],
        "brief": row["brief"],
        "path": row["path"],
        "projects": [
            r[0]
            for r in conn.execute(
                "SELECT scope FROM document_scopes WHERE document_id=? ORDER BY scope",
                (doc_id,),
            )
        ],
        "tags": [
            r[0]
            for r in conn.execute(
                "SELECT tag FROM document_tags WHERE document_id=? ORDER BY tag",
                (doc_id,),
            )
        ],
    }
    if score is not None:
        payload["score"] = score
    return payload


def search_documents(
    conn: sqlite3.Connection,
    query: str,
    project: str | None = None,
    tags: Iterable[str] = (),
    limit: int = 10,
    include_shared: bool = True,
) -> list[dict[str, Any]]:
    tags = tuple(tags)

    def execute(match_query: str, result_limit: int) -> list[sqlite3.Row]:
        sql = """
            SELECT d.id,d.path,d.title,d.brief,document_fts.content AS indexed_content,
                   bm25(document_fts) AS score
            FROM document_fts JOIN documents d ON d.id=document_fts.rowid
            WHERE document_fts MATCH ?
        """
        params: list[Any] = [match_query]
        if project:
            scopes = [project] + ([SHARED_SCOPE] if include_shared else [])
            placeholders = ",".join("?" for _ in scopes)
            sql += f" AND EXISTS (SELECT 1 FROM document_scopes s WHERE s.document_id=d.id AND s.scope IN ({placeholders}))"
            params.extend(scopes)
        for tag in tags:
            sql = _append_tag_filter(sql, params, tag)
        sql += " ORDER BY score LIMIT ?"
        params.append(result_limit)
        return list(conn.execute(sql, params))

    strict_hits = execute(_fts_query(query), limit)
    if strict_hits:
        return [_doc_payload(conn, row, float(row["score"])) for row in strict_hits]

    # Natural-language recall often contains an extra symptom or synonym that is
    # absent from a concise memory. Preserve precise AND results when they exist,
    # but make a no-result query useful by recalling documents that match any term.
    # A concise memory matching several symptoms should rank above a large general
    # workflow that happens to repeat one common word, then BM25 breaks ties.
    terms = [term.casefold() for term in _fts_terms(query)]
    fallback_hits = execute(_fts_query(query, "OR"), max(limit * 20, 100))
    fallback_hits.sort(
        key=lambda row: (
            -sum(term in row["indexed_content"].casefold() for term in terms),
            float(row["score"]),
        )
    )
    return [
        _doc_payload(conn, row, float(row["score"])) for row in fallback_hits[:limit]
    ]


def list_documents(
    conn: sqlite3.Connection,
    project: str | None = None,
    tags: Iterable[str] = (),
    limit: int = 100,
    include_shared: bool = True,
) -> list[dict[str, Any]]:
    sql = "SELECT d.id,d.path,d.title,d.brief FROM documents d WHERE 1=1"
    params: list[Any] = []
    if project:
        scopes = [project] + ([SHARED_SCOPE] if include_shared else [])
        placeholders = ",".join("?" for _ in scopes)
        sql += f" AND EXISTS (SELECT 1 FROM document_scopes s WHERE s.document_id=d.id AND s.scope IN ({placeholders}))"
        params.extend(scopes)
    for tag in tags:
        sql = _append_tag_filter(sql, params, tag)
    sql += " ORDER BY d.mtime_ns DESC,d.path LIMIT ?"
    params.append(limit)
    return [_doc_payload(conn, row) for row in conn.execute(sql, params)]


def resolve_document(conn: sqlite3.Connection, ref: str) -> sqlite3.Row:
    if ref.isdigit():
        row = conn.execute(
            "SELECT id,path,title,brief FROM documents WHERE id=?", (int(ref),)
        ).fetchone()
        if row:
            return row
    candidate = _expand_path(ref)
    row = conn.execute(
        "SELECT id,path,title,brief FROM documents WHERE path=?", (str(candidate),)
    ).fetchone()
    if row:
        return row
    suffix = ref.replace("\\", "/").lstrip("./")
    matches = conn.execute(
        "SELECT id,path,title,brief FROM documents WHERE replace(path,'\\','/') LIKE ?",
        (f"%/{suffix}",),
    ).fetchall()
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise MemoryError(f"document reference is ambiguous: {ref}")
    raise MemoryError(f"document not found in index: {ref}")


def link_graph(conn: sqlite3.Connection, ref: str) -> dict[str, Any]:
    doc = resolve_document(conn, ref)
    doc_id = int(doc["id"])
    outbound = []
    for row in conn.execute(
        """SELECT l.href,l.label,l.anchor,l.target_path,l.target_document_id,d.title AS target_title
           FROM links l LEFT JOIN documents d ON d.id=l.target_document_id
           WHERE l.source_document_id=? ORDER BY l.id""",
        (doc_id,),
    ):
        outbound.append(
            {
                "label": row["label"],
                "href": row["href"],
                "anchor": row["anchor"],
                "path": row["target_path"],
                "title": row["target_title"],
                "resolved": row["target_document_id"] is not None,
            }
        )
    inbound = []
    for row in conn.execute(
        """SELECT l.href,l.label,l.anchor,s.id AS source_id,s.path AS source_path,s.title AS source_title
           FROM links l JOIN documents s ON s.id=l.source_document_id
           WHERE l.target_document_id=? ORDER BY s.path,l.id""",
        (doc_id,),
    ):
        inbound.append(
            {
                "id": row["source_id"],
                "title": row["source_title"],
                "path": row["source_path"],
                "label": row["label"],
                "href": row["href"],
                "anchor": row["anchor"],
            }
        )
    return {
        "document": _doc_payload(conn, doc),
        "outbound": outbound,
        "inbound": inbound,
    }


def status(
    conn: sqlite3.Connection, settings_path: Path, db_path: Path
) -> dict[str, Any]:
    return {
        "settings": str(settings_path),
        "database": str(db_path),
        "documents": conn.execute("SELECT count(*) FROM documents").fetchone()[0],
        "links": conn.execute("SELECT count(*) FROM links").fetchone()[0],
        "resolved_links": conn.execute(
            "SELECT count(*) FROM links WHERE target_document_id IS NOT NULL"
        ).fetchone()[0],
    }
