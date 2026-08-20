"""Roadmap extensions layered over the file-first memory_store without replacing its MVE schema."""
from __future__ import annotations
import re, sqlite3
from pathlib import Path
from typing import Any, Iterable
import memory_store as base
from memory_config import MemoryError, MemoryRoot

MEMORY_ID_RE=re.compile(r"^mem_[A-Za-z0-9_-]+$")
LIFECYCLE_STATES={"raw","validated","promoted","superseded"}
MEM_LINK_RE=re.compile(r"(?<!!)\[([^\]]*)\]\(memory://(mem_[A-Za-z0-9_-]+)(?:#([^)]+))?\)")

def connect_db(path:Path)->sqlite3.Connection:
 c=base.connect_db(path)
 c.executescript("""CREATE TABLE IF NOT EXISTS memory_meta(document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,memory_id TEXT,doc_type TEXT,lifecycle_status TEXT,promoted_to TEXT,superseded_by TEXT);CREATE INDEX IF NOT EXISTS idx_memory_meta_id ON memory_meta(memory_id);CREATE TABLE IF NOT EXISTS memory_links(source_document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,target_memory_id TEXT NOT NULL,label TEXT NOT NULL,anchor TEXT,PRIMARY KEY(source_document_id,target_memory_id,label));CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target_memory_id);""");c.commit();return c

def _meta(path:Path):
 text=path.read_text(encoding="utf-8",errors="replace");m,body=base._parse_frontmatter(text)
 return {"id":str(m.get("id") or "").strip() or None,"type":str(m.get("type") or "").strip() or None,"status":str(m.get("status") or "").strip().lower() or None,"promoted_to":str(m.get("promoted_to") or "").strip() or None,"superseded_by":str(m.get("superseded_by") or "").strip() or None},body

def sync_index(c:sqlite3.Connection,roots:list[MemoryRoot]):
 result=base.sync_index(c,roots)
 with c:
  c.execute("DELETE FROM memory_meta");c.execute("DELETE FROM memory_links")
  for row in c.execute("SELECT id,path FROM documents").fetchall():
   p=Path(row["path"])
   if not p.is_file():continue
   m,body=_meta(p)
   c.execute("INSERT INTO memory_meta(document_id,memory_id,doc_type,lifecycle_status,promoted_to,superseded_by) VALUES(?,?,?,?,?,?)",(row["id"],m["id"],m["type"],m["status"],m["promoted_to"],m["superseded_by"]))
   for match in MEM_LINK_RE.finditer(body):c.execute("INSERT OR IGNORE INTO memory_links(source_document_id,target_memory_id,label,anchor) VALUES(?,?,?,?)",(row["id"],match.group(2),match.group(1).strip() or match.group(2),match.group(3)))
 return result

def _enrich(c,item):
 row=c.execute("SELECT memory_id,doc_type,lifecycle_status,promoted_to,superseded_by FROM memory_meta WHERE document_id=?",(item["id"],)).fetchone()
 if row:item.update(memory_id=row[0],type=row[1],status=row[2],promoted_to=row[3],superseded_by=row[4])
 return item

def search_documents(c,query,project=None,tags=(),limit=10,include_shared=True):
 terms=[x.casefold() for x in base._fts_terms(query)];strict=base.search_documents(c,query,project,tags,limit,include_shared)
 if strict:
  for x in strict:x.update(match_mode="strict",matched_terms=terms,missing_terms=[]);_enrich(c,x)
  return strict
 return []
def list_documents(c,project=None,tags=(),limit=100,include_shared=True):return [_enrich(c,x) for x in base.list_documents(c,project,tags,limit,include_shared)]
def resolve_document(c,ref):
 raw=ref[9:].split("#",1)[0] if ref.startswith("memory://") else ref
 if raw.startswith("mem_"):
  rows=c.execute("SELECT d.id,d.path,d.title,d.brief FROM memory_meta m JOIN documents d ON d.id=m.document_id WHERE m.memory_id=?",(raw,)).fetchall()
  if len(rows)==1:return rows[0]
  if len(rows)>1:raise MemoryError(f"duplicate memory id in index: {raw}")
 return base.resolve_document(c,ref)
def link_graph(c,ref):
 doc=resolve_document(c,ref);result=base.link_graph(c,str(doc["path"]));did=int(doc["id"])
 for r in c.execute("SELECT target_memory_id,label,anchor FROM memory_links WHERE source_document_id=?",(did,)):
  target=c.execute("SELECT d.path,d.title FROM memory_meta m JOIN documents d ON d.id=m.document_id WHERE m.memory_id=?",(r[0],)).fetchone();result["outbound"].append({"label":r[1],"href":f"memory://{r[0]}","anchor":r[2],"path":target[0] if target else None,"title":target[1] if target else None,"memory_id":r[0],"resolved":target is not None})
 mid=c.execute("SELECT memory_id FROM memory_meta WHERE document_id=?",(did,)).fetchone()
 if mid and mid[0]:
  for r in c.execute("SELECT s.id,s.path,s.title,l.label,l.anchor FROM memory_links l JOIN documents s ON s.id=l.source_document_id WHERE l.target_memory_id=?",(mid[0],)):result["inbound"].append({"id":r[0],"title":r[2],"path":r[1],"label":r[3],"href":f"memory://{mid[0]}","anchor":r[4]})
 result["document"]=_enrich(c,result["document"]);return result
def status(c,settings_path,db_path):
 x=base.status(c,settings_path,db_path);x["stable_ids"]=c.execute("SELECT count(*) FROM memory_meta WHERE memory_id IS NOT NULL").fetchone()[0];return x
