# Paseo Manager Companion

Small local HTTP service that keeps Manager-side Paseo reminders, child visibility,
compact recovery, briefings, and decision ledger in one place. It only invokes the
public `paseo` CLI; daemon state remains authoritative.

```sh
pnpm install
pnpm build
PASEO_AGENT_ID=<manager-id> PORT=8787 node dist/server.js
```

Routes:

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/health` | — | uptime and reconciliation status |
| GET | `/children?agentId=` | — | `{children, selfWakeupSources, partial, failedCandidates}`; inspect failures are explicit |
| POST | `/spawn` | provider, model?, title, cwd, prompt, label? | spawned agent |
| POST | `/reminders` | agentId, delaySeconds, message, context? | durable at-least-once reminder |
| DELETE | `/reminders/:id` | `{reason}` | deletes daemon heartbeat and records acknowledgement |
| POST | `/compact-wake` | agentId, resumeSteps | recovery heartbeat (observation is bounded) |
| GET | `/children/:id/briefing` | `since` optional | git commits/status/diff stat |
| POST | `/ledger` | type, target, verdict, reason, recovery? | park/known-red/deferred record |
| GET | `/ledger` | type?, target? | active records |
| POST | `/ledger/:id/revoke` | `{reason}` | append-only resolution |

`POST /ledger` and `DELETE /reminders/:id` reject missing reasons (and ledger
verdicts) with HTTP 400. Reminder prompts contain a ready-to-paste acknowledgement
command and a 30-minute expiry; the service never creates one-shot (`max-runs 1`)
heartbeats.

Children inspection is bounded to eight Paseo CLI processes at a time. An inspect is
retried once; if it still fails, the response sets `partial: true` and reports the
candidate id, error, and category in `failedCandidates` rather than silently dropping
it. Candidates with a different `ParentAgentId` are intentionally omitted and are not
reported as failures.

For a local smoke test against the real Paseo daemon, set `PASEO_AGENT_ID` and run
`scripts/smoke.sh`. The script accepts `PASEO_PROVIDER`, `PASEO_MODEL`, and
`PASEO_CWD` overrides.
