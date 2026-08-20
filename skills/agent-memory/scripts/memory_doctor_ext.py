"""Stable-ID/lifecycle health checks layered on the existing read-only Doctor."""
from __future__ import annotations
from collections import Counter,defaultdict
from memory_admin import doctor as base_doctor
from memory_store_ext import LIFECYCLE_STATES,MEMORY_ID_RE
def _target(value):return value[9:].split("#",1)[0] if value and value.startswith("memory://") else value
def doctor(conn,settings,settings_path,db_path,target_path=None):
 r=base_doctor(conn,settings,settings_path,db_path,target_path);checks=r["checks"]
 try:rows=conn.execute("SELECT d.path,m.memory_id,m.lifecycle_status,m.promoted_to,m.superseded_by FROM documents d LEFT JOIN memory_meta m ON m.document_id=d.id").fetchall()
 except Exception:return r
 ids=defaultdict(list)
 for path,mid,status,promoted,superseded in rows:
  if not mid:checks.append({"code":"memory_id_missing","severity":"info","message":"legacy indexed memory has no stable id","paths":[path]})
  elif not MEMORY_ID_RE.fullmatch(mid):checks.append({"code":"memory_id_invalid","severity":"error","message":f"invalid stable memory id: {mid}","paths":[path]})
  else:ids[mid].append(path)
  if status and status not in LIFECYCLE_STATES:checks.append({"code":"lifecycle_status_invalid","severity":"error","message":f"invalid lifecycle status: {status}","paths":[path]})
  if status=="promoted" and not promoted:checks.append({"code":"promoted_target_missing","severity":"warning","message":"promoted memory has no promoted_to target","paths":[path]})
  if status=="superseded" and not superseded:checks.append({"code":"superseded_target_missing","severity":"warning","message":"superseded memory has no superseded_by target","paths":[path]})
 for mid,paths in ids.items():
  if len(paths)>1:checks.append({"code":"memory_id_duplicate","severity":"error","message":f"stable memory id is duplicated: {mid}","paths":paths})
 known=set(ids)
 for path,_,_,promoted,superseded in rows:
  for field,value in (("promoted_to",promoted),("superseded_by",superseded)):
   target=_target(value)
   if target and target not in known:checks.append({"code":"lifecycle_target_unresolved","severity":"error","message":f"{field} target does not exist: {target}","paths":[path]})
 try:
  for row in conn.execute("SELECT target_memory_id FROM memory_links"):
   if row[0] and row[0] not in known:checks.append({"code":"memory_link_unresolved","severity":"error","message":f"memory:// target does not exist: {row[0]}"})
 except Exception:pass
 counts=Counter(x["severity"] for x in checks);r["status"]="error" if counts["error"] else "warn" if counts["warning"] else "ok";r["summary"].update(errors=counts["error"],warnings=counts["warning"],info=counts["info"],stable_ids=len(known));checks.sort(key=lambda x:({"error":0,"warning":1,"info":2}[x["severity"]],x["code"]));return r
