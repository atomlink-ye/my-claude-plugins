import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from bootstrap import enable_script_imports


enable_script_imports()

from scripts import run_loop  # noqa: E402


class RunLoopRunnerConfigTests(unittest.TestCase):
    def test_passes_runner_configuration_to_eval_and_improvement(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            skill_dir = Path(temp_dir) / "demo-skill"
            skill_dir.mkdir()
            (skill_dir / "SKILL.md").write_text(
                "---\nname: demo-skill\ndescription: Current description\n---\n\n# Demo\n"
            )

            def fake_run_eval(**kwargs):
                self.assertEqual(kwargs["runner_command"], "eval-cmd")
                self.assertEqual(kwargs["runner_shell"], "bash")
                self.assertEqual(kwargs["runner_mode"], "opencode-json")
                return {
                    "results": [
                        {
                            "query": "use demo",
                            "should_trigger": True,
                            "trigger_rate": 0,
                            "triggers": 0,
                            "runs": 1,
                            "runner_errors": 0,
                            "errors": [],
                            "pass": False,
                        }
                    ],
                    "summary": {"passed": 0, "failed": 1, "total": 1, "runner_errors": 0},
                }

            def fake_improve_description(**kwargs):
                self.assertEqual(kwargs["runner_command"], "improve-cmd")
                self.assertEqual(kwargs["runner_shell"], "bash")
                self.assertEqual(kwargs["runner_mode"], "opencode-text")
                return "Improved description"

            with patch("scripts.run_loop.find_project_root", return_value=Path(temp_dir)), \
                patch("scripts.run_loop.run_eval", side_effect=fake_run_eval), \
                patch("scripts.run_loop.improve_description", side_effect=fake_improve_description):
                output = run_loop.run_loop(
                    eval_set=[{"query": "use demo", "should_trigger": True}],
                    skill_path=skill_dir,
                    description_override=None,
                    num_workers=1,
                    timeout=5,
                    max_iterations=2,
                    runs_per_query=1,
                    trigger_threshold=0.5,
                    holdout=0,
                    model="gpt-5.1",
                    runner_command="eval-cmd",
                    runner_shell="bash",
                    runner_mode="opencode-json",
                    improve_runner_command="improve-cmd",
                    improve_runner_shell="bash",
                    improve_runner_mode="opencode-text",
                    verbose=False,
                )

        self.assertEqual(output["final_description"], "Improved description")

    def test_runner_errors_abort_loop_clearly(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            skill_dir = Path(temp_dir) / "demo-skill"
            skill_dir.mkdir()
            (skill_dir / "SKILL.md").write_text(
                "---\nname: demo-skill\ndescription: Current description\n---\n\n# Demo\n"
            )

            def fake_run_eval(**kwargs):
                return {
                    "results": [
                        {
                            "query": "do not use demo",
                            "should_trigger": False,
                            "trigger_rate": 0,
                            "triggers": 0,
                            "runs": 1,
                            "runner_errors": 1,
                            "errors": ["runner failed"],
                            "pass": True,
                        }
                    ],
                    "summary": {"passed": 1, "failed": 0, "total": 1, "runner_errors": 1},
                }

            with patch("scripts.run_loop.find_project_root", return_value=Path(temp_dir)), \
                patch("scripts.run_loop.run_eval", side_effect=fake_run_eval):
                with self.assertRaisesRegex(RuntimeError, "runner_errors=1"):
                    run_loop.run_loop(
                        eval_set=[{"query": "do not use demo", "should_trigger": False}],
                        skill_path=skill_dir,
                        description_override=None,
                        num_workers=1,
                        timeout=5,
                        max_iterations=1,
                        runs_per_query=1,
                        trigger_threshold=0.5,
                        holdout=0,
                        model="gpt-5.1",
                        runner_command="eval-cmd",
                        runner_shell="bash",
                        runner_mode="opencode-json",
                        improve_runner_command=None,
                        improve_runner_shell="bash",
                        improve_runner_mode="claude-text",
                        verbose=False,
                    )


class RunLoopDirectExecutionTests(unittest.TestCase):
    def test_help_works_when_executed_by_file_path_from_repo_root(self):
        repo_root = Path(__file__).resolve().parents[3]
        completed = subprocess.run(
            ["python3", "skills/skill-creator/scripts/run_loop.py", "--help"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=5,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("Run eval + improve loop", completed.stdout)


if __name__ == "__main__":
    unittest.main()
