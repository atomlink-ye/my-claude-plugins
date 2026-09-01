# Upstream limitations

## R9 delivery design

Child-watch records are durable local-poll subscriptions with stable ids and no
daemon heartbeat. The existing 180-second reconciliation pass is the poller;
legacy child-watch daemons are retired best-effort and never rebuilt. Watchdog
messages are emitted only for concrete transitions/anomalies (completion,
wait-loss, no-wakeup, or stale state) and include the current snapshot facts.
The unified rule is: **if the alert does not already contain what is wrong and
what the recipient must check to determine whether it is actually wrong, send
nothing.**

统一判据原话：**报警内容必须已经包含哪里不对，需要收件人去查才知道对不对的一条不发。**

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

---

## Observed gap 4 · heartbeat delivery is idle-only but transcript-invisible (2026-08-12)

Empirical testing established two distinct public transports. `paseo send
--no-wait` reaches a running recipient and appears as a complete prompt turn in
`paseo logs`; paseo-reminder uses it for `delivery:"interrupt"`. A repeating
heartbeat skips ticks while the recipient is busy and runs on a later tick after
idle; paseo-reminder uses it for default `delivery:"on-idle"`.

Heartbeat prompt content is not rendered in `paseo logs`. Its `lastRunAt`, read
through `heartbeat update <id> --cron <unchanged>`, is therefore the only public
delivery evidence. The companion records that timestamp in its message/reminder
audit and retires the repeating heartbeat after confirmation. Busy skipped ticks
leave `lastRunAt` empty and must not be treated as delivery or failure.

The public CLI surface was checked through `paseo --help` and the help for
`send`, `chat post/read/wait`, `agent update`, `inspect`, `logs`, `schedule`,
`heartbeat`, and `hooks`. No passive/background notification primitive is
exposed. Chat persists messages in a separate room, but the recipient must
explicitly run `chat read` or `chat wait`; posting does not surface content in
an agent session. Agent metadata supports only name/labels and likewise requires
explicit `inspect` polling. Hooks record activity, schedules/heartbeats execute
prompts, and logs/inspect are observation-only. There is still no passive channel
that is both transcript-visible and non-interrupting; heartbeat is the accepted
idle-only transport with the audit limitation above.

## Self-compact is not atomic with respect to reminder delivery

**Observed 2026-08-14, twice in one session, on a Manager agent running an all-night lane round.**

The Manager registers a `compact-wake`, then sends itself `/compact`. Between the decision to
compact and the compaction actually completing, **any reminder / message / watchdog delivery
interrupts the turn and cancels the compaction**. The agent stays uncompacted, keeps growing,
and the registered `compact-wake` fires against an agent that never compacted.

Failure shape:

```
1. context crosses threshold  → register compact-wake  → send /compact
2. a queued notify/reminder is delivered mid-turn
3. compaction is canceled; the agent resumes normal work
4. compact-wake later fires "compact-recovery" for a compaction that never happened
```

Two aggravating factors observed in the same session:

- **`notify`-mode messages stick in `pending` with `deliveredAt=null` and are re-delivered
  repeatedly** (see the delivery-accounting note above). A busy Manager therefore has a
  *continuous* stream of interrupts, so the window in which a self-compact can complete
  is effectively never open.
- The busier the agent (which is exactly when it needs to compact), the higher the
  interrupt rate — **the mechanism fails hardest under the condition it exists for**.

### What the recipient cannot do about it today

Nothing reliable. Retrying `/compact` only re-enters the same race. Draining the queue first
does not help, because new deliveries arrive during the compaction itself.

### Wanted from upstream

Any one of these would close it:

1. **A quiet window**: allow an agent to request "hold all non-`interrupt` deliveries for N seconds",
   so a self-compact can complete. `interrupt`-delivery messages would still get through.
2. **Delivery deferral during compaction**: the coordinator observes the target is compacting and
   queues everything (it already tracks agent status).
3. **A compaction-completed signal** the coordinator can key on, so `compact-wake` fires only after
   a compaction *actually* happened, instead of on an idle/debounce heuristic.

Until then the practical fallback is: **do not rely on self-compact under load; let the harness
auto-compact, and make sure `compact-wake` resumeSteps are fully stateless** so that recovery
works regardless of whether the compaction was self-initiated or automatic.

## ~~`DELETE /messages/:id` 不是"已读销账"~~ —— **本条已自我更正，原判断是错的**

2026-08-14 我先记了一条"DELETE 只是退订、上游没有 ack 动词"，**那是错的，是我用法不对**。

**正确用法（companion 自己在投递块的 `<ack>` 里给出）**：
```sh
arcp message ack <id> --reason processed
```
⚠️ **要带 `--reason processed`。** 我之前写的是 `DELETE /messages/<id>?agentId=<self>`
（query 参数、无 body）—— 返回成功但**没有销账**，消息随后被原样重投。

⇒ **重复投递不是上游缺陷，是我没正确 ack 的后果。** 上游行为正确。

**留下的真教训**：`<ack>` 块里已经写好了该跑的命令，**照抄即可，不要自己拼 DELETE 的参数形式**。

---

## 🔴 `POST /messages` 向不存在的 `agentId` 发送时不报错（这条成立，且更严重）

照常返回 200、照常 `delivery.status:"accepted"`，消息就此消失在空地址里。

2026-08-14 实例：我把一个 Codex Manager 的 id 记成了前 8 位相同、后半段不同的 UUID，
两条关键裁定全部发进空地址，**对方在 20 分钟里一直是"以为自己交付完成"的 idle 状态，
而我以为已经止血并据此向 Owner 汇报了。**

**真判据（响应里一直有）**：`"status":"delivered"` + `deliveredAt` 非空。
❌ **不要看 `delivery.status`** —— 它对空地址一样是 `accepted`，测的是"进了队列"不是"对方收到"。

**上游可能的修法**：`to` 不在已知 agent 列表时直接 4xx，而不是静默接受。

**兜底**：agent id 一律从 `GET /children?agentId=<self>` 现取，不凭记忆写；发完核 `status`。
