import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configStatus,
  configuredPath,
  materializeCubeSandboxEnv,
  readCubeSandboxUserConfig,
  resolveCubeSandboxValues,
  writeCubeSandboxUserConfig,
} from "../../../../skills/sandbox-ctl/scripts/lib/cube-sandbox-user-config.mjs";
import { connectionFingerprint } from "../../../../skills/sandbox-ctl/scripts/lib/cube-sandbox-daemon.mjs";
import { handleConfig } from "../../../../skills/sandbox-ctl/scripts/adapters/cube-sandbox-manager.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(path.join(tmpdir(), "cube-user-config-")); roots.push(root); return { root, file: path.join(root, "config.json"), env: { SANDBOX_CTL_USER_CONFIG: path.join(root, "config.json") } }; }
function sample() { return { schemaVersion: 1, adapters: { "cube-sandbox": { api: { url: "https://cube.example/api", key: "cube-secret" }, network: { proxyNodeIp: "10.0.0.3", proxyPortHttps: "443", caPath: "/tmp/ca.pem" } } } }; }

describe("Cube Sandbox global user config", () => {
  it("uses the platform/XDG/override path precedence", () => {
    expect(configuredPath({ SANDBOX_CTL_USER_CONFIG: "/tmp/override.json", XDG_CONFIG_HOME: "/tmp/xdg" }, "darwin", "/Users/test")).toBe("/tmp/override.json");
    expect(configuredPath({ XDG_CONFIG_HOME: "/tmp/xdg" }, "darwin", "/Users/test")).toBe("/tmp/xdg/sandbox-ctl/config.json");
    expect(configuredPath({}, "darwin", "/Users/test")).toBe("/Users/test/Library/Application Support/sandbox-ctl/config.json");
  });

  it("round-trips with private directory and file permissions", () => {
    const { root, file } = fixture();
    writeCubeSandboxUserConfig(sample(), { path: file });
    expect(readCubeSandboxUserConfig({ path: file })).toEqual(sample());
    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("cube-sandbox");
  });

  it("rejects unsafe modes, symlinks, and schema fields", () => {
    const { root, file } = fixture();
    writeCubeSandboxUserConfig(sample(), { path: file });
    chmodSync(file, 0o644);
    expect(() => readCubeSandboxUserConfig({ path: file })).toThrow(/0600/);
    chmodSync(file, 0o600);
    expect(() => writeCubeSandboxUserConfig({ schemaVersion: 2, adapters: {} }, { path: file })).toThrow(/schemaVersion/);
    const link = path.join(root, "link.json");
    symlinkSync(file, link);
    expect(() => readCubeSandboxUserConfig({ path: link })).toThrow(/symlink/i);
  });

  it("resolves each field as CUBE env, global config, then E2B env", () => {
    const config = sample();
    const values = resolveCubeSandboxValues({ config, env: { CUBE_API_URL: "https://env", E2B_API_KEY: "e2b-key", E2B_PROXY_NODE_IP: "10.0.0.9" } });
    expect(values.api).toMatchObject({ url: "https://env", key: "cube-secret" });
    expect(values.network).toMatchObject({ proxyNodeIp: "10.0.0.3", proxyPortHttps: "443" });
  });

  it("sets config without exposing the key and materializes config-only daemon values", async () => {
    const { file, env } = fixture();
    const set = await handleConfig({ configCommand: "set", env: { ...env, CUBE_API_URL: "https://cube.example", CUBE_API_KEY: "super-secret", CUBE_PROXY_NODE_IP: "10.0.0.3" } });
    expect(JSON.stringify(set)).not.toContain("super-secret");
    const status = configStatus({ env });
    expect(JSON.stringify(status)).not.toContain("super-secret");
    expect(status.configured["api.key"]).toBe(true);
    const childEnv = { ...env };
    materializeCubeSandboxEnv(childEnv);
    expect(childEnv).toMatchObject({ CUBE_API_URL: "https://cube.example", CUBE_API_KEY: "super-secret", CUBE_PROXY_NODE_IP: "10.0.0.3" });
    expect(connectionFingerprint(childEnv)).toMatchObject({ apiUrl: "https://cube.example", proxyNodeIp: "10.0.0.3", apiKeyDigest: expect.stringMatching(/^sha256:/) });
    expect(readFileSync(file, "utf8")).toContain("api");
  });
});
