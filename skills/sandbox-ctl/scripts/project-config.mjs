import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";

const CONFIG_DIR = ".sandbox-ctl";
const CONFIG_FILE = "config.json";
const GITIGNORE = "*";
const SECRET_FIELD = /(?:secret|token|password|credential|authorization|cookie|header|\bauth\b|api[_-]?key|private[_-]?key|jwt|^env$|env[_-]?value|^value$)/i;
const BINDING_FIELDS = new Set(["sandboxId", "snapshot", "remoteWorkspace", "lifecycle", "sync", "name", "createdAt", "updatedAt", "adoptedAt", "projectIdentity", "legacyIdentity"]);
const LIFECYCLE_FIELDS = new Set(["autoStopInterval", "autoArchiveInterval", "autoDeleteInterval", "ephemeral"]);
const SYNC_FIELDS = new Set(["mode", "branch"]);
const LEGACY_IDENTITY_FIELDS = new Set(["taskId", "projectIdentity"]);
const LOCK_STALE_MS = 30_000;

function configPath(directory = process.cwd()) {
  return path.join(path.resolve(directory), CONFIG_DIR, CONFIG_FILE);
}

function isCanonicalConfigPath(filePath) {
  const resolved = path.resolve(filePath);
  return path.basename(resolved) === CONFIG_FILE && path.basename(path.dirname(resolved)) === CONFIG_DIR;
}

function assertNoSymlink(filePath, stopAt) {
  let current = path.resolve(filePath);
  const boundary = stopAt ? path.resolve(stopAt) : null;
  while (true) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symlinked sandbox config path: ${current}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = path.dirname(current);
    if (boundary && current === boundary) break;
    if (parent === current) break;
    current = parent;
  }
}

function acquireLock(lockPath) {
  assertNoSymlink(lockPath, path.dirname(lockPath));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return openSync(lockPath, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(readFileSync(lockPath, "utf8"));
        const stale = Date.now() - Number(owner.timestamp) > LOCK_STALE_MS;
        let alive = true;
        try { process.kill(Number(owner.pid), 0); } catch (probe) { alive = probe.code !== "ESRCH"; }
        if (stale && !alive) { unlinkSync(lockPath); continue; }
      } catch {
        try {
          if (Date.now() - lstatSync(lockPath).mtimeMs > LOCK_STALE_MS) { unlinkSync(lockPath); continue; }
        } catch { /* malformed/unknown owner remains busy */ }
      }
    }
  }
  throw new Error(`Sandbox config is busy: ${lockPath}`);
}

function resolveWriteTarget(directory = process.cwd()) {
  const suppliedPath = path.resolve(directory);
  return isCanonicalConfigPath(suppliedPath) ? suppliedPath : configPath(suppliedPath);
}

function withConfigLock(directory, fn) {
  const target = resolveWriteTarget(directory);
  const dir = path.dirname(target);
  assertNoSymlink(dir, path.dirname(dir));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = `${target}.lock`;
  const lockFd = acquireLock(lockPath);
  try {
    const owner = Buffer.from(JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
    writeSync(lockFd, owner, 0, owner.length, 0);
    fsyncSync(lockFd);
    return fn({ target, dir });
  } finally { closeSync(lockFd); unlinkSync(lockPath); }
}

/** Return the existing config path for exactly this directory. */
function discoverConfig(directory = process.cwd()) {
  const suppliedPath = path.resolve(directory);
  const candidate = isCanonicalConfigPath(suppliedPath) ? suppliedPath : configPath(suppliedPath);
  return inspectConfigPath(candidate);
}

function inspectConfigPath(filePath) {
  const directory = path.dirname(filePath);
  let directoryInfo;
  try { directoryInfo = lstatSync(directory); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (directoryInfo.isSymbolicLink()) throw new Error(`Refusing symlinked sandbox config directory: ${directory}`);
  if (!directoryInfo.isDirectory()) throw new Error(`Sandbox config path is not a directory: ${directory}`);

  let fileInfo;
  try { fileInfo = lstatSync(filePath); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (fileInfo.isSymbolicLink()) throw new Error(`Refusing symlinked sandbox config file: ${filePath}`);
  if (!fileInfo.isFile()) throw new Error(`Sandbox config path is not a regular file: ${filePath}`);
  return filePath;
}

function assertSafeFields(value, location = "config") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) assertSafeFields(child, `${location}[${index}]`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) throw new Error(`Refusing secret or env value field: ${location}.${key}`);
    assertSafeFields(child, `${location}.${key}`);
  }
}

function validateConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Malformed sandbox config: expected an object");
  if (input.schemaVersion !== 1) throw new Error("Malformed sandbox config: schemaVersion must be 1");
  if (input.adapter !== "daytona") throw new Error("Malformed sandbox config: adapter must be daytona");
  if (input.active !== null && input.active !== undefined && typeof input.active !== "string") throw new Error("Malformed sandbox config: active must be a binding name or null");
  if (!input.sandboxes || typeof input.sandboxes !== "object" || Array.isArray(input.sandboxes)) throw new Error("Malformed sandbox config: sandboxes must be an object");
  assertSafeFields(input);
  const sandboxes = {};
  for (const [name, binding] of Object.entries(input.sandboxes)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || !binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error(`Malformed sandbox config: invalid binding ${name}`);
    for (const key of Object.keys(binding)) if (!BINDING_FIELDS.has(key)) throw new Error(`Malformed sandbox config: unsupported binding field ${name}.${key}`);
    for (const [group, allowed] of [["lifecycle", LIFECYCLE_FIELDS], ["sync", SYNC_FIELDS], ["legacyIdentity", LEGACY_IDENTITY_FIELDS]]) {
      if (binding[group] !== undefined) {
        if (!binding[group] || typeof binding[group] !== "object" || Array.isArray(binding[group])) throw new Error(`Malformed sandbox config: ${name}.${group} must be an object`);
        for (const key of Object.keys(binding[group])) if (!allowed.has(key)) throw new Error(`Malformed sandbox config: unsupported field ${name}.${group}.${key}`);
        if (group === "lifecycle") {
          for (const key of ["autoStopInterval", "autoArchiveInterval", "autoDeleteInterval"]) {
            if (binding[group][key] !== undefined && (!Number.isInteger(binding[group][key]) || binding[group][key] < (key === "autoDeleteInterval" ? -1 : 0))) throw new Error(`Malformed sandbox config: invalid lifecycle ${key}`);
          }
        }
        if (group === "sync" && binding[group].mode !== undefined && !["bundle", "git"].includes(binding[group].mode)) throw new Error("Malformed sandbox config: invalid sync mode");
      }
    }
    const sandboxId = binding.sandboxId ?? binding.id;
    const remoteWorkspace = binding.remoteWorkspace ?? binding.remoteWorkspacePath;
    if (typeof sandboxId !== "string" || !sandboxId.trim()) throw new Error(`Malformed sandbox config: binding ${name} requires sandboxId`);
    if (typeof remoteWorkspace !== "string" || !remoteWorkspace.trim()) throw new Error(`Malformed sandbox config: binding ${name} requires remoteWorkspace`);
    sandboxes[name] = { ...binding, sandboxId: sandboxId.trim(), remoteWorkspace: remoteWorkspace.trim() };
    delete sandboxes[name].id;
    delete sandboxes[name].remoteWorkspacePath;
  }
  const active = input.active ?? null;
  if (active !== null && !Object.hasOwn(sandboxes, active)) throw new Error(`Malformed sandbox config: active binding does not exist: ${active}`);
  return { schemaVersion: 1, adapter: "daytona", active, sandboxes };
}

function readConfig(directory = process.cwd(), { allowMissing = true } = {}) {
  const suppliedPath = path.resolve(directory);
  const candidate = isCanonicalConfigPath(suppliedPath) ? suppliedPath : configPath(suppliedPath);
  const file = inspectConfigPath(candidate);
  if (!file) {
    if (allowMissing) return null;
    throw new Error(`Sandbox config not found from ${path.resolve(directory)}`);
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`Malformed sandbox config JSON: ${error.message}`); }
  return validateConfig(parsed);
}

function writeConfigUnlocked(target, config) {
  const normalized = validateConfig(config);
  const dir = path.dirname(target);
  if (isCanonicalConfigPath(target)) {
    const gitignore = path.join(dir, ".gitignore");
    assertNoSymlink(gitignore, dir);
    if (!existsSync(gitignore) || readFileSync(gitignore, "utf8") !== GITIGNORE) writeFileSync(gitignore, GITIGNORE, { mode: 0o600 });
  }
  assertNoSymlink(target, dir);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error(`Refusing symlinked sandbox config path: ${target}`);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  assertNoSymlink(temporary, dir);
  try { writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600, flag: "wx" }); chmodSync(temporary, 0o600); renameSync(temporary, target); chmodSync(target, 0o600); return target; }
  finally { rmSync(temporary, { force: true }); }
}

function writeConfig(directory = process.cwd(), config) {
  const target = resolveWriteTarget(directory);
  validateConfig(config);
  return withConfigLock(target, ({ target: lockedTarget }) => writeConfigUnlocked(lockedTarget, config));
}

function baseConfig(directory) {
  return readConfig(directory) ?? { schemaVersion: 1, adapter: "daytona", active: null, sandboxes: {} };
}

function resolveBinding(config, nameOrId) {
  if (!nameOrId) return null;
  if (config.sandboxes[nameOrId]) return { name: nameOrId, ...config.sandboxes[nameOrId] };
  for (const [name, binding] of Object.entries(config.sandboxes)) if (binding.sandboxId === nameOrId) return { name, ...binding };
  return null;
}

function upsertBinding(directory, name, binding, { use = true } = {}) {
  if (typeof name !== "string" || !name.trim()) throw new Error("Binding name must not be empty");
  return withConfigLock(directory, ({ target }) => {
    const config = readConfig(target) ?? { schemaVersion: 1, adapter: "daytona", active: null, sandboxes: {} };
    config.sandboxes[name] = { ...(config.sandboxes[name] ?? {}), ...binding };
    config.active = use ? name : (config.active && config.sandboxes[config.active] ? config.active : null);
    writeConfigUnlocked(target, config);
    return { ...config.sandboxes[name], name };
  });
}

function selectBinding(directory, nameOrId) {
  return withConfigLock(directory, ({ target }) => {
    const config = readConfig(target) ?? { schemaVersion: 1, adapter: "daytona", active: null, sandboxes: {} };
    const binding = resolveBinding(config, nameOrId ?? config.active);
    if (!binding) throw new Error(`Sandbox binding not found: ${nameOrId}`);
    config.active = binding.name;
    writeConfigUnlocked(target, config);
    return binding;
  });
}

function getActiveBinding(directory = process.cwd()) {
  const config = readConfig(directory);
  if (!config || !config.active) return null;
  return resolveBinding(config, config.active);
}

function removeBinding(directory, nameOrId) {
  return withConfigLock(directory, ({ target }) => {
    const config = readConfig(target);
    if (!config) return false;
    const binding = resolveBinding(config, nameOrId);
    if (!binding) return false;
    delete config.sandboxes[binding.name];
    if (config.active === binding.name) config.active = null;
    writeConfigUnlocked(target, config);
    return true;
  });
}

export {
  CONFIG_DIR,
  CONFIG_FILE,
  configPath,
  discoverConfig,
  readConfig,
  writeConfig,
  upsertBinding,
  selectBinding,
  getActiveBinding,
  removeBinding,
  resolveBinding,
  validateConfig,
  // Descriptive aliases retained for callers that use the public module API.
  discoverConfig as findProjectConfig,
  discoverConfig as findConfig,
  readConfig as readProjectConfig,
  writeConfig as writeProjectConfig,
  upsertBinding as upsertProjectBinding,
  selectBinding as selectProjectBinding,
  removeBinding as removeProjectBinding,
  readConfig as read,
  writeConfig as write,
  upsertBinding as upsert,
  selectBinding as select,
  removeBinding as remove,
};
