# Upstream Paseo limitations that shape this runtime

Observed against the public `paseo` CLI and daemon. Each entry is a constraint
ARCP works around today. The wider CLI-level research record is the repository
root `UPSTREAM.md`; read the two together.

## No push when a child reaches a terminal state

The public CLI exposes no push or event subscription telling a parent that a
child has become idle, errored or disconnected. ARCP therefore observes through
`paseo ls -g --json` plus `paseo inspect --json` and a bounded reconciliation
loop, and treats a launch timeout or an absent handle as
`transport_indeterminate` rather than as failure.

## Parent filtering is an N+1 operation

`paseo ls -g --json` does not include `ParentAgentId`, so establishing the child
set requires one `inspect --json` per candidate. ARCP bounds that fan-out to
eight concurrent CLI processes and reports explicit `partial` and
`failedCandidates` metadata when a retry still fails. A candidate with a
different parent is a normal non-match, not an error.

## Two public transports, only one of which is visible in the transcript

`paseo send --no-wait` reaches a running recipient and appears as a complete
prompt turn in `paseo logs`. Content delivered by a daemon-side schedule does
not appear there at all. Delivery acceptance is therefore read from durable ARCP
Delivery and ChannelEvent state, never from a transcript, and acceptance means
daemon receipt rather than proof that the recipient processed the prompt.

## Provider-owned subagents are best effort

Provider subagent listing comes from a direct daemon RPC and can be unavailable.
ARCP labels each child observation `provider_subagents`, `paseo_parent`, `none`
or `unavailable`; unavailable provider internals never block work.
