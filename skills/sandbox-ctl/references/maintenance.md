# Maintenance and safety

The CLI exposes only read-only audit checks: `sandbox-ctl list --json` and
`sandbox-ctl doctor --json`. Host checks are manual and exact-path only:

```sh
df -h /
du -sh -- /exact/project/path /exact/artifact/path
docker system df
du -sh -- /exact/otel/log/path
```

An SSH endpoint, Daytona CLI endpoint, and identity must be supplied and verified by the operator; this skill never guesses them. `sandbox-ctl` does not wrap snapshot inventory. Inspect snapshots only with an approved Daytona CLI/API endpoint and matching identity.

Any cleanup proposal is two-phase: first audit exact IDs and paths, then obtain
human review before applying those exact targets. This is a maintenance
principle, not an implemented bulk command. There is no `--all`, broad Docker
prune, online registry GC, recursive host deletion, or background cleanup.
Normal lifecycle commands never perform host cleanup.
