import tempfile
import subprocess
import unittest
from pathlib import Path

from bootstrap import enable_script_imports


enable_script_imports()

from scripts.utils import parse_skill_md  # noqa: E402


class ParseSkillMdTests(unittest.TestCase):
    def test_parses_single_line_frontmatter(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            skill_dir = Path(temp_dir) / "demo-skill"
            skill_dir.mkdir()
            (skill_dir / "SKILL.md").write_text(
                "---\nname: demo-skill\ndescription: 'Demo description'\n---\n\n# Demo\n"
            )

            self.assertEqual(
                parse_skill_md(skill_dir),
                ("demo-skill", "Demo description", "---\nname: demo-skill\ndescription: 'Demo description'\n---\n\n# Demo\n"),
            )

    def test_parses_multiline_description_frontmatter(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            skill_dir = Path(temp_dir) / "demo-skill"
            skill_dir.mkdir()
            (skill_dir / "SKILL.md").write_text(
                "---\nname: demo-skill\ndescription: |\n  First line\n  second line\n---\n\n# Demo\n"
            )

            name, description, _ = parse_skill_md(skill_dir)

            self.assertEqual(name, "demo-skill")
            self.assertEqual(description, "First line second line")

    def test_rejects_missing_frontmatter_delimiters(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            skill_dir = Path(temp_dir) / "demo-skill"
            skill_dir.mkdir()
            (skill_dir / "SKILL.md").write_text("# Demo\n")

            with self.assertRaisesRegex(ValueError, "missing frontmatter"):
                parse_skill_md(skill_dir)


if __name__ == "__main__":
    unittest.main()


class DirectEntrypointTests(unittest.TestCase):
    def test_package_skill_help_works_when_executed_by_file_path_from_repo_root(self):
        repo_root = Path(__file__).resolve().parents[3]
        completed = subprocess.run(
            ["python3", "skills/skill-creator/scripts/package_skill.py", "--help"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=5,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("Usage:", completed.stdout)
