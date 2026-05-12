import tempfile
import unittest
import subprocess
from pathlib import Path

from bootstrap import enable_script_imports


enable_script_imports()

from scripts import run_eval  # noqa: E402


class RenderRunnerCommandTests(unittest.TestCase):
    def test_renders_template_with_shell_quoted_placeholders(self):
        command = run_eval.render_runner_command(
            template="glm claude -p {query_arg} --model {model} --cwd {project_root_arg} --skill {skill_path_arg}",
            query='say "hi"',
            project_root="/tmp/project root",
            skill_path="/tmp/skill path",
            skill_name="demo-skill",
            model="glm-5.1",
        )

        self.assertEqual(
            command,
            "glm claude -p 'say \"hi\"' --model glm-5.1 --cwd '/tmp/project root' --skill '/tmp/skill path'",
        )

    def test_model_arg_placeholder_is_empty_when_model_missing(self):
        command = run_eval.render_runner_command(
            template="claude -p {query_arg}{model_arg}",
            query="hello",
            project_root="/tmp/project",
            skill_path="/tmp/skill",
            skill_name="demo-skill",
            model=None,
        )

        self.assertEqual(command, "claude -p hello")


class RunnerModeCommandTests(unittest.TestCase):
    def test_builds_runner_specific_model_args(self):
        self.assertEqual(run_eval.build_model_arg("claude-stream", "opus model"), " --model 'opus model'")
        self.assertEqual(run_eval.build_model_arg("codex-json", "gpt-5.1"), " -m gpt-5.1")
        self.assertEqual(run_eval.build_model_arg("opencode-json", "gpt-5.1"), " -m gpt-5.1")

    def test_default_runner_commands_include_expected_output_formats(self):
        self.assertIn("--output-format stream-json", run_eval.default_runner_command("claude-stream"))
        self.assertIn("--json", run_eval.default_runner_command("codex-json"))
        self.assertIn("--format json", run_eval.default_runner_command("opencode-json"))

    def test_rejects_unsupported_runner_mode(self):
        with self.assertRaises(ValueError):
            run_eval.default_runner_command("unknown-runner")


class TriggerParsingTests(unittest.TestCase):
    def test_detects_claude_stream_trigger_from_partial_json(self):
        output = "\n".join(
            [
                '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Skill"}}}',
                '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"skill\\":\\"demo-skill-skill-1234\\"}"}}}',
            ]
        )

        triggered = run_eval.detect_trigger(
            output=output,
            runner_mode="claude-stream",
            trigger_marker="demo-skill-skill-1234",
        )

        self.assertTrue(triggered)

    def test_detects_codex_json_trigger_from_command_execution_output(self):
        output = "\n".join(
            [
                '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc \\"cat /tmp/skill/SKILL.md\\""}}',
                '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","aggregated_output":"read /tmp/skill/SKILL.md"}}',
            ]
        )

        triggered = run_eval.detect_trigger(
            output=output,
            runner_mode="codex-json",
            trigger_marker="/tmp/skill/SKILL.md",
        )

        self.assertTrue(triggered)

    def test_detects_opencode_json_trigger_from_tool_use_input(self):
        output = (
            '{"type":"tool_use","part":{"type":"tool","tool":"read","state":{"input":{"filePath":"/tmp/skill/SKILL.md"}}}}'
        )

        triggered = run_eval.detect_trigger(
            output=output,
            runner_mode="opencode-json",
            trigger_marker="/tmp/skill/SKILL.md",
        )

        self.assertTrue(triggered)

    def test_ignores_non_json_and_wrong_tool_events(self):
        output = "\n".join(
            [
                "not json",
                '{"type":"tool_use","part":{"type":"text","text":"/tmp/skill/SKILL.md"}}',
            ]
        )

        self.assertFalse(
            run_eval.detect_trigger(
                output=output,
                runner_mode="opencode-json",
                trigger_marker="/tmp/skill/SKILL.md",
            )
        )


class RunSingleQueryTests(unittest.TestCase):
    def test_uses_custom_runner_command_and_detects_trigger(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir) / "project"
            skill_path = project_root / "skills" / "demo"
            skill_path.mkdir(parents=True)
            command = (
                "python3 -c 'import json,sys; "
                "print(json.dumps({{\"type\":\"tool_use\",\"part\":{{\"type\":\"tool\",\"tool\":\"read\",\"state\":{{\"input\":{{\"filePath\":sys.argv[1]}}}}}}}}))' "
                "{trigger_marker}"
            )

            self.assertTrue(
                run_eval.run_single_query(
                    query="use the demo skill",
                    skill_name="demo-skill",
                    skill_path=str(skill_path),
                    skill_description="Demo description",
                    timeout=5,
                    project_root=str(project_root),
                    runner_command=command,
                    runner_shell="zsh",
                    runner_mode="opencode-json",
                )
            )

    def test_non_claude_eval_prompt_includes_candidate_description_and_temp_skill_path(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir) / "project"
            skill_path = project_root / "skills" / "demo"
            skill_path.mkdir(parents=True)
            (skill_path / "SKILL.md").write_text(
                "---\nname: demo-skill\ndescription: Original description\n---\n\n# Demo\n"
            )
            command = (
                "python3 -c 'import json,sys; "
                "prompt=sys.argv[1]; marker=sys.argv[2]; "
                "assert \"Candidate description:\\nCandidate description with shell chars\" in prompt, prompt; "
                "assert \"Original description\" not in prompt, prompt; "
                "assert marker in prompt, prompt; "
                "assert \"If the skill is relevant, inspect its SKILL.md\" in prompt, prompt; "
                "print(json.dumps({{\"type\":\"tool_use\",\"part\":{{\"type\":\"tool\",\"tool\":\"read\",\"state\":{{\"input\":{{\"filePath\":marker}}}}}}}}))' "
                "{eval_prompt_arg} {trigger_marker_arg}"
            )

            self.assertTrue(
                run_eval.run_single_query(
                    query='please handle $(literal) "quoted"',
                    skill_name="demo-skill",
                    skill_path=str(skill_path),
                    skill_description="Candidate description with shell chars; $(nope)",
                    timeout=5,
                    project_root=str(project_root),
                    runner_command=command,
                    runner_shell="zsh",
                    runner_mode="opencode-json",
                )
            )

            self.assertEqual(list(project_root.glob(".skill-creator-eval-*")), [])

    def test_non_claude_temp_skill_snapshot_uses_candidate_description(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir) / "project"
            skill_path = project_root / "skills" / "demo"
            skill_path.mkdir(parents=True)
            (skill_path / "SKILL.md").write_text(
                "---\nname: demo-skill\ndescription: Original description\n---\n\n# Demo\n"
            )
            command = (
                "python3 -c 'import json, pathlib, sys; "
                "skill_md=pathlib.Path(sys.argv[1]); content=skill_md.read_text(); "
                "assert \"description: |\" in content, content; "
                "assert \"Candidate snapshot description\" in content, content; "
                "assert \"Original description\" not in content, content; "
                "print(json.dumps({{\"type\":\"item.started\",\"item\":{{\"type\":\"command_execution\",\"command\":str(skill_md)}}}}))' "
                "{trigger_marker_arg}"
            )

            self.assertTrue(
                run_eval.run_single_query(
                    query="use demo",
                    skill_name="demo-skill",
                    skill_path=str(skill_path),
                    skill_description="Candidate snapshot description",
                    timeout=5,
                    project_root=str(project_root),
                    runner_command=command,
                    runner_shell="zsh",
                    runner_mode="codex-json",
                )
            )
    def test_removes_temporary_claude_command_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir) / "project"

            self.assertFalse(
                run_eval.run_single_query(
                    query="hello",
                    skill_name="demo-skill",
                    skill_path=str(project_root / "skill"),
                    skill_description="Demo description",
                    timeout=5,
                    project_root=str(project_root),
                    runner_command="printf ''",
                    runner_shell="zsh",
                    runner_mode="claude-stream",
                )
            )

            commands_dir = project_root / ".claude" / "commands"
            self.assertEqual(list(commands_dir.glob("*.md")), [])


class RunEvalFailureTests(unittest.TestCase):
    def test_structures_runner_command_failures_in_results(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir) / "project"
            skill_path = project_root / "skills" / "demo"
            skill_path.mkdir(parents=True)

            result = run_eval.run_eval(
                eval_set=[{"query": "use demo", "should_trigger": True}],
                skill_name="demo-skill",
                skill_path=skill_path,
                description="Demo description",
                num_workers=1,
                timeout=5,
                project_root=project_root,
                runner_command="python3 -c 'import sys; print(\"partial\"); print(\"fatal\", file=sys.stderr); sys.exit(7)'",
                runner_shell="zsh",
                runner_mode="opencode-json",
            )

        self.assertEqual(result["summary"]["runner_errors"], 1)
        self.assertEqual(result["results"][0]["runner_errors"], 1)
        self.assertIn("exited 7", result["results"][0]["errors"][0])
        self.assertFalse(result["results"][0]["pass"])

    def test_runner_command_failure_cannot_pass_negative_eval(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir) / "project"
            skill_path = project_root / "skills" / "demo"
            skill_path.mkdir(parents=True)

            result = run_eval.run_eval(
                eval_set=[{"query": "irrelevant", "should_trigger": False}],
                skill_name="demo-skill",
                skill_path=skill_path,
                description="Demo description",
                num_workers=1,
                timeout=5,
                project_root=project_root,
                runner_command="python3 -c 'import sys; sys.exit(7)'",
                runner_shell="zsh",
                runner_mode="opencode-json",
            )

        self.assertEqual(result["summary"]["runner_errors"], 1)
        self.assertFalse(result["results"][0]["pass"])

    def test_runner_timeout_cannot_pass_negative_eval(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir) / "project"
            skill_path = project_root / "skills" / "demo"
            skill_path.mkdir(parents=True)

            result = run_eval.run_eval(
                eval_set=[{"query": "irrelevant", "should_trigger": False}],
                skill_name="demo-skill",
                skill_path=skill_path,
                description="Demo description",
                num_workers=1,
                timeout=1,
                project_root=project_root,
                runner_command="python3 -c 'import time; time.sleep(2)'",
                runner_shell="zsh",
                runner_mode="opencode-json",
            )

        self.assertEqual(result["summary"]["runner_errors"], 1)
        self.assertFalse(result["results"][0]["pass"])
        self.assertIn("timed out", result["results"][0]["errors"][0])


class DirectScriptExecutionTests(unittest.TestCase):
    def test_run_eval_help_works_when_executed_by_file_path_from_repo_root(self):
        repo_root = Path(__file__).resolve().parents[3]
        completed = subprocess.run(
            ["python3", "skills/skill-creator/scripts/run_eval.py", "--help"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=5,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("Run trigger evaluation", completed.stdout)


if __name__ == "__main__":
    unittest.main()
