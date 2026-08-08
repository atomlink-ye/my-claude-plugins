// Pure CLI helpers shared by every sandbox-ctl adapter. Nothing in this
// module depends on a specific sandbox backend (Daytona, Cube, ...); it only
// deals with argv parsing, duration/id validation, shell quoting, and
// redacting secret-looking fields for display.

const SECRET_KEY_RE = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i;

function flagName(flag) {
  return flag.replace(/^--/, "");
}

function parseDurationMs(value, source = "timeout") {
  const match = /^([1-9]\d*)(ms|s|m|h)?$/.exec(String(value ?? "").trim());
  if (!match) throw new Error(`Invalid ${source}: expected a positive integer followed by ms, s, m, or h`);
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  const milliseconds = Number(match[1]) * multipliers[match[2] ?? "s"];
  if (!Number.isSafeInteger(milliseconds)) throw new Error(`Invalid ${source}: duration is too large`);
  return milliseconds;
}

/** Generic argv parser: booleanFlags/stringFlags are supplied by the caller so each adapter can define its own CLI surface. */
function parseArgs(argv = [], config = { booleanFlags: [], stringFlags: [] }) {
  const options = {};
  const positionals = [];
  const passthrough = [];
  let afterDashDash = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (afterDashDash) {
      passthrough.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDashDash = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const [rawFlag, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
      if (config.booleanFlags.includes(rawFlag)) {
        options[flagName(rawFlag)] = true;
        continue;
      }
      if (config.stringFlags.includes(rawFlag)) {
        const value = inlineValue ?? argv[++i];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for option: ${rawFlag}`);
        if (rawFlag === "--timeout") options.timeoutMs = parseDurationMs(value);
        else options[flagName(rawFlag)] = value;
        continue;
      }
      throw new Error(`Unknown option: ${rawFlag}`);
    }
    positionals.push(arg);
  }
  return { command: positionals[0], options, positionals: positionals.slice(1), passthrough };
}

function sanitizeTaskId(value, source = "task id") {
  const taskId = String(value ?? "").trim();
  if (!taskId) throw new Error(`Invalid ${source}: must not be empty`);
  if (taskId === "." || taskId === "..") throw new Error(`Invalid ${source}: must not be . or ..`);
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new Error(`Invalid ${source}: use only letters, numbers, dots, underscores, and hyphens`);
  }
  return taskId;
}

function shellQuote(value) {
  const text = String(value);
  if (text.length === 0) return "''";
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

function redactStateForDisplay(state = {}) {
  const redacted = {};
  for (const [key, value] of Object.entries(state ?? {})) redacted[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : value;
  return redacted;
}

export { flagName, parseArgs, parseDurationMs, redactStateForDisplay, sanitizeTaskId, shellQuote };
