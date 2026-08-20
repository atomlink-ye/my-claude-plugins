import importlib.util
import json
import tempfile
import unittest
import sys
from pathlib import Path

MODULE_PATH = Path(__file__).parents[3] / "skills" / "agent-memory" / "scripts" / "agent_memory.py"
sys.path.insert(0, str(MODULE_PATH.parent))
spec = importlib.util.spec_from_file_location("agent_memory", MODULE_PATH)
am = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = am
assert spec.loader is not None
spec.loader.exec_module(am)


class AgentMemoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.workspace = self.root / "workspace"
        self.project_a = self.workspace / "project-a"
        self.project_b = self.workspace / "project-b"
        self.memory_a = self.root / "memory-a"
        self.memory_b = self.root / "memory-b"
        self.shared = self.root / "shared"
        for path in [self.project_a, self.project_b, self.memory_a, self.memory_b, self.shared]:
            path.mkdir(parents=True, exist_ok=True)
        self.settings_path = self.root / ".agent-memory" / "settings.json"
        self.settings_path.parent.mkdir(parents=True)
        data = {
            "version": 1,
            "database": str(self.root / ".agent-memory" / "index.sqlite3"),
            "shared": [{"path": str(self.shared), "tags": ["domain"]}],
            "bindings": [
                {
                    "path": str(self.workspace),
                    "project": "workspace",
                    "memory": [],
                    "tags": ["workspace"],
                    "projects": [
                        {"path": "project-a", "project": "a", "memory": [{"path": str(self.memory_a), "tags": ["decisions-root"]}], "tags": ["alpha"]},
                        {"path": "project-b", "project": "b", "memory": [str(self.memory_b)], "tags": ["beta"]},
                    ],
                }
            ],
        }
        self.settings_path.write_text(json.dumps(data), encoding="utf-8")
        self.settings = am.load_settings(self.settings_path)
        self.conn = am.connect_db(am.database_path(self.settings, self.settings_path))

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def sync(self):
        return am.sync_index(self.conn, am.collect_memory_roots(self.settings, self.settings_path))

    def test_longest_nested_binding_keeps_siblings_separate(self):
        (self.memory_a / "decision.md").write_text("# Alpha Decision\n\nUse alpha-only architecture.\n", encoding="utf-8")
        (self.memory_b / "decision.md").write_text("# Beta Decision\n\nUse beta-only architecture.\n", encoding="utf-8")
        self.sync()

        binding = am.resolve_binding(self.settings, self.project_a / "src")
        self.assertEqual(binding.project, "a")
        hits = am.search_documents(self.conn, "architecture", project=binding.project)
        paths = {Path(hit["path"]).parent for hit in hits}
        self.assertIn(self.memory_a, paths)
        self.assertNotIn(self.memory_b, paths)
        self.assertIn("decisions-root", hits[0]["tags"])

    def test_shared_memory_is_visible_in_project_scope(self):
        (self.shared / "workflow.md").write_text(
            "---\ntitle: Review Workflow\ntags: [review, reusable]\n---\n\nUse a bounded review loop.\n",
            encoding="utf-8",
        )
        self.sync()
        hits = am.search_documents(self.conn, "bounded review", project="a", tags=["reusable"])
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["projects"], [am.SHARED_SCOPE])
        self.assertIn("domain", hits[0]["tags"])
        self.assertIn("review", hits[0]["tags"])

    def test_cross_project_markdown_link_and_backlink(self):
        shared_doc = self.shared / "workflow.md"
        shared_doc.write_text("# Workflow\n\nReusable domain workflow.\n", encoding="utf-8")
        relative = Path("../shared/workflow.md")
        (self.memory_a / "project.md").write_text(
            f"# Project A\n\nFollow the [shared workflow]({relative.as_posix()}).\n",
            encoding="utf-8",
        )
        self.sync()

        graph = am.link_graph(self.conn, str(shared_doc))
        self.assertEqual(len(graph["inbound"]), 1)
        self.assertEqual(graph["inbound"][0]["title"], "Project A")

        source_graph = am.link_graph(self.conn, str(self.memory_a / "project.md"))
        self.assertTrue(source_graph["outbound"][0]["resolved"])
        self.assertEqual(Path(source_graph["outbound"][0]["path"]), shared_doc)

    def test_sync_removes_deleted_source(self):
        note = self.memory_a / "temporary.md"
        note.write_text("# Temporary\n\nA disposable durable note.\n", encoding="utf-8")
        first = self.sync()
        self.assertEqual(first["indexed"], 1)
        note.unlink()
        second = self.sync()
        self.assertEqual(second["removed"], 1)
        self.assertEqual(am.list_documents(self.conn), [])

    def test_parent_memory_is_not_inherited_without_opt_in(self):
        data = json.loads(self.settings_path.read_text(encoding="utf-8"))
        data["bindings"][0]["memory"] = [str(self.root / "parent-memory")]
        (self.root / "parent-memory").mkdir()
        self.settings_path.write_text(json.dumps(data), encoding="utf-8")
        settings = am.load_settings(self.settings_path)
        binding = am.resolve_binding(settings, self.project_a)
        self.assertEqual(tuple(location.path for location in binding.memory_roots), (self.memory_a,))


if __name__ == "__main__":
    unittest.main()
