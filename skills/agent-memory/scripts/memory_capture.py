"""Structured, duplicate-aware Markdown capture for durable Agent Memory knowledge."""
from __future__ import annotations
import difflib, os, re, uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from memory_config import Binding, MemoryError, _dedupe, _expand_path, _normalize_tags

KINDS={"learning":"learnings","drawback":"drawbacks","error":"errors","feature-request":"feature-requests"}
LIFECYCLE_STATES={"raw","validated","promoted","superseded"}
def new_memory_id():return "mem_"+uuid.uuid4().hex
def _slug(text):return (re.sub(r"[^a-z0-9]+","-",text.lower()).strip("-")[:64] or "memory")
def _pick_root(binding,root=None):
 roots=[x.path.resolve(strict=False) for x in binding.memory_roots]
 if not roots:raise MemoryError(f"project {binding.project!r} has no configured memory root")
 if root:
  candidate=_expand_path(root,binding.path);matches=[x for x in roots if x==candidate]
  if len(matches)!=1:raise MemoryError(f"capture root is not configured for project {binding.project!r}: {candidate}")
  return matches[0]
 if len(roots)!=1:raise MemoryError(f"project {binding.project!r} has multiple memory roots; pass --root explicitly: "+", ".join(map(str,roots)))
 return roots[0]
def _scalar(text):return text.replace("\n"," ").replace("\r"," ").strip().replace('"',"'")
def _related(note,items):
 out=[]
 for raw in items:
  target=_expand_path(raw,Path.cwd());out.append(f"- [{target.name}]({os.path.relpath(target,note.parent).replace(os.sep,'/')})")
 return out
def find_capture_duplicates(binding:Binding,summary:str,threshold:float=.72):
 """Cheap local preflight: compare proposed summary with existing titles/briefs in project roots."""
 needle=summary.strip().casefold();hits=[]
 for loc in binding.memory_roots:
  if not loc.path.is_dir():continue
  for p in loc.path.rglob("*.md"):
   try:
    text=p.read_text(encoding="utf-8",errors="replace");title="";brief=""
    if text.startswith("---\n"):
     end=text.find("\n---\n",4)
     if end>0:
      for line in text[4:end].splitlines():
       if ":" not in line:continue
       k,v=line.split(":",1);v=v.strip().strip('"\'')
       if k.strip()=="title":title=v
       elif k.strip()=="brief":brief=v
    candidate=(title or brief or p.stem).casefold();score=difflib.SequenceMatcher(None,needle,candidate).ratio()
    if score>=threshold:hits.append({"path":str(p.resolve()),"title":title or p.stem,"score":round(score,3)})
   except OSError:continue
 return sorted(hits,key=lambda x:-x["score"])[:5]
def capture_memory(binding:Binding,kind:str,summary:str,*,details="",suggested_action="",tags:Iterable[str]=(),related:Iterable[str]=(),root=None,memory_id=None,status="raw",allow_duplicate=False):
 if kind not in KINDS:raise MemoryError(f"unsupported capture kind {kind!r}; choose from: {', '.join(KINDS)}")
 summary=summary.strip()
 if not summary:raise MemoryError("capture summary must not be empty")
 status=status.strip().lower()
 if status not in LIFECYCLE_STATES:raise MemoryError(f"unsupported lifecycle status: {status}")
 duplicates=find_capture_duplicates(binding,summary)
 if duplicates and not allow_duplicate:return {"created":False,"duplicate_blocked":True,"possible_duplicates":duplicates,"project":binding.project,"kind":kind}
 memory_root=_pick_root(binding,root);category=KINDS[kind];folder=memory_root/category;folder.mkdir(parents=True,exist_ok=True);now=datetime.now(timezone.utc);stem=f"{now:%Y%m%d-%H%M%S}-{_slug(summary)}";note=folder/f"{stem}.md";n=2
 while note.exists():note=folder/f"{stem}-{n}.md";n+=1
 mid=memory_id or new_memory_id()
 if not re.fullmatch(r"mem_[A-Za-z0-9_-]+",mid):raise MemoryError(f"invalid memory id: {mid!r}")
 canonical=_dedupe(_normalize_tags([f"{binding.project}:{category}",f"self-improvement:{kind}",*tags]));title=_scalar(summary);brief=title[:280]
 lines=["---",f"id: {mid}",f'title: "{title}"',f'brief: "{brief}"',f"type: {kind}",f"status: {status}","tags: ["+", ".join(canonical)+"]","---","",f"# {title}","",f"**Kind**: {kind}",f"**Status**: {status}",f"**Logged**: {now.isoformat()}",f"**Project**: {binding.project}"]
 if details.strip():lines += ["","## Why","",details.strip()]
 if suggested_action.strip():lines += ["","## How to apply","",suggested_action.strip()]
 links=_related(note,related)
 if links:lines += ["","## Related Files","",*links]
 lines.append("");note.write_text("\n".join(lines),encoding="utf-8")
 return {"created":True,"memory_id":mid,"path":str(note.resolve()),"project":binding.project,"kind":kind,"status":status,"tags":list(canonical),"possible_duplicates":duplicates}
