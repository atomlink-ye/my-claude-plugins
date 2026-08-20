import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

MODULE_PATH = Path(__file__).parents[3] / "skills" / "agent-memory" / "scripts" / "agent_memory.py"
sys.path.insert(0, str(MODULE_PATH.parent))
spec = importlib.util.spec_from_file_location("agent_memory_admin_tests", MODULE_PATH)
am = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = am
assert spec.loader is not None
spec.loader.exec_module(am)

from memory_admin import doctor, preferred_capture_root, project_inventory, tag_inventory


class AgentMemoryAdminTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.project = self.root / "workspace" / "project-a"
        self.memory = self.root / "memory-a"
        self.secondary = self.root / "memory-secondary"
        self.project.mkdir(parents=True)
        self.memory.mkdir()
        self.secondary.mkdir()
        self.settings_path = self.root / ".agent-memory" / "settings.json"
        self.settings_path.parent.mkdir()
        self.db_path = self.settings_path.parent / "index.sqlite3"
        self.data = {
            "version": 1,
            "database": "index.sqlite3",
            "shared": [],
            "bindings": [
                {
                    "path": str(self.project),
                    "project": "a",
                    "memory": [
                        {"path": str(self.memory), "capture": True, "tags": ["a:knowledge"]},
                        {"path": str(self.secondary), "tags": ["a:research"]},
                    ],
                    "tags": ["a"],
                }
            ],
        }
        self.settings_path.write_text(json.dumps(self.data), encoding="utf-8")
        self.settings = am.load_settings(self.settings_path)
        self.conn = am.connect_db(am.database_path(self.settings, self.settings_path))

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def sync(self):
        return am.sync_index(self.conn, am.collect_memory_roots(self.settings, self.settings_path))

    def test_explicit_capture_root_is_selected(self):
        binding = am.resolve_binding(self.settings, self.project)
        self.assertEqual(preferred_capture_root(self.settings, binding), self.memory)
        captured = am.capture_memory(binding, "learning", "Capture root preference", root=str(preferred_capture_root(self.settings, binding)))
        self.assertEqual(Path(captured["path"]).parent, self.memory / "learnings")

    def test_project_and_tag_inventory(self):
        (self.memory / "ops.md").write_text(
            "---\ntitle: Operations\ntags: [a:operations]\n---\n\nOperational guidance.\n",
            encoding="utf-8",
        )
        self.sync()
        projects = project_inventory(self.conn, self.settings)
        self.assertEqual(projects[0]["project"], "a")
        self.assertEqual(projects[0]["documents"], 1)
        self.assertEqual(Path(projects[0]["capture_root"]), self.memory)
        tags = {item["tag"]: item["count"] for item in tag_inventory(self.conn, "a")}
        self.assertEqual(tags["a:operations"], 1)
        self.assertEqual(tags["a:knowledge"], 1)

    def test_doctor_reports_healthy_synced_registry(self):
        (self.memory / "note.md").write_text("# Note\n\nHealthy memory.\n", encoding="utf-8")
        self.sync()
        result = doctor(self.conn, self.settings, self.settings_path, self.db_path, self.project)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["summary"]["errors"], 0)
        self.assertEqual(result["summary"]["warnings"], 0)
        self.assertEqual(result["resolved"]["project"], "a")
        self.assertEqual(Path(result["resolved"]["capture_root"]), self.memory)

    def test_doctor_separates_dangling_links_from_existing_external_files(self):
        external = self.root / "normal-project-file.md"
        external.write_text("# External\n", encoding="utf-8")
        (self.memory / "links.md").write_text(
            "# Links\n\n[external](../normal-project-file.md)\n[missing](missing.md)\n",
            encoding="utf-8",
        )
        self.sync()
        result = doctor(self.conn, self.settings, self.settings_path, self.db_path)
        codes = [item["code"] for item in result["checks"]]
        self.assertIn("link_target_missing", codes)
        self.assertIn("links_external_local", codes)
        self.assertEqual(result["summary"]["dangling_links"], 1)

    def test_doctor_reports_multiple_capture_roots_as_error(self):
        data = json.loads(self.settings_path.read_text(encoding="utf-8"))
        data["bindings"][0]["memory"][1]["capture"] = True
        self.settings_path.write_text(json.dumps(data), encoding="utf-8")
        settings = am.load_settings(self.settings_path)
        result = doctor(self.conn, settings, self.settings_path, self.db_path)
        self.assertEqual(result["status"], "error")
        self.assertIn("capture_root_multiple", [item["code"] for item in result["checks"]])

    def test_doctor_reports_unindexed_markdown(self):
        (self.memory / "after-sync.md").write_text("# Not Indexed Yet\n", encoding="utf-8")
        result = doctor(self.conn, self.settings, self.settings_path, self.db_path)
        self.assertIn("markdown_unindexed", [item["code"] for item in result["checks"]])
        self.assertEqual(result["summary"]["unindexed_markdown"], 1)

    def test_cli_doctor_does_not_create_missing_database(self):
        home = self.root / "fresh"
        home.mkdir()
        settings = home / "settings.json"
        settings.write_text(json.dumps({"version": 1, "database": "index.sqlite3", "shared": [], "bindings": []}), encoding="utf-8")
        database = home / "index.sqlite3"
        output = io.StringIO()
        with redirect_stdout(output):
            code = am.main(["--settings", str(settings), "--json", "doctor"])
        payload = json.loads(output.getvalue())
        self.assertEqual(code, 2)
        self.assertEqual(payload["checks"][0]["code"], "database_missing")
        self.assertFalse(database.exists())

    def test_cli_doctor_returns_structured_invalid_settings_error(self):
        settings = self.root / "broken-settings.json"
        settings.write_text("{not-json", encoding="utf-8")
        output = io.StringIO()
        with redirect_stdout(output):
            code = am.main(["--settings", str(settings), "--json", "doctor"])
        payload = json.loads(output.getvalue())
        self.assertEqual(code, 2)
        self.assertEqual(payload["checks"][0]["code"], "settings_invalid")


if __name__ == "__main__":
    unittest.main()
