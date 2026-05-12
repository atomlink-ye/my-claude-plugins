"""Shared runner command helpers for skill-creator scripts."""

from __future__ import annotations

import os
import shlex
import subprocess
from pathlib import Path


class RunnerCommandError(RuntimeError):
    """Raised when a runner subprocess exits unsuccessfully."""

    def __init__(self, command: str, returncode: int, stdout: str, stderr: str):
        self.command = command
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        super().__init__(
            f"Runner command exited {returncode}: {command}\n"
            f"stdout: {stdout}\n"
            f"stderr: {stderr}"
        )

    def __reduce__(self):
        return (self.__class__, (self.command, self.returncode, self.stdout, self.stderr))


def build_model_arg(runner_mode: str, model: str | None) -> str:
    """Build the provider-appropriate model flag fragment for a runner."""
    if not model:
        return ""
    quoted_model = shlex.quote(model)
    if runner_mode in {"claude-stream", "claude-text"}:
        return f" --model {quoted_model}"
    if runner_mode in {"codex-json", "codex-text", "opencode-json", "opencode-text"}:
        return f" -m {quoted_model}"
    raise ValueError(f"Unsupported runner mode: {runner_mode}")


def default_runner_command(runner_mode: str) -> str:
    """Return the default shell command template for a runner mode."""
    if runner_mode == "claude-stream":
        return "claude -p {query_arg} --output-format stream-json --verbose --include-partial-messages{model_arg}"
    if runner_mode == "claude-text":
        return "claude -p --output-format text{model_arg}"
    if runner_mode == "codex-json":
        return "codex exec --skip-git-repo-check --json{model_arg} {eval_prompt_arg}"
    if runner_mode == "codex-text":
        return "codex exec --skip-git-repo-check{model_arg} {query_arg}"
    if runner_mode == "opencode-json":
        return "opencode run --format json --dir {project_root_arg}{model_arg} {eval_prompt_arg}"
    if runner_mode == "opencode-text":
        return "opencode run --format text --dir {project_root_arg}{model_arg} {query_arg}"
    raise ValueError(f"Unsupported runner mode: {runner_mode}")


def render_runner_command(
    template: str,
    query: str,
    project_root: str,
    skill_path: str,
    skill_name: str,
    model: str | None,
    runner_mode: str = "claude-stream",
    command_file: str = "",
    trigger_marker: str = "",
    skill_description: str = "",
    eval_skill_path: str = "",
) -> str:
    """Render a shell command template.

    Plain placeholders (for example ``{query}``) are inserted as raw text for
    use inside an already quoted prompt. ``*_arg`` placeholders are shell-quoted
    for use as standalone shell arguments.
    """
    prompt = f"Use the skill at {skill_path} to answer: {query}"
    eval_skill_md = trigger_marker or (str(Path(eval_skill_path) / "SKILL.md") if eval_skill_path else "")
    eval_prompt = (
        "You are evaluating whether a candidate skill should be consulted for a user request.\n\n"
        f"Candidate skill name:\n{skill_name}\n\n"
        f"Candidate description:\n{skill_description}\n\n"
        f"Candidate SKILL.md path:\n{eval_skill_md}\n\n"
        f"User request:\n{query}\n\n"
        "If the skill is relevant, inspect its SKILL.md at the candidate path. "
        "If it is not relevant, answer without reading that file."
    )
    substitutions = {
        "query": query,
        "prompt": prompt,
        "eval_prompt": eval_prompt,
        "project_root": project_root,
        "skill_path": skill_path,
        "eval_skill_path": eval_skill_path or skill_path,
        "eval_skill_md": eval_skill_md,
        "skill_name": skill_name,
        "model": model or "",
        "query_arg": shlex.quote(query),
        "prompt_arg": shlex.quote(prompt),
        "eval_prompt_arg": shlex.quote(eval_prompt),
        "project_root_arg": shlex.quote(project_root),
        "skill_path_arg": shlex.quote(skill_path),
        "eval_skill_path_arg": shlex.quote(eval_skill_path or skill_path),
        "eval_skill_md_arg": shlex.quote(eval_skill_md),
        "skill_name_arg": shlex.quote(skill_name),
        "model_arg_value": shlex.quote(model) if model else "",
        "model_arg": build_model_arg(runner_mode, model),
        "command_file": command_file,
        "command_file_arg": shlex.quote(command_file) if command_file else "",
        "trigger_marker": trigger_marker,
        "trigger_marker_arg": shlex.quote(trigger_marker) if trigger_marker else "",
    }
    return template.format(**substitutions)


def runner_subprocess_env() -> dict[str, str]:
    """Return an environment suitable for nested non-interactive runner calls."""
    return {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}


def prepare_shell_command(command: str, runner_shell: str) -> str:
    """Wrap commands so shell-local functions and aliases are available when possible."""
    shell_name = Path(runner_shell).name
    if shell_name == "zsh":
        return f"source ~/.zshrc >/dev/null 2>&1 || true; {command}"
    if shell_name == "bash":
        return f"source ~/.bashrc >/dev/null 2>&1 || true; {command}"
    return command


def _decode_output(output: str | bytes | None) -> str:
    if output is None:
        return ""
    if isinstance(output, bytes):
        return output.decode(errors="replace")
    return output


def execute_shell_command(
    command: str,
    runner_shell: str,
    cwd: str | Path,
    timeout: int,
    stdin: str | None = None,
) -> str:
    """Execute a rendered shell command and return stdout.

    Non-zero exits and timeouts are treated as runner failures so eval callers
    cannot accidentally count transport/runtime failures as clean misses.
    """
    prepared_command = prepare_shell_command(command, runner_shell)
    try:
        result = subprocess.run(
            [runner_shell, "-lc", prepared_command],
            input=stdin,
            capture_output=True,
            text=True,
            cwd=cwd,
            env=runner_subprocess_env(),
            timeout=timeout,
        )
        if result.returncode != 0:
            raise RunnerCommandError(
                command=command,
                returncode=result.returncode,
                stdout=result.stdout,
                stderr=result.stderr,
            )
        return result.stdout
    except subprocess.TimeoutExpired as exc:
        raise RunnerCommandError(
            command=command,
            returncode=-1,
            stdout=_decode_output(exc.stdout or exc.output),
            stderr=f"Runner command timed out after {timeout}s",
        ) from exc


def execute_text_generation(
    prompt: str,
    model: str | None,
    runner_command: str | None = None,
    runner_shell: str = "zsh",
    runner_mode: str = "claude-text",
    cwd: str | Path | None = None,
    timeout: int = 300,
) -> str:
    """Execute a configurable text-generation runner and return stdout."""
    command_template = runner_command or default_runner_command(runner_mode)
    prompt_in_command = any(
        placeholder in command_template
        for placeholder in ("{query}", "{query_arg}", "{prompt}", "{prompt_arg}")
    )
    command = render_runner_command(
        template=command_template,
        query=prompt,
        project_root=str(cwd or Path.cwd()),
        skill_path="",
        skill_name="",
        model=model,
        runner_mode=runner_mode,
    )
    stdin = None if prompt_in_command else prompt
    return execute_shell_command(
        command=command,
        runner_shell=runner_shell,
        cwd=cwd or Path.cwd(),
        timeout=timeout,
        stdin=stdin,
    )
