#!/usr/bin/env python3
from __future__ import annotations
import argparse,json
from pathlib import Path
from memory_config import collect_memory_roots,database_path,default_settings_path,load_settings
from memory_lifecycle import migrate_ids
from memory_store_ext import connect_db,sync_index

def main():
 p=argparse.ArgumentParser(description="Assign stable IDs to legacy Agent Memory Markdown explicitly");p.add_argument("--settings",type=Path,default=default_settings_path());p.add_argument("--json",action="store_true");a=p.parse_args();sp=a.settings.expanduser().resolve(strict=False);settings=load_settings(sp);c=connect_db(database_path(settings,sp));sync_index(c,collect_memory_roots(settings,sp));r=migrate_ids(c);r["sync"]=sync_index(c,collect_memory_roots(settings,sp));c.close();print(json.dumps(r,indent=2,ensure_ascii=False) if a.json else f"migrated {r['migrated']} document(s)")
if __name__=="__main__":main()
