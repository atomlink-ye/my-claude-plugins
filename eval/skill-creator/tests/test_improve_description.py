import subprocess
import tempfile
import unittest
from pathlib import Path

from bootstrap import enable_script_imports


enable_script_imports()

from scripts import improve_description  # noqa: E402


def eval_results() -> dict:
    return {
        "description": "Current description",
        "results": [
            {
                "query": "please use demo",
                "should_trigger": True,
                "pass": False,
                "triggers": 0,
                "runs": 1,
            }
        ],
        "summary": {"passed": 0, "failed": 1, "total": 1},
    }


class ImproveDescriptionRunnerTests(unittest.TestCase):
    def test_improves_description_with_configurable_text_runner(self):
        description = improve_description.improve_description(
            skill_name="demo-skill",
            skill_content="# Demo",
            current_description="Current description",
            eval_results=eval_results(),
            history=[],
            model="gpt-5.1",
            runner_command="python3 -c 'print(\"<new_description>custom provider description</new_description>\")'",
            runner_shell="zsh",
            runner_mode="codex-text",
        )

        self.assertEqual(description, "custom provider description")

    def test_improvement_runner_failure_aborts_clearly(self):
        with self.assertRaisesRegex(Exception, "exited 9"):
            improve_description.improve_description(
                skill_name="demo-skill",
                skill_content="# Demo",
                current_description="Current description",
                eval_results=eval_results(),
                history=[],
                model="gpt-5.1",
                runner_command="python3 -c 'import sys; print(\"bad\"); print(\"fatal\", file=sys.stderr); sys.exit(9)'",
                runner_shell="zsh",
                runner_mode="codex-text",
            )


class ImproveDescriptionDirectExecutionTests(unittest.TestCase):
    def test_help_works_when_executed_by_file_path_from_repo_root(self):
        repo_root = Path(__file__).resolve().parents[3]
        completed = subprocess.run(
            ["python3", "skills/skill-creator/scripts/improve_description.py", "--help"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=5,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("Improve a skill description", completed.stdout)

    def test_cli_accepts_configurable_text_runner(self):
        repo_root = Path(__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            skill_dir = temp / "demo-skill"
            skill_dir.mkdir()
            (skill_dir / "SKILL.md").write_text(
                "---\nname: demo-skill\ndescription: Current description\n---\n\n# Demo\n"
            )
            eval_results_path = temp / "eval_results.json"
            eval_results_path.write_text(__import__("json").dumps(eval_results()))

            completed = subprocess.run(
                [
                    "python3",
                    "skills/skill-creator/scripts/improve_description.py",
                    "--eval-results",
                    str(eval_results_path),
                    "--skill-path",
                    str(skill_dir),
                    "--model",
                    "gpt-5.1",
                    "--runner-mode",
                    "codex-text",
                    "--runner-command",
                    "python3 -c 'print(\"<new_description>cli provider</new_description>\")'",
                ],
                cwd=repo_root,
                capture_output=True,
                text=True,
                timeout=5,
            )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("cli provider", completed.stdout)


if __name__ == "__main__":
    unittest.main()
