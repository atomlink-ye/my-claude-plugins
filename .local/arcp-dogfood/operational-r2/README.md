# ARCP operational dogfood r2 (redacted)

Date: 2026-09-01. All commands below used `skills/agent-runtime-control-panel/scripts/arcp` against an isolated loopback server with temporary state. The server, client state, and local credentials were removed after the run; credentials and provider handles are not recorded here.

## CLI launch and elevation receipts

`arcp doctor` found live Claude `auto`, Claude `bypassPermissions`, Codex `full-access`, and Pi/Grok. The installed Codex provider advertised `Default Permissions`, `Auto-review`, and `Full Access`, but not the canonical `auto` ID. Therefore:

- `arcp preflight --profile claude-manager` returned `action: launch`, requested/effective `{provider: claude, model: claude-opus-5, mode: auto, thinking: medium}`.
- `arcp start --profile claude-manager ...` launched a disposable Claude runtime and postflight observed the same requested provider/model/mode/thinking. It reached `idle`.
- `arcp start --profile codex-worker ...` returned an honest `action: hold` with requested `mode: auto`; it did not create a runtime or substitute `Auto-review`/`full-access`.
- `arcp preflight --provider claude --model claude-opus-5 --mode plan --thinking medium --unattended` returned `action: hold` and the exact live-mode command `arcp start --profile claude-bypass-permissions --title '<goal>' --unattended`.
- `arcp start --profile codex-full-access ...` was the explicit disposable elevation. Postflight observed `full-access`, with no mismatch.

## Panorama observations

`arcp panorama --refresh` and `arcp runtime status … --refresh` showed the ControlWorkspace Goal/Task/Member roster, the two managed runtime projections, latest commit SHA/subject/time, `dirty: true`, a numeric path-free diffstat, and empty/redacted legacy aggregates.

The Claude idle runtime reported observed context usage `32817/1000000` (`ratio: 0.032817`, `quality: observed`). The Codex idle runtime reported observed context usage `22985/828400` (`ratio: 0.027746…`, `quality: observed`). Both had zero pending permissions and no managed children. The provider timeline exposed zero compactions, so the projection truthfully reported `compaction: {count: 0, status: none}`; no context was deliberately inflated to manufacture one.

No raw provider handle, cwd, diff filename, prompt, legacy reminder/message body, correction finding, or credential appears in this record.

## Independent CLI-only review

An independent reviewer used only the ARCP CLI and created an isolated review workspace. It recorded Knowledge `knowledge_f29aa…` and Result `result_3fbbad…` after claiming its fenced task. Its useful friction findings were: issued Actor/Member credentials are printed to stdout, the first-time owner member has no immediately reusable Member credential, and the held Codex `auto` default had no next-step recommendation when the installed provider did not offer that exact mode. The final preflight change addresses the last point by suggesting the explicitly selected, live `codex-full-access` profile; the credential-display issue remains an observed limitation. It could inspect doctor/preflight/panorama, but its independent workspace had no managed session, so `runtime status` was not exercised there.

## Compatibility and cleanup

The focused ARCP test suite and full paseo-reminder compatibility suite ran from the runtime package and passed (84 tests total). This covers the original reminder/watch/message/correction behavior; correction ACCEPT remains a compatibility resolution and was not treated as Goal completion.

The two disposable provider Agents were stopped and archived. The isolated ARCP server was stopped. Its temporary data, client state, log and credentials were removed. The independent CLI-only reviewer report is recorded below once submitted through ARCP Knowledge/Result.
