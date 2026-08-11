export type LedgerType = 'park' | 'known-red' | 'deferred';
export type ReminderKind = 'generic' | 'compact-wake' | 'child-watch';

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
  hasLiveWakeupSource: boolean;
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
