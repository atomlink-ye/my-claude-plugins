import os
import subprocess
import unittest
from unittest.mock import patch

from bootstrap import enable_script_imports


enable_script_imports()

from scripts import runner  # noqa: E402


class RunnerCommandRenderingTests(unittest.TestCase):
    def test_renders_template_with_shell_quoted_arg_placeholders(self):
        command = runner.render_runner_command(
            template="glm claude -p {query_arg} --model {model} --cwd {project_root_arg} --skill {skill_path_arg}",
            query='say "hi"',
            project_root="/tmp/project root",
            skill_path="/tmp/skill path",
            skill_name="demo-skill",
            model="glm-5.1",
            runner_mode="claude-stream",
        )

        self.assertEqual(
            command,
            "glm claude -p 'say \"hi\"' --model glm-5.1 --cwd '/tmp/project root' --skill '/tmp/skill path'",
        )

    def test_renders_documented_codex_style_template_with_quoted_prompt(self):
        query = 'explain hooks; echo hacked "quoted" $(touch /tmp/pwned)'
        command = runner.render_runner_command(
            template="codex exec --skip-git-repo-check --json --cd {project_root_arg}{model_arg} {eval_prompt_arg}",
            query=query,
            project_root="/tmp/project root",
            skill_path="/tmp/project root/skills/demo",
            skill_name="demo-skill",
            skill_description="Demo description",
            eval_skill_path="/tmp/project root/.skill-creator-eval-123/demo-skill",
            trigger_marker="/tmp/project root/.skill-creator-eval-123/demo-skill/SKILL.md",
            model="gpt-5.1",
            runner_mode="codex-json",
        )

        self.assertIn("codex exec --skip-git-repo-check --json --cd '/tmp/project root' -m gpt-5.1 '", command)
        self.assertIn("Candidate description:\nDemo description", command)
        self.assertIn("/tmp/project root/.skill-creator-eval-123/demo-skill/SKILL.md", command)
        self.assertIn("User request:\nexplain hooks; echo hacked \"quoted\" $(touch /tmp/pwned)", command)

    def test_renders_documented_opencode_style_template_with_quoted_prompt(self):
        query = "explain hooks && rm -rf /"
        command = runner.render_runner_command(
            template="opencode run --format json --dir {project_root_arg}{model_arg} {eval_prompt_arg}",
            query=query,
            project_root="/tmp/project root",
            skill_path="/tmp/project root/skills/demo",
            skill_name="demo-skill",
            skill_description="Demo description",
            eval_skill_path="/tmp/project root/.skill-creator-eval-123/demo-skill",
            trigger_marker="/tmp/project root/.skill-creator-eval-123/demo-skill/SKILL.md",
            model="gpt-5.1",
            runner_mode="opencode-json",
        )

        self.assertIn("opencode run --format json --dir '/tmp/project root' -m gpt-5.1 '", command)
        self.assertIn("Candidate description:\nDemo description", command)
        self.assertIn("If the skill is relevant, inspect its SKILL.md", command)
        self.assertIn("User request:\nexplain hooks && rm -rf /", command)

    def test_execute_text_generation_uses_configurable_runner(self):
        output = runner.execute_text_generation(
            prompt='rewrite "this" safely',
            model="gpt-5.1",
            runner_command="python3 -c 'import sys; print(\"<new_description>custom provider</new_description>\")' {prompt_arg}",
            runner_shell="zsh",
            runner_mode="codex-text",
            cwd="/tmp",
            timeout=5,
        )

        self.assertIn("custom provider", output)

    def test_execute_text_generation_uses_stdin_for_default_claude_text(self):
        long_prompt = "line with shell chars $(touch /tmp/nope) 'quoted'\n" * 1000
        completed = subprocess.CompletedProcess(
            args=["zsh", "-lc", "claude"],
            returncode=0,
            stdout="<new_description>ok</new_description>",
            stderr="",
        )

        with patch("subprocess.run", return_value=completed) as run_mock:
            output = runner.execute_text_generation(
                prompt=long_prompt,
                model="opus model",
                runner_shell="zsh",
                runner_mode="claude-text",
                cwd="/tmp",
                timeout=5,
            )

        self.assertIn("ok", output)
        called_command = run_mock.call_args.args[0][2]
        self.assertIn("claude -p --output-format text --model 'opus model'", called_command)
        self.assertNotIn(long_prompt, called_command)
        self.assertEqual(run_mock.call_args.kwargs["input"], long_prompt)

    def test_execute_text_generation_uses_stdin_for_glm_claude_text_command(self):
        prompt = "first line\nsecond line with `backticks` and $(shell)"
        completed = subprocess.CompletedProcess(
            args=["zsh", "-lc", "glm claude"],
            returncode=0,
            stdout="<new_description>glm ok</new_description>",
            stderr="",
        )

        with patch("subprocess.run", return_value=completed) as run_mock:
            output = runner.execute_text_generation(
                prompt=prompt,
                model="glm-5.1",
                runner_command="glm claude -p --output-format text{model_arg}",
                runner_shell="zsh",
                runner_mode="claude-text",
                cwd="/tmp",
                timeout=5,
            )

        self.assertIn("glm ok", output)
        called_command = run_mock.call_args.args[0][2]
        self.assertIn("glm claude -p --output-format text --model glm-5.1", called_command)
        self.assertNotIn(prompt, called_command)
        self.assertEqual(run_mock.call_args.kwargs["input"], prompt)

    def test_execute_text_generation_keeps_arg_based_codex_text_support(self):
        prompt = "rewrite with spaces and $(literal)"
        completed = subprocess.CompletedProcess(
            args=["zsh", "-lc", "codex"],
            returncode=0,
            stdout="<new_description>codex ok</new_description>",
            stderr="",
        )

        with patch("subprocess.run", return_value=completed) as run_mock:
            output = runner.execute_text_generation(
                prompt=prompt,
                model="gpt-5.1",
                runner_command="codex exec --skip-git-repo-check{model_arg} {query_arg}",
                runner_shell="zsh",
                runner_mode="codex-text",
                cwd="/tmp",
                timeout=5,
            )

        self.assertIn("codex ok", output)
        called_command = run_mock.call_args.args[0][2]
        self.assertIn("'rewrite with spaces and $(literal)'", called_command)
        self.assertIsNone(run_mock.call_args.kwargs.get("input"))

    def test_model_arg_placeholder_is_empty_when_model_missing(self):
        command = runner.render_runner_command(
            template="claude -p {query}{model_arg}",
            query="hello",
            project_root="/tmp/project",
            skill_path="/tmp/skill",
            skill_name="demo-skill",
            model=None,
        )

        self.assertEqual(command, "claude -p hello")


class RunnerModeCommandTests(unittest.TestCase):
    def test_builds_runner_specific_model_args(self):
        self.assertEqual(runner.build_model_arg("claude-stream", "opus model"), " --model 'opus model'")
        self.assertEqual(runner.build_model_arg("claude-text", "opus model"), " --model 'opus model'")
        self.assertEqual(runner.build_model_arg("codex-json", "gpt-5.1"), " -m gpt-5.1")
        self.assertEqual(runner.build_model_arg("codex-text", "gpt-5.1"), " -m gpt-5.1")
        self.assertEqual(runner.build_model_arg("opencode-json", "gpt-5.1"), " -m gpt-5.1")
        self.assertEqual(runner.build_model_arg("opencode-text", "gpt-5.1"), " -m gpt-5.1")

    def test_default_runner_commands_include_expected_output_formats(self):
        self.assertIn("--output-format stream-json", runner.default_runner_command("claude-stream"))
        self.assertIn("--output-format text", runner.default_runner_command("claude-text"))
        self.assertNotIn("{query_arg}", runner.default_runner_command("claude-text"))
        self.assertIn("--json", runner.default_runner_command("codex-json"))
        self.assertNotIn("--json", runner.default_runner_command("codex-text"))
        self.assertIn("--format json", runner.default_runner_command("opencode-json"))
        self.assertIn("--format text", runner.default_runner_command("opencode-text"))

    def test_rejects_unsupported_runner_mode(self):
        with self.assertRaises(ValueError):
            runner.default_runner_command("unknown-runner")


class RunnerExecutionTests(unittest.TestCase):
    def test_prepare_shell_command_sources_zshrc_for_zsh(self):
        prepared = runner.prepare_shell_command("glm claude -p 'hi'", "zsh")
        self.assertTrue(prepared.startswith("source ~/.zshrc >/dev/null 2>&1 || true; "))
        self.assertIn("glm claude -p 'hi'", prepared)

    def test_execute_shell_command_strips_claudecode_env(self):
        env = {"CLAUDECODE": "1", "KEEP_ME": "yes"}
        completed = subprocess.CompletedProcess(args=["zsh", "-lc", "printf hi"], returncode=0, stdout="hi", stderr="")

        with patch.dict(os.environ, env, clear=True), patch("subprocess.run", return_value=completed) as run_mock:
            output = runner.execute_shell_command(
                command="printf hi",
                runner_shell="zsh",
                cwd="/tmp/project",
                timeout=5,
            )

        self.assertEqual(output, "hi")
        called_command = run_mock.call_args.args[0][2]
        self.assertTrue(called_command.startswith("source ~/.zshrc >/dev/null 2>&1 || true; "))
        called_env = run_mock.call_args.kwargs["env"]
        self.assertNotIn("CLAUDECODE", called_env)
        self.assertEqual(called_env["KEEP_ME"], "yes")

    def test_execute_shell_command_can_pass_stdin(self):
        completed = subprocess.CompletedProcess(args=["zsh", "-lc", "cat"], returncode=0, stdout="hello", stderr="")

        with patch("subprocess.run", return_value=completed) as run_mock:
            output = runner.execute_shell_command(
                command="cat",
                runner_shell="zsh",
                cwd="/tmp/project",
                timeout=5,
                stdin="hello",
            )

        self.assertEqual(output, "hello")
        self.assertEqual(run_mock.call_args.kwargs["input"], "hello")

    def test_execute_shell_command_raises_on_timeout_with_partial_stdout(self):
        exc = subprocess.TimeoutExpired(cmd="slow", timeout=5, output="partial")

        with patch("subprocess.run", side_effect=exc):
            with self.assertRaisesRegex(runner.RunnerCommandError, "timed out") as raised:
                runner.execute_shell_command(
                    command="slow",
                    runner_shell="zsh",
                    cwd="/tmp/project",
                    timeout=5,
                )

        self.assertEqual(raised.exception.returncode, -1)
        self.assertEqual(raised.exception.stdout, "partial")
        self.assertIn("timed out after 5s", raised.exception.stderr)

    def test_execute_shell_command_raises_on_nonzero_exit(self):
        completed = subprocess.CompletedProcess(
            args=["zsh", "-lc", "bad"],
            returncode=2,
            stdout="partial output",
            stderr="fatal error",
        )

        with patch("subprocess.run", return_value=completed):
            with self.assertRaisesRegex(runner.RunnerCommandError, "exited 2") as raised:
                runner.execute_shell_command(
                    command="bad",
                    runner_shell="zsh",
                    cwd="/tmp/project",
                    timeout=5,
                )

        self.assertEqual(raised.exception.returncode, 2)
        self.assertEqual(raised.exception.stdout, "partial output")
        self.assertEqual(raised.exception.stderr, "fatal error")


if __name__ == "__main__":
    unittest.main()
