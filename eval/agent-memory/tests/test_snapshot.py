import importlib.util
import io
import json
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

MODULE_PATH = Path(__file__).parents[3] / "skills" / "agent-memory" / "scripts" / "agent_memory.py"
sys.path.insert(0, str(MODULE_PATH.parent))
spec = importlib.util.spec_from_file_location("agent_memory_snapshot_tests", MODULE_PATH)
am = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = am
assert spec.loader is not None
spec.loader.exec_module(am)

from memory_admin import doctor
from memory_snapshot import restore_snapshot, snapshot_registry


class AgentMemorySnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.shared = self.root / "memory" / "shared"
        self.project_a = self.root / "workspace" / "project-a"
        self.project_b = self.root / "workspace" / "project-b"
        self.memory_a = self.root / "memory" / "a"
        self.memory_b = self.root / "memory" / "b"
        for path in [self.shared, self.project_a, self.project_b, self.memory_a, self.memory_b]:
            path.mkdir(parents=True, exist_ok=True)
        self.settings_path = self.root / ".agent-memory" / "settings.json"
        self.settings_path.parent.mkdir()
        self.data = {
            "version": 1,
            "database": "index.sqlite3",
            "shared": [{"path": str(self.shared), "tags": ["shared"]}],
            "bindings": [
                {"path": str(self.project_a), "project": "a", "memory": [{"path": str(self.memory_a), "capture": True}]},
                {"path": str(self.project_b), "project": "b", "memory": [str(self.memory_b)]},
            ],
        }
        self.settings_path.write_text(json.dumps(self.data), encoding="utf-8")
        self.settings = am.load_settings(self.settings_path)
        self.db_path = am.database_path(self.settings, self.settings_path)
        self.conn = am.connect_db(self.db_path)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def sync(self):
        return am.sync_index(self.conn, am.collect_memory_roots(self.settings, self.settings_path))

    def test_snapshot_contains_sources_settings_and_consistent_database(self):
        (self.shared / "workflows" / "review.md").parent.mkdir()
        (self.shared / "workflows" / "review.md").write_text("# Shared review\n", encoding="utf-8")
        (self.memory_a / "nested").mkdir()
        (self.memory_a / "nested" / "decision.md").write_text("# A decision\n", encoding="utf-8")
        (self.memory_b / "learning.md").write_text("# B learning\n", encoding="utf-8")
        self.sync()

        result = snapshot_registry(
            self.settings,
            self.settings_path,
            self.db_path,
            am.collect_memory_roots(self.settings, self.settings_path),
            self.root / "archives",
        )

        archive_path = Path(result["path"])
        self.assertTrue(archive_path.is_file())
        self.assertEqual(result["markdown_files"], 3)
        self.assertTrue(result["database"]["included"])
        with tarfile.open(archive_path, "r:gz") as archive:
            names = set(archive.getnames())
            manifest = json.load(archive.extractfile("manifest.json"))
        self.assertIn("settings.json", names)
        self.assertIn("database/index.sqlite3", names)
        archive_roots = {entry["path"]: entry["archive_path"] for entry in manifest["roots"]}
        self.assertIn(f"{archive_roots[str(self.shared)]}/workflows/review.md", names)
        self.assertIn(f"{archive_roots[str(self.memory_a)]}/nested/decision.md", names)
        self.assertIn(f"{archive_roots[str(self.memory_b)]}/learning.md", names)
        self.assertEqual({entry["scope"] for entry in manifest["roots"]}, {"_shared", "a", "b"})

    def test_snapshot_skips_missing_root_and_keeps_remaining_sources(self):
        missing = self.root / "memory" / "gone"
        self.data["bindings"][1]["memory"].append(str(missing))
        self.settings_path.write_text(json.dumps(self.data), encoding="utf-8")
        self.settings = am.load_settings(self.settings_path)
        (self.memory_a / "still-here.md").write_text("# Still here\n", encoding="utf-8")
        self.sync()

        result = snapshot_registry(
            self.settings,
            self.settings_path,
            self.db_path,
            am.collect_memory_roots(self.settings, self.settings_path),
            self.root / "archives",
        )

        self.assertEqual(result["missing_roots"], [str(missing)])
        self.assertEqual(result["markdown_files"], 1)
        with tarfile.open(result["path"], "r:gz") as archive:
            manifest = json.load(archive.extractfile("manifest.json"))
        self.assertEqual(manifest["missing_roots"], [str(missing)])

    def test_cli_snapshot_writes_to_requested_directory(self):
        (self.memory_a / "note.md").write_text("# Note\n", encoding="utf-8")
        self.sync()
        output = io.StringIO()
        with redirect_stdout(output):
            code = am.main([
                "--settings", str(self.settings_path), "--json", "snapshot",
                "--output", str(self.root / "requested"),
            ])
        result = json.loads(output.getvalue())
        self.assertEqual(code, 0)
        self.assertTrue(Path(result["path"]).is_file())
        self.assertEqual(Path(result["path"]).parent, self.root / "requested")

    def test_restore_recreates_original_paths_without_staling_index(self):
        note = self.memory_a / "nested" / "lesson.md"
        note.parent.mkdir()
        note.write_text("# Lesson\n\nRestore the original timestamp.\n", encoding="utf-8")
        self.sync()
        snapshot = snapshot_registry(
            self.settings,
            self.settings_path,
            self.db_path,
            am.collect_memory_roots(self.settings, self.settings_path),
            self.root / "archives",
        )
        self.conn.close()
        note.unlink()
        self.settings_path.unlink()
        self.db_path.unlink()
        for suffix in ("-wal", "-shm"):
            Path(f"{self.db_path}{suffix}").unlink(missing_ok=True)

        restored = restore_snapshot(Path(snapshot["path"]))

        self.assertEqual(restored["markdown_files"], 1)
        self.assertTrue(note.is_file())
        self.assertTrue(self.settings_path.is_file())
        self.assertTrue(self.db_path.is_file())
        self.settings = am.load_settings(self.settings_path)
        self.conn = am.connect_db(self.db_path)
        health = doctor(self.conn, self.settings, self.settings_path, self.db_path)
        self.assertEqual(health["status"], "ok")


if __name__ == "__main__":
    unittest.main()
