#!/usr/bin/env python3
"""Run trigger evaluation for a skill description.

Tests whether a skill's description causes the configured runner to trigger
(typically by reading the skill) for a set of queries. Outputs results as JSON.
"""

import argparse
import json
import shutil
import sys
import tempfile
import uuid
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.runner import build_model_arg
from scripts.runner import default_runner_command
from scripts.runner import execute_shell_command
from scripts.runner import render_runner_command
from scripts.utils import parse_skill_md


def _candidate_skill_content(skill_name: str, skill_description: str, original_content: str = "") -> str:
    """Build a temporary SKILL.md with the candidate description under test."""
    indented_desc = "\n  ".join(skill_description.split("\n"))
    body = ""
    if original_content:
        parts = original_content.split("---", 2)
        if len(parts) == 3:
            body = parts[2].lstrip("\n")
    if not body:
        body = f"# {skill_name}\n\nThis skill handles: {skill_description}\n"
    return f"---\nname: {skill_name}\ndescription: |\n  {indented_desc}\n---\n\n{body}"


def create_candidate_skill_snapshot(
    skill_path: str,
    skill_name: str,
    skill_description: str,
    project_root: str,
) -> tempfile.TemporaryDirectory:
    """Create a temporary skill directory whose SKILL.md contains the candidate description."""
    temp_dir = tempfile.TemporaryDirectory(prefix=".skill-creator-eval-", dir=project_root)
    source = Path(skill_path)
    snapshot = Path(temp_dir.name) / skill_name
    snapshot.mkdir(parents=True, exist_ok=True)
    original_content = ""
    source_skill_md = source / "SKILL.md"
    if source_skill_md.exists():
        original_content = source_skill_md.read_text()
        for item in source.iterdir():
            if item.name == "SKILL.md":
                continue
            destination = snapshot / item.name
            if item.is_dir():
                shutil.copytree(item, destination)
            elif item.is_file():
                shutil.copy2(item, destination)
    (snapshot / "SKILL.md").write_text(
        _candidate_skill_content(skill_name, skill_description, original_content)
    )
    return temp_dir


def find_project_root() -> Path:
    """Find the project root by walking up from cwd looking for .claude/.

    Mimics how Claude Code discovers its project root, so the command file
    we create ends up where claude -p will look for it.
    """
    current = Path.cwd()
    for parent in [current, *current.parents]:
        if (parent / ".claude").is_dir():
            return parent
    return current


def _iter_json_lines(output: str) -> list[dict]:
    events: list[dict] = []
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def _json_contains_marker(value: object, marker: str) -> bool:
    if isinstance(value, str):
        return marker in value
    if isinstance(value, dict):
        return any(_json_contains_marker(v, marker) for v in value.values())
    if isinstance(value, list):
        return any(_json_contains_marker(v, marker) for v in value)
    return False


def _detect_claude_stream_trigger(output: str, trigger_marker: str) -> bool:
    """Detect Claude skill triggering from stream-json output."""
    pending_tool_name = None
    accumulated_json = ""
    triggered = False

    for event in _iter_json_lines(output):
        if event.get("type") == "stream_event":
            se = event.get("event", {})
            se_type = se.get("type", "")

            if se_type == "content_block_start":
                cb = se.get("content_block", {})
                if cb.get("type") == "tool_use":
                    tool_name = cb.get("name", "")
                    if tool_name in ("Skill", "Read"):
                        pending_tool_name = tool_name
                        accumulated_json = ""
                    else:
                        pending_tool_name = None
                        accumulated_json = ""

            elif se_type == "content_block_delta" and pending_tool_name:
                delta = se.get("delta", {})
                if delta.get("type") == "input_json_delta":
                    accumulated_json += delta.get("partial_json", "")
                    if trigger_marker in accumulated_json:
                        return True

            elif se_type in ("content_block_stop", "message_stop"):
                if pending_tool_name and trigger_marker in accumulated_json:
                    return True
                pending_tool_name = None
                accumulated_json = ""

        elif event.get("type") == "assistant":
            message = event.get("message", {})
            for content_item in message.get("content", []):
                if content_item.get("type") != "tool_use":
                    continue
                tool_name = content_item.get("name", "")
                tool_input = content_item.get("input", {})
                if tool_name == "Skill" and trigger_marker in tool_input.get("skill", ""):
                    triggered = True
                elif tool_name == "Read" and trigger_marker in tool_input.get("file_path", ""):
                    triggered = True
        elif event.get("type") == "result":
            return triggered

    return triggered


def _detect_codex_json_trigger(output: str, trigger_marker: str) -> bool:
    """Detect trigger evidence from Codex JSON events."""
    for event in _iter_json_lines(output):
        item = event.get("item")
        if not isinstance(item, dict):
            continue
        if item.get("type") not in {"command_execution", "function_call"}:
            continue
        if _json_contains_marker(item, trigger_marker):
            return True
    return False


def _detect_opencode_json_trigger(output: str, trigger_marker: str) -> bool:
    """Detect trigger evidence from OpenCode JSON events."""
    for event in _iter_json_lines(output):
        if event.get("type") != "tool_use":
            continue
        part = event.get("part", {})
        if not isinstance(part, dict):
            continue
        if part.get("type") != "tool":
            continue
        if _json_contains_marker(part, trigger_marker):
            return True
    return False


def detect_trigger(output: str, runner_mode: str, trigger_marker: str) -> bool:
    """Dispatch trigger detection by runner mode."""
    if runner_mode == "claude-stream":
        return _detect_claude_stream_trigger(output, trigger_marker)
    if runner_mode == "codex-json":
        return _detect_codex_json_trigger(output, trigger_marker)
    if runner_mode == "opencode-json":
        return _detect_opencode_json_trigger(output, trigger_marker)
    raise ValueError(f"Unsupported runner mode: {runner_mode}")


def run_single_query(
    query: str,
    skill_name: str,
    skill_path: str,
    skill_description: str,
    timeout: int,
    project_root: str,
    model: str | None = None,
    runner_command: str | None = None,
    runner_shell: str = "zsh",
    runner_mode: str = "claude-stream",
) -> bool:
    """Run a single query and return whether the skill was triggered.

    For Claude-mode runners, create a command file in .claude/commands/ so it
    appears in Claude's available_skills list. For other runners, the caller is
    responsible for making the skill available in the invoked environment.
    """
    unique_id = uuid.uuid4().hex[:8]
    clean_name = f"{skill_name}-skill-{unique_id}"
    project_commands_dir = Path(project_root) / ".claude" / "commands"
    command_file = project_commands_dir / f"{clean_name}.md"
    candidate_snapshot = None
    eval_skill_path = skill_path
    trigger_marker = clean_name if runner_mode == "claude-stream" else ""

    try:
        if runner_mode == "claude-stream":
            project_commands_dir.mkdir(parents=True, exist_ok=True)
            # Use YAML block scalar to avoid breaking on quotes in description.
            indented_desc = "\n  ".join(skill_description.split("\n"))
            command_content = (
                f"---\n"
                f"description: |\n"
                f"  {indented_desc}\n"
                f"---\n\n"
                f"# {skill_name}\n\n"
                f"This skill handles: {skill_description}\n"
            )
            command_file.write_text(command_content)
        else:
            candidate_snapshot = create_candidate_skill_snapshot(
                skill_path=skill_path,
                skill_name=skill_name,
                skill_description=skill_description,
                project_root=project_root,
            )
            eval_skill_path = str(Path(candidate_snapshot.name) / skill_name)
            trigger_marker = str(Path(eval_skill_path) / "SKILL.md")

        command_template = runner_command or default_runner_command(runner_mode)
        command = render_runner_command(
            template=command_template,
            query=query,
            project_root=project_root,
            skill_path=skill_path,
            skill_name=skill_name,
            model=model,
            runner_mode=runner_mode,
            command_file=str(command_file),
            trigger_marker=trigger_marker,
            skill_description=skill_description,
            eval_skill_path=eval_skill_path,
        )

        output = execute_shell_command(
            command=command,
            runner_shell=runner_shell,
            cwd=project_root,
            timeout=timeout,
        )

        return detect_trigger(
            output=output,
            runner_mode=runner_mode,
            trigger_marker=trigger_marker,
        )
    finally:
        if command_file.exists():
            command_file.unlink()
        if candidate_snapshot is not None:
            candidate_snapshot.cleanup()


def run_eval(
    eval_set: list[dict],
    skill_name: str,
    skill_path: Path,
    description: str,
    num_workers: int,
    timeout: int,
    project_root: Path,
    runs_per_query: int = 1,
    trigger_threshold: float = 0.5,
    model: str | None = None,
    runner_command: str | None = None,
    runner_shell: str = "zsh",
    runner_mode: str = "claude-stream",
) -> dict:
    """Run the full eval set and return results."""
    results = []

    with ProcessPoolExecutor(max_workers=num_workers) as executor:
        future_to_info = {}
        for item in eval_set:
            for run_idx in range(runs_per_query):
                future = executor.submit(
                    run_single_query,
                    item["query"],
                    skill_name,
                    str(skill_path),
                    description,
                    timeout,
                    str(project_root),
                    model,
                    runner_command,
                    runner_shell,
                    runner_mode,
                )
                future_to_info[future] = (item, run_idx)

        query_triggers: dict[str, list[bool]] = {}
        query_errors: dict[str, list[str]] = {}
        query_items: dict[str, dict] = {}
        for future in as_completed(future_to_info):
            item, _ = future_to_info[future]
            query = item["query"]
            query_items[query] = item
            if query not in query_triggers:
                query_triggers[query] = []
            try:
                query_triggers[query].append(future.result())
            except Exception as e:
                print(f"Warning: query failed: {e}", file=sys.stderr)
                query_triggers[query].append(False)
                query_errors.setdefault(query, []).append(str(e))

    for query, triggers in query_triggers.items():
        item = query_items[query]
        trigger_rate = sum(triggers) / len(triggers)
        should_trigger = item["should_trigger"]
        if should_trigger:
            did_pass = trigger_rate >= trigger_threshold
        else:
            did_pass = trigger_rate < trigger_threshold
        query_runner_errors = query_errors.get(query, [])
        if query_runner_errors:
            did_pass = False
        results.append({
            "query": query,
            "should_trigger": should_trigger,
            "trigger_rate": trigger_rate,
            "triggers": sum(triggers),
            "runs": len(triggers),
            "runner_errors": len(query_runner_errors),
            "errors": query_runner_errors,
            "pass": did_pass,
        })

    passed = sum(1 for r in results if r["pass"])
    total = len(results)
    runner_errors = sum(r["runner_errors"] for r in results)

    return {
        "skill_name": skill_name,
        "description": description,
        "results": results,
        "summary": {
            "total": total,
            "passed": passed,
            "failed": total - passed,
            "runner_errors": runner_errors,
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Run trigger evaluation for a skill description")
    parser.add_argument("--eval-set", required=True, help="Path to eval set JSON file")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--description", default=None, help="Override description to test")
    parser.add_argument("--num-workers", type=int, default=10, help="Number of parallel workers")
    parser.add_argument("--timeout", type=int, default=30, help="Timeout per query in seconds")
    parser.add_argument("--runs-per-query", type=int, default=3, help="Number of runs per query")
    parser.add_argument("--trigger-threshold", type=float, default=0.5, help="Trigger rate threshold")
    parser.add_argument("--model", default=None, help="Model to use for the configured runner (default: runner default)")
    parser.add_argument("--runner-command", default=None, help="Shell command template used to run each eval query")
    parser.add_argument("--runner-shell", default="zsh", help="Shell used to execute --runner-command")
    parser.add_argument(
        "--runner-mode",
        choices=["claude-stream", "codex-json", "opencode-json"],
        default="claude-stream",
        help="Output parser / trigger detector to use for the runner",
    )
    parser.add_argument("--verbose", action="store_true", help="Print progress to stderr")
    args = parser.parse_args()

    eval_set = json.loads(Path(args.eval_set).read_text())
    skill_path = Path(args.skill_path)

    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    name, original_description, content = parse_skill_md(skill_path)
    description = args.description or original_description
    project_root = find_project_root()

    if args.verbose:
        print(f"Evaluating: {description}", file=sys.stderr)

    output = run_eval(
        eval_set=eval_set,
        skill_name=name,
        skill_path=skill_path,
        description=description,
        num_workers=args.num_workers,
        timeout=args.timeout,
        project_root=project_root,
        runs_per_query=args.runs_per_query,
        trigger_threshold=args.trigger_threshold,
        model=args.model,
        runner_command=args.runner_command,
        runner_shell=args.runner_shell,
        runner_mode=args.runner_mode,
    )

    if args.verbose:
        summary = output["summary"]
        print(f"Results: {summary['passed']}/{summary['total']} passed", file=sys.stderr)
        for r in output["results"]:
            status = "PASS" if r["pass"] else "FAIL"
            rate_str = f"{r['triggers']}/{r['runs']}"
            print(f"  [{status}] rate={rate_str} expected={r['should_trigger']}: {r['query'][:70]}", file=sys.stderr)

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
