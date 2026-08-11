export type LedgerType = 'park' | 'known-red' | 'deferred';
export type ReminderKind = 'generic' | 'compact-wake' | 'child-watch';
export type MessageUrgency = 'normal' | 'urgent';

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

export interface AgentInfo {
  id: string;
  status: string;
  updatedAt?: string;
  cwd?: string;
  worktree?: string;
  parked: boolean;
  hasLivePaseoWait: boolean | 'unknown';
  hasLiveCompanionWatch: boolean | 'unknown';
  hasLiveWakeupSource: boolean | 'unknown';
  gitDirty: boolean | 'unknown';
}

export interface FailedCandidate {
  id: string;
  error: string;
  category: 'timeout' | 'cli-error' | 'invalid-response';
}

export interface ChildrenResult {
  children: AgentInfo[];
  selfWakeupSources: ReminderRecord[];
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
  status: 'pending' | 'delivered' | 'cancelled';
  createdAt: string;
  deliveredAt?: string;
  kind?: 'heartbeat-recovery';
  recoveryManagerId?: string;
  recoveryCounts?: Record<string, number>;
  recoveryRunIds?: Record<string, string[]>;
}

/** Local index for one generation of a recipient's one-shot delivery schedule. */
export interface MessageScheduleRecord {
  id: string;
  recipient: string;
  generation: string;
  daemonId?: string;
  batchIds: string[];
  prompt: string;
  status: 'pending' | 'active' | 'running' | 'failed' | 'completed' | 'deleted';
  createdAt: string;
  lastRunAt?: string;
}
