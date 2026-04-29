# Daytona State and Secrets

## Global state, project-scoped

Daytona state is stored under the user's home directory, similar to the OpenCode companion's global serve state, but it is **keyed by project directory** so different projects do not overwrite one another:

```text
~/.daytona/claude-code/projects/<project-directory-hash>.json
```

Each state file may contain:

- `projectDirectory` — absolute local project path used as the key source
- `taskId` — sanitized task/project id used in remote paths
- `sandboxId` — Daytona sandbox identifier
- `remoteWorkspacePath` — remote workspace path for uploads/exec
- `remoteArtifactsPath` — remote artifact path for exec/pull
- `createdAt` / `updatedAt` timestamps

This state does not include API tokens or env-file contents, so global storage is acceptable. Local output artifacts remain project-local under `$WORK_DIR/artifacts/daytona/<task-id>`.

Do not store sandbox state in `${CLAUDE_PLUGIN_ROOT}`, project `.daytona/` directories for new runs, removed plugin directories, or `skills/daytona-companion`.

For compatibility, the manager may read legacy `$WORK_DIR/.daytona/state.json` if no global state exists, but new writes go to the global project registry.

## Environment files

`--env-file` may load an explicit env file. Without `--env-file`, the manager resolves env in this order:

1. project-local `.env.local`
2. global `~/.daytona/ENV`

`DAYTONA_API_TOKEN` is accepted and mapped to `DAYTONA_API_KEY` for SDK use when `DAYTONA_API_KEY` is not already set.

## Secret handling

- Never print raw token values.
- Redact secret-like state in status output.
- Unit tests must not make real Daytona network calls.
- Do not include `.env.local` contents in prompts, logs, or summaries.
