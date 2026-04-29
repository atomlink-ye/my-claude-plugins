# Thin Forwarding Workflow

Use the companion as an execution surface, not as an excuse to invent summaries.

1. Claude scopes the work: task, files, output contract, checks, and blocked behavior.
2. Invoke `opencode-companion.mjs` with quoted paths and prompt text after `--`.
3. Forward companion output verbatim when the user asked for runtime output.
4. Record session id, job id, working directory, server directory, and timeout/background mode.
5. Inspect artifacts directly before claiming success.

## Prompt shape

Good prompts include:

- exact task and non-goals
- file scope
- required validation
- output contract
- instruction to stop and report if blocked

Avoid vague prompts like "improve this" or "figure it out".

## Reporting rule

If output is ambiguous, say it is ambiguous. Never convert a timeout, partial background log, or progress-only stream into success without verification.
