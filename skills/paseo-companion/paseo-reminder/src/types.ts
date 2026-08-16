export type LedgerType = 'park' | 'known-red' | 'deferred';
export type ReminderKind = 'generic' | 'compact-wake' | 'child-watch' | 'idle' | 'watchdog' | 'heartbeat-recovery';
export type MessageUrgency = 'normal' | 'urgent';
export type MessageDelivery = 'interrupt' | 'on-idle';
export type MessageMode = 'notify' | 'ack' | 'reply';
export type ReminderMode = 'once' | 'repeat';

export interface ReminderRecord {
  id: string;
  daemonId?: string;
  agentId: string;
  /** The manager identity that receives/delivers the reminder. */
  subjectChildId?: string;
  /** Stable kind used to make child watches idempotent. */
  kind?: ReminderKind;
  /** Child-dimensional watch discriminator (kept separate from delivery identity). */
  watchKind?: 'child';
  name: string;
  prompt: string;
  cron: string;
  expiresIn: string;
  status: 'pending' | 'active' | 'dead' | 'deleted';
  nextRunAt?: string;
  lastRunAt?: string;
  /** Observation state derived from schedule inspect/logs (durable across restarts). */
  lastFiredAt?: string;
  lastDeliveredAt?: string;
  missedFires?: number;
  observedRunIds?: string[];
  missedRunIds?: string[];
  alive?: boolean | 'unknown';
  createdAt: string;
  /** Optional finite delivery count. `1` makes this a one-shot reminder. */
  maxRuns?: number;
  /** New local reminder contract. Legacy heartbeat fields remain optional. */
  mode?: ReminderMode;
  /** Execution mechanism; active records without nextRunAt are intentional only for cron/in-process scheduling. */
  schedulingKind?: 'once' | 'repeat' | 'cron' | 'in-process';
  targetAt?: string;
  everySeconds?: number;
  runsCompleted?: number;
  delivery?: MessageDelivery;
  deliveryMessageId?: string;
  /** Delivery audit for the most recent locally-fired run. */
  deliveryStatus?: 'pending' | 'delivered';
  eventType?: string;
  criterion?: string;
}

export interface WatchdogSnapshot {
  managerId: string;
  childId: string;
  status: string;
  updatedAt?: string;
  hasLivePaseoWait?: boolean | 'unknown';
  gitDirty?: boolean | 'unknown';
  latestCommit?: string;
  notified?: string[];
}

export interface IdleReminderRecord {
  id: string;
  agentId: string;
  message: string;
  thresholdSeconds: number;
  once: boolean;
  status: 'active' | 'deleted';
  idleSince?: string;
  lastObservedUpdatedAt?: string;
  lastTriggeredAt?: string;
  createdAt: string;
}

export interface LedgerRecord {
  id: string;
  type: LedgerType;
  target: string;
  verdict: string;
  reason: string;
  recovery?: string;
  createdAt: string;
  revokedAt?: string;
  revokeReason?: string;
}

export type CorrectionResolution = 'ACCEPT' | 'REFUSE';
export type CorrectionStatus = 'open' | 'closed';

/** A finding raised by an external correction auditor. */
export interface CorrectionResolutionRecord {
  verdict: CorrectionResolution;
  note: string;
  at: string;
}

export interface CorrectionFinding {
  id: string;
  text: string;
  resolution: CorrectionResolutionRecord | null;
}

/** Durable correction instance used by the external correction gate. */
export interface CorrectionInstance {
  id: string;
  managerId: string;
  auditorId: string;
  createdAt: string;
  status: CorrectionStatus;
  findings: CorrectionFinding[];
  closedAt: string | null;
}

export interface AgentInfo {
  id: string;
  status: string;
  updatedAt?: string;
  cwd?: string;
  worktree?: string;
  parked: boolean;
  tracked: boolean;
  hasLivePaseoWait: boolean | 'unknown';
  hasLiveCompanionWatch: boolean | 'unknown';
  hasLiveWakeupSource: boolean | 'unknown';
  gitDirty: boolean | 'unknown';
  latestCommit?: string;
  createdAt?: string;
  trackedSource?: TrackedChildSource;
  trackedAddedAt?: string;
  source?: TrackedChildSource;
  addedAt?: string;
}

export type TrackedChildSource = 'explicit' | 'auto' | 'migrated';

export interface TrackedChildRecord {
  managerId: string;
  childId: string;
  source: TrackedChildSource;
  addedAt: string;
}

/** A heartbeat created outside the companion and explicitly made visible to it. */
export interface WakeupSourceRecord {
  heartbeatId: string;
  agentId: string;
  /** The cadence as supplied by the daemon (for example a cron-prefixed expression). */
  cadence: string;
  status: 'active' | 'dead';
  lastProbedAt?: string;
  lastProbeError?: string;
  registeredAt: string;
}

export interface FailedCandidate {
  id: string;
  error: string;
  category: 'timeout' | 'cli-error' | 'invalid-response';
}

export interface ChildrenResult {
  children: AgentInfo[];
  /** Canonical companion-visible wakeup set; external daemon heartbeats are omitted unless registered. */
  companionKnownWakeupSources: ReminderRecord[];
  /** Backward-compatible alias of companionKnownWakeupSources. */
  selfWakeupSources: ReminderRecord[];
  wakeupSourcesComplete: false;
  wakeupSourcesNote: string;
  partial: boolean;
  failedCandidates: FailedCandidate[];
}

/** A durable message waiting to be delivered to a Paseo agent. */
export interface MessageRecord {
  id: string;
  to: string;
  from: string;
  body: string;
  urgency: MessageUrgency;
  delivery?: MessageDelivery;
  mode?: MessageMode;
  status: 'pending' | 'delivered' | 'unacknowledged' | 'acknowledged' | 'answered' | 'cancelled';
  createdAt: string;
  deliveredAt?: string;
  ackDeadlineAt?: string;
  unacknowledgedAt?: string;
  replyTo?: string;
  replyMessageId?: string;
  answeredAt?: string;
  acknowledgedAt?: string;
  acknowledgementReason?: string;
  promptKind?: 'message' | 'reminder' | 'watchdog' | 'compact-wake';
  actionCommand?: string;
  kind?: 'heartbeat-recovery';
  recoveryManagerId?: string;
  recoveryCounts?: Record<string, number>;
  recoveryRunIds?: Record<string, string[]>;
}

/** Local index for one generation of a recipient's delivery transport. */
export interface MessageScheduleRecord {
  id: string;
  recipient: string;
  generation: string;
  daemonId?: string;
  batchIds: string[];
  prompt: string;
  status: 'pending' | 'active' | 'running' | 'failed' | 'completed' | 'deleted';
  transport?: 'heartbeat' | 'paseo-send';
  transportReason?: string;
  cron?: string;
  createdAt: string;
  lastRunAt?: string;
}
