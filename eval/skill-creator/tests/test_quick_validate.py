import subprocess
import tempfile
import unittest
from pathlib import Path

from bootstrap import enable_script_imports


enable_script_imports()

from scripts.quick_validate import validate_skill  # noqa: E402


class QuickValidateTests(unittest.TestCase):
    def test_validates_simple_valid_frontmatter_without_external_yaml(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            skill_dir = Path(temp_dir) / "demo-skill"
            skill_dir.mkdir()
            (skill_dir / "SKILL.md").write_text(
                "---\n"
                "name: demo-skill\n"
                "description: 'Demo description'\n"
                "compatibility: Claude Code\n"
                "---\n\n"
                "# Demo\n"
            )

            valid, message = validate_skill(skill_dir)

        self.assertTrue(valid, message)
        self.assertEqual(message, "Skill is valid!")

    def test_validates_vendored_skill_creator_frontmatter(self):
        repo_root = Path(__file__).resolve().parents[3]

        valid, message = validate_skill(repo_root / "skills" / "skill-creator")

        self.assertTrue(valid, message)

    def test_validates_list_valued_allowed_tools_frontmatter(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            skill_dir = Path(temp_dir) / "demo-skill"
            skill_dir.mkdir()
            (skill_dir / "SKILL.md").write_text(
                "---\n"
                "name: demo-skill\n"
                "description: Demo description\n"
                "allowed-tools:\n"
                "  - Read\n"
                "  - Write\n"
                "---\n\n"
                "# Demo\n"
            )

            valid, message = validate_skill(skill_dir)

        self.assertTrue(valid, message)

    def test_rejects_unexpected_frontmatter_key(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            skill_dir = Path(temp_dir) / "demo-skill"
            skill_dir.mkdir()
            (skill_dir / "SKILL.md").write_text(
                "---\n"
                "name: demo-skill\n"
                "description: Demo description\n"
                "unexpected: nope\n"
                "---\n\n"
                "# Demo\n"
            )

            valid, message = validate_skill(skill_dir)

        self.assertFalse(valid)
        self.assertIn("Unexpected key", message)

    def test_rejects_missing_description(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            skill_dir = Path(temp_dir) / "demo-skill"
            skill_dir.mkdir()
            (skill_dir / "SKILL.md").write_text("---\nname: demo-skill\n---\n\n# Demo\n")

            valid, message = validate_skill(skill_dir)

        self.assertFalse(valid)
        self.assertIn("Missing 'description'", message)


class QuickValidateDirectExecutionTests(unittest.TestCase):
    def test_script_validates_vendored_skill_from_repo_root(self):
        repo_root = Path(__file__).resolve().parents[3]
        completed = subprocess.run(
            ["python3", "skills/skill-creator/scripts/quick_validate.py", "skills/skill-creator"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=5,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("Skill is valid!", completed.stdout)


if __name__ == "__main__":
    unittest.main()
