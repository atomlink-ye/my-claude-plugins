import importlib.util,json,sys,tempfile,unittest
from pathlib import Path
MODULE=Path(__file__).parents[3]/"skills"/"agent-memory"/"scripts"/"agent_memory.py";sys.path.insert(0,str(MODULE.parent));spec=importlib.util.spec_from_file_location("agent_memory_roadmap",MODULE);am=importlib.util.module_from_spec(spec);sys.modules[spec.name]=am;spec.loader.exec_module(am)
from memory_doctor_ext import doctor
from memory_lifecycle import update_lifecycle
class RoadmapTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();self.project=self.root/"project";self.memory=self.root/"memory";self.project.mkdir();self.memory.mkdir();self.settings_path=self.root/"settings.json";self.db=self.root/"index.sqlite3";self.settings_path.write_text(json.dumps({"version":1,"database":str(self.db),"shared":[],"bindings":[{"path":str(self.project),"project":"demo","memory":[str(self.memory)]}]}));self.settings=am.load_settings(self.settings_path);self.conn=am.connect_db(self.db);self.binding=am.resolve_binding(self.settings,self.project)
 def tearDown(self):self.conn.close();self.tmp.cleanup()
 def sync(self):return am.sync_index(self.conn,am.collect_memory_roots(self.settings,self.settings_path))
 def test_capture_has_stable_id_and_raw_lifecycle(self):
  r=am.capture_memory(self.binding,"learning","Stable identity lesson");self.assertTrue(r["memory_id"].startswith("mem_"));text=Path(r["path"]).read_text();self.assertIn(f"id: {r['memory_id']}",text);self.assertIn("status: raw",text);self.sync();hit=am.list_documents(self.conn,project="demo")[0];self.assertEqual(hit["memory_id"],r["memory_id"]);self.assertEqual(hit["status"],"raw")
 def test_duplicate_before_capture_blocks_by_default(self):
  first=am.capture_memory(self.binding,"learning","Resolve the actual worktree before recall");self.assertTrue(first["created"]);second=am.capture_memory(self.binding,"learning","Resolve the actual worktree before recall");self.assertFalse(second["created"]);self.assertTrue(second["duplicate_blocked"]);third=am.capture_memory(self.binding,"learning","Resolve the actual worktree before recall",allow_duplicate=True);self.assertTrue(third["created"])
 def test_lifecycle_promote_and_stable_link(self):
  a=am.capture_memory(self.binding,"learning","Evidence");b=am.capture_memory(self.binding,"learning","Canonical rule");self.sync();update_lifecycle(self.conn,a["memory_id"],"promoted",target=b["memory_id"]);self.sync();row=[x for x in am.list_documents(self.conn,project="demo") if x["memory_id"]==a["memory_id"]][0];self.assertEqual(row["status"],"promoted");self.assertEqual(row["promoted_to"],f"memory://{b['memory_id']}")
  p=Path(a["path"]);p.write_text(p.read_text()+f"\n[canonical](memory://{b['memory_id']})\n");self.sync();graph=am.link_graph(self.conn,a["memory_id"]);self.assertTrue(any(x.get("memory_id")==b["memory_id"] and x["resolved"] for x in graph["outbound"]))
 def test_doctor_detects_duplicate_ids(self):
  a=am.capture_memory(self.binding,"learning","First",memory_id="mem_same");am.capture_memory(self.binding,"learning","Second",memory_id="mem_same");self.sync();r=doctor(self.conn,self.settings,self.settings_path,self.db);self.assertEqual(r["status"],"error");self.assertIn("memory_id_duplicate",[x["code"] for x in r["checks"]])
if __name__=="__main__":unittest.main()
