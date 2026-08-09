import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tls from "node:tls";

const SCHEMA_VERSION = 1;
const ADAPTER = "cube-sandbox";
const API_FIELDS = new Set(["url", "key"]);
const NETWORK_FIELDS = new Set(["apiNodeIp", "proxyNodeIp", "proxyPortHttps", "apiSandboxDomain", "proxyUrl", "caPath"]);
const ROOT_FIELDS = new Set(["schemaVersion", "adapters"]);
const ENV_FIELDS = {
  "api.url": ["CUBE_API_URL", "E2B_API_URL"],
  "api.key": ["CUBE_API_KEY", "E2B_API_KEY"],
  "network.apiNodeIp": ["CUBE_API_NODE_IP", "E2B_API_NODE_IP"],
  "network.proxyNodeIp": ["CUBE_PROXY_NODE_IP", "E2B_PROXY_NODE_IP"],
  "network.proxyPortHttps": ["CUBE_PROXY_PORT_HTTPS", "E2B_PROXY_PORT_HTTPS"],
  "network.apiSandboxDomain": ["CUBE_API_SANDBOX_DOMAIN", "E2B_API_SANDBOX_DOMAIN"],
  "network.proxyUrl": ["CUBE_PROXY_URL", "E2B_PROXY_URL"],
  "network.caPath": ["CUBE_CA_PATH", "E2B_CA_PATH"],
};
let appliedCaPath;

function configuredPath(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.SANDBOX_CTL_USER_CONFIG) return path.resolve(String(env.SANDBOX_CTL_USER_CONFIG));
  if (env.XDG_CONFIG_HOME) return path.join(path.resolve(String(env.XDG_CONFIG_HOME)), "sandbox-ctl", "config.json");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "sandbox-ctl", "config.json");
  return path.join(home, ".config", "sandbox-ctl", "config.json");
}

function assertNoSymlink(filePath) {
  const target = path.resolve(filePath);
  // System prefixes such as macOS /var may themselves be compatibility
  // symlinks. Reject the config file and its containing directory, while
  // allowing such harmless ancestors.
  for (const current of [target, path.dirname(target)]) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symlinked Cube Sandbox user config path: ${current}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function validateString(value, location) {
  if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new Error(`Malformed Cube Sandbox user config: ${location} must be a non-empty string`);
}

function validateConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Malformed Cube Sandbox user config: expected an object");
  for (const key of Object.keys(input)) if (!ROOT_FIELDS.has(key)) throw new Error(`Malformed Cube Sandbox user config: unsupported field ${key}`);
  if (input.schemaVersion !== SCHEMA_VERSION) throw new Error("Malformed Cube Sandbox user config: schemaVersion must be 1");
  if (!input.adapters || typeof input.adapters !== "object" || Array.isArray(input.adapters)) throw new Error("Malformed Cube Sandbox user config: adapters must be an object");
  for (const adapter of Object.keys(input.adapters)) if (adapter !== ADAPTER) throw new Error(`Malformed Cube Sandbox user config: unsupported adapter ${adapter}`);
  const cube = input.adapters[ADAPTER];
  if (cube === undefined) return { schemaVersion: 1, adapters: {} };
  if (!cube || typeof cube !== "object" || Array.isArray(cube)) throw new Error("Malformed Cube Sandbox user config: cube-sandbox entry must be an object");
  for (const key of Object.keys(cube)) if (!["api", "network"].includes(key)) throw new Error(`Malformed Cube Sandbox user config: unsupported cube-sandbox field ${key}`);
  const normalized = { schemaVersion: 1, adapters: { [ADAPTER]: {} } };
  for (const [group, allowed] of [["api", API_FIELDS], ["network", NETWORK_FIELDS]]) {
    if (cube[group] === undefined) continue;
    if (!cube[group] || typeof cube[group] !== "object" || Array.isArray(cube[group])) throw new Error(`Malformed Cube Sandbox user config: ${group} must be an object`);
    const clean = {};
    for (const [key, value] of Object.entries(cube[group])) {
      if (!allowed.has(key)) throw new Error(`Malformed Cube Sandbox user config: unsupported field ${group}.${key}`);
      validateString(value, `${group}.${key}`);
      clean[key] = value;
    }
    if (Object.keys(clean).length) normalized.adapters[ADAPTER][group] = clean;
  }
  if (!Object.keys(normalized.adapters[ADAPTER]).length) delete normalized.adapters[ADAPTER];
  return normalized;
}

function readCubeSandboxUserConfig(options = {}) {
  if (typeof options === "string") options = { path: options };
  const filePath = options.path ? path.resolve(options.path) : configuredPath(options.env ?? process.env, options.platform ?? process.platform, options.home ?? os.homedir());
  assertNoSymlink(filePath);
  try {
    const directoryInfo = lstatSync(path.dirname(filePath));
    if (!directoryInfo.isDirectory()) throw new Error(`Cube Sandbox user config directory is not a directory: ${path.dirname(filePath)}`);
    if (process.getuid && directoryInfo.uid !== process.getuid()) throw new Error(`Cube Sandbox user config directory is not owned by the current user: ${path.dirname(filePath)}`);
    if ((directoryInfo.mode & 0o077) !== 0) throw new Error(`Cube Sandbox user config directory must be mode 0700: ${path.dirname(filePath)}`);
    const info = lstatSync(filePath);
    if (!info.isFile()) throw new Error(`Cube Sandbox user config path is not a regular file: ${filePath}`);
    if (process.getuid && info.uid !== process.getuid()) throw new Error(`Cube Sandbox user config is not owned by the current user: ${filePath}`);
    if ((info.mode & 0o077) !== 0) throw new Error(`Cube Sandbox user config must be mode 0600: ${filePath}`);
    return validateConfig(JSON.parse(readFileSync(filePath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error(`Malformed Cube Sandbox user config JSON: ${error.message}`);
    throw error;
  }
}

function writeCubeSandboxUserConfig(config, options = {}) {
  if (typeof options === "string") options = { path: options };
  const filePath = options.path ? path.resolve(options.path) : configuredPath(options.env ?? process.env, options.platform ?? process.platform, options.home ?? os.homedir());
  const normalized = validateConfig(config);
  const directory = path.dirname(filePath);
  assertNoSymlink(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const info = statSync(directory);
  if (process.getuid && info.uid !== process.getuid()) throw new Error(`Cube Sandbox user config directory is not owned by the current user: ${directory}`);
  assertNoSymlink(filePath);
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, filePath);
    chmodSync(filePath, 0o600);
  } finally { rmSync(temporary, { force: true }); }
  return filePath;
}

function valueAt(config, key) {
  const [group, field] = key.split(".");
  return config?.adapters?.[ADAPTER]?.[group]?.[field];
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== "");
}

function resolveCubeSandboxValues({ env = process.env, config } = {}) {
  const loaded = config === undefined ? readCubeSandboxUserConfig({ env }) : config;
  const values = {};
  for (const [key, names] of Object.entries(ENV_FIELDS)) {
    const [cubeName, e2bName] = names;
    values[key] = firstValue(env[cubeName], valueAt(loaded, key), env[e2bName]);
  }
  return {
    api: { url: values["api.url"], key: values["api.key"] },
    network: {
      apiNodeIp: values["network.apiNodeIp"], proxyNodeIp: values["network.proxyNodeIp"], proxyPortHttps: values["network.proxyPortHttps"],
      apiSandboxDomain: values["network.apiSandboxDomain"], proxyUrl: values["network.proxyUrl"], caPath: values["network.caPath"],
    },
  };
}

function materializeCubeSandboxEnv(env = process.env) {
  const resolved = resolveCubeSandboxValues({ env });
  const set = (name, value) => { if (value !== undefined && value !== "") env[name] = String(value); };
  set("CUBE_API_URL", resolved.api.url); set("CUBE_API_KEY", resolved.api.key);
  set("CUBE_API_NODE_IP", resolved.network.apiNodeIp); set("CUBE_PROXY_NODE_IP", resolved.network.proxyNodeIp);
  set("CUBE_PROXY_PORT_HTTPS", resolved.network.proxyPortHttps); set("CUBE_API_SANDBOX_DOMAIN", resolved.network.apiSandboxDomain);
  set("CUBE_PROXY_URL", resolved.network.proxyUrl); set("CUBE_CA_PATH", resolved.network.caPath);
  if (resolved.network.caPath) {
    // NODE_EXTRA_CA_CERTS is read only during Node startup. Newer Node
    // versions expose a runtime CA hook; use it when available so a daemon
    // started from config-only credentials trusts the configured CA.
    if (typeof tls.setDefaultCACertificates === "function" && appliedCaPath !== String(resolved.network.caPath)) {
      let pem;
      try { pem = readFileSync(String(resolved.network.caPath), "utf8"); }
      catch (error) { throw new Error(`Configured Cube Sandbox CA file is unreadable: ${resolved.network.caPath} (${error.message})`); }
      const existing = typeof tls.getCACertificates === "function" ? tls.getCACertificates("default") : [];
      tls.setDefaultCACertificates([...existing, pem]);
      appliedCaPath = String(resolved.network.caPath);
    }
  }
  return resolved;
}

function sanitizeUrl(value) {
  if (!value) return undefined;
  try { const url = new URL(String(value)); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString().replace(/\/$/, ""); }
  catch { return String(value).replace(/:[^/@\s]+@/g, "@").replace(/[?#].*$/, ""); }
}

function configStatus(options = {}) {
  const pathValue = options.path ? path.resolve(options.path) : configuredPath(options.env ?? process.env, options.platform ?? process.platform, options.home ?? os.homedir());
  const loaded = readCubeSandboxUserConfig({ ...options, path: pathValue });
  const resolved = resolveCubeSandboxValues({ env: options.env ?? process.env, config: loaded });
  const configured = {};
  for (const [group, values] of Object.entries(resolved)) for (const [field, value] of Object.entries(values)) configured[`${group}.${field}`] = Boolean(value);
  return { path: pathValue, exists: Boolean(loaded), configured, apiUrl: sanitizeUrl(resolved.api.url), proxyUrl: sanitizeUrl(resolved.network.proxyUrl) };
}

export {
  ADAPTER,
  ENV_FIELDS,
  configuredPath,
  configStatus,
  materializeCubeSandboxEnv,
  readCubeSandboxUserConfig,
  resolveCubeSandboxValues,
  validateConfig,
  writeCubeSandboxUserConfig,
};
