# Upstream limitations

The public Paseo CLI does not expose a push/event subscription for a parent when a
child reaches an idle, error, or disconnected terminal state. This service therefore
uses global `paseo ls -g --json` plus `paseo inspect --json` for visibility and a
bounded reconciliation loop for the missed-wakeup invariant.

Parent filtering is an N+1 operation: `ls -g --json` does not include
`ParentAgentId`, so every candidate requires an `inspect --json` call. The service
limits this fan-out to eight concurrent CLI processes and returns explicit
`failedCandidates`/`partial` metadata when a retry still fails. A candidate with a
different parent is a normal non-match, not an error.

Heartbeat registrations are observed through the Paseo daemon's direct schedule RPC
(`DaemonClient.scheduleList/Inspect/Logs`); the CLI remains reserved for mutations
such as heartbeat create/delete. This supersedes the earlier note that the daemon has
no `heartbeat ls`/`inspect` and that ids must be probed with `heartbeat update`.
Agent-scoped heartbeat schedules are not visible through the public CLI's
`schedule ls`/`schedule inspect` path; the companion therefore uses the direct
daemon schedule observer for registration and run observations. CLI list output
must not be treated as proof that an agent-scoped heartbeat is absent.
The companion persists run ids and cursors because the daemon does not push run events;
`last_fired_at` is therefore taken only from a run's `startedAt`/`scheduledFor`, never
from a cron-derived next-run value. A missing schedule is rebuilt only for an explicit
not-found response (and an existing deterministic name is adopted first); transient
CLI failures remain unknown and are not rebuilt. Labels are treated as visual
best-effort signals and the local append-only ledger is the authority for
park/known-red/deferred decisions.

## Observed gaps (2026-08-10, agent-server platformization round)

Two behaviours of the missed-wakeup invariant (`reconcileOnce`) produced repeated
false alarms during a deliberate Owner-ordered stop.

**1. The invariant ignored the park ledger.** — ✅ **addressed 2026-08-11.**
Its condition was `children.every(idle-ish) && selfWakeupSources.length === 0`,
which never consulted `type: 'park'` records even though `listChildren` already
computed a per-child `parked` flag from exactly that ledger. Three children
explicitly parked with `verdict`, `reason` and `recovery` still tripped the alarm
every ~5 minutes. A parked child is a recorded decision, not a forgotten one.
Per-child watches now treat an unrevoked park record as the *only* exemption.

**2. `selfWakeupSources` cannot enumerate externally-created heartbeats.** — ✅ **workaround shipped 2026-08-12.**
The public `paseo` CLI has no heartbeat enumerate/list command: `paseo heartbeat`
supports create/update/delete only, and agent-scoped heartbeats do not appear in
`paseo schedule ls --json`. Therefore the companion cannot infer that a heartbeat
created outside it exists from a global listing. It now exposes durable registration
endpoints (`PUT/GET/DELETE /wakeup-sources`) where a manager records the full agent id,
heartbeat id, and its `cadence` (for example `cron:*/30 * * * *`). Each registered
source is probed with `paseo heartbeat update <id> --cron '<cadence expression>' --json`;
only an explicit `status=active` response counts as live. Missing ids, daemon RPC
errors, and non-active responses are dead and do not suppress `manager-bare`.
The warning explicitly says coverage is limited to companion-created and registered
sources, because unregistered external sources may remain invisible. If upstream adds
heartbeat enumeration, registration and per-id update probes can be simplified to a
daemon-backed list/identity check, while retaining registration as an opt-in boundary
for manager ownership.

## Observed gap (2026-08-11, first live per-child watch)

**The delivered child-watch prompt does not say which child it is for.**
`ensureChildWatch` stores `subjectChildId` on the record, but the delivered text is the
generic "inspect the relevant child" message with `Structured context: {"watchKind":"child"}`.
The manager therefore has to enumerate every child anyway, which is most of what the
per-child watch was meant to avoid.

Suggested: include `subjectChildId` (and ideally the child's title) in the reminder
`context` so the delivery is self-describing. Note the watch prompt must stay
state-*independent* (no status snapshot baked in at creation time) — the child id is an
identity, not a state, so including it does not reintroduce staleness.

Also note: there is no `GET /reminders` route, so a fired reminder cannot be looked up by
id. `GET /heartbeats` is the only observability surface; it exposes ids, cron,
`last_fired_at`, `missed_fires` and `alive`, but not `subjectChildId`.

---

## 观察到的缺口 3 · `GET /heartbeats` 的 `alive` **无法被外部核实**（2026-08-11 实测）

`/heartbeats` 返回的 `alive` 是 companion 自己的台账信念。想验证它时会发现：

```sh
paseo schedule ls --json          # => []   ← 即使刚刚 POST /reminders 成功创建
paseo schedule inspect <id>       # => Schedule not found / DaemonRpcError
```

**agent-scoped heartbeat 不出现在 `paseo schedule ls / inspect` 里**（companion 走的是
直接 RPC，不是 CLI 那条路）。所以：

- ❌ 不能拿 `schedule ls` 空来推断"heartbeat 都没了" —— 我 2026-08-11 就这么误判过一次，
  差点据此把还活着的 watch 全删掉重建
- ⚠️ 目前**没有任何外部手段**能独立核实一条 heartbeat 是否真的还在 daemon 里排程

**这是个真缺口，不是使用姿势问题**：`expiresIn` 到期后 daemon 侧的排程会消失，
但 companion 台账里那条记录**不会自动翻成 `alive:false`**，而外部又没法交叉验证。
唯一的可观测信号是 `last_fired_at` / `missed_fires` 停止推进 —— 那是**事后**才看得出来的。

**上游要么**让 agent-scoped schedule 在 `schedule ls` 里可见（哪怕加个 `--all` / `--agent` 过滤），
**要么** companion 在 `listHeartbeats()` 时按 `expiresIn` 重算 `alive` 并对每条做一次真实存在性探测。

**顺带**：`DELETE /reminders/<id>` 对 4 条已过期的记录返回 500 `schedule_request_failed`
（inspect 找不到就整个失败），对使用者表现为"删不掉"。删一条已经不存在的排程应当是幂等成功。
