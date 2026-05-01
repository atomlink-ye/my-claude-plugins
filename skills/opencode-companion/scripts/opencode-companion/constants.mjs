export const HOSTNAME = "127.0.0.1";
export const STATE_FILE_NAME = ".opencode-serve.json";
export const JOBS_FILE_NAME = ".opencode-jobs.json";
export const JOB_LOG_PREFIX = ".opencode-job-";
export const JOB_LOG_SUFFIX = ".log";
export const RUNTIME_STATE_DIR_NAME = ".opencode-state";
export const STARTUP_TIMEOUT_MS = 10000;
export const HEALTH_TIMEOUT_MS = 1200;
export const SHUTDOWN_TIMEOUT_MS = 5000;
export const MESSAGE_POST_TIMEOUT_MS = 3600000;
export const STATUS_SESSION_LIMIT = 10;
export const MAX_STORED_JOBS = 50;
export const STATUS_RECENT_LIMIT = 5;
export const STATUS_LOG_TAIL_LINES = 5;
export const DEFAULT_SESSION_TIMEOUT_MINS = 60;
// Platform-aware ARG_MAX safety thresholds for inlining prompts as argv.
// macOS ARG_MAX = 1 MB (per-arg comfortably fits 64 KB).
// Linux ARG_MAX ~= 2 MB; per-arg cap MAX_ARG_STRLEN = 128 KB (64 KB has 2x margin).
// Windows CreateProcessW caps the *entire* command line at 32,767 wide chars,
// so the per-prompt budget must stay well below that to leave room for the
// script path, flags, and shell quoting.
export const PROMPT_INLINE_MAX_BYTES_DEFAULT_POSIX = 65536;
export const PROMPT_INLINE_MAX_BYTES_DEFAULT_WIN32 = 16384;
export const JOB_PROMPT_PREFIX = ".opencode-job-";
export const JOB_PROMPT_SUFFIX = ".prompt";
