"""Explicit lifecycle transitions for Markdown memory sources."""
from __future__ import annotations
from pathlib import Path
from memory_config import MemoryError
from memory_capture import LIFECYCLE_STATES
from memory_store_ext import resolve_document

def _set_fields(path:Path,fields:dict[str,str|None]):
 text=path.read_text(encoding="utf-8")
 if not text.startswith("---\n"):raise MemoryError(f"lifecycle update requires frontmatter: {path}")
 end=text.find("\n---\n",4)
 if end<0:raise MemoryError(f"unterminated frontmatter: {path}")
 lines=text[4:end].splitlines();keys=set(fields);out=[];seen=set()
 for line in lines:
  key=line.split(":",1)[0].strip() if ":" in line else ""
  if key in keys:
   seen.add(key);value=fields[key]
   if value is not None:out.append(f"{key}: {value}")
  else:out.append(line)
 for key,value in fields.items():
  if key not in seen and value is not None:out.append(f"{key}: {value}")
 path.write_text("---\n"+"\n".join(out)+"\n---\n"+text[end+5:],encoding="utf-8")

def update_lifecycle(conn,ref:str,status:str,*,target:str|None=None):
 status=status.strip().lower()
 if status not in LIFECYCLE_STATES:raise MemoryError(f"unsupported lifecycle status: {status}")
 doc=resolve_document(conn,ref);path=Path(doc["path"]);fields={"status":status,"promoted_to":None,"superseded_by":None}
 if status=="promoted":
  if not target:raise MemoryError("promoted lifecycle requires --target memory ID/reference")
  fields["promoted_to"]=target if target.startswith("memory://") else f"memory://{target}"
 elif status=="superseded":
  if not target:raise MemoryError("superseded lifecycle requires --target memory ID/reference")
  fields["superseded_by"]=target if target.startswith("memory://") else f"memory://{target}"
 _set_fields(path,fields);return {"path":str(path),"status":status,"target":target}
