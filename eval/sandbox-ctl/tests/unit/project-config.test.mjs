import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, rmSync, mkdirSync, writeFileSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  discoverConfig,
  readConfig,
  writeConfig,
  upsertBinding,
  selectBinding,
  removeBinding,
} from "../../../../skills/sandbox-ctl/scripts/project-config.mjs";

describe("sandbox-ctl project config", () => {
  it("discovers the nearest parent config and validates the v1 shape", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-config-"));
    try {
      const nested = path.join(root, "packages", "app");
      mkdirSync(nested, { recursive: true });
      writeConfig(root, {
        schemaVersion: 1,
        adapter: "daytona",
        active: "dev",
        sandboxes: { dev: { sandboxId: "s1", remoteWorkspace: "/workspace/dev" } },
      });
      expect(discoverConfig(nested)).toBe(path.join(root, ".sandbox-ctl", "config.json"));
      expect(readConfig(nested)).toMatchObject({ active: "dev", sandboxes: { dev: { sandboxId: "s1" } } });
      upsertBinding(nested, "child", { sandboxId: "s2", remoteWorkspace: "/workspace/child" });
      expect(readConfig(root).sandboxes).toHaveProperty("child");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("atomically writes mode 0600 config and a private gitignore", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-config-"));
    try {
      const file = writeConfig(root, { schemaVersion: 1, adapter: "daytona", active: null, sandboxes: {} });
      expect(file).toBe(path.join(root, ".sandbox-ctl", "config.json"));
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(path.join(root, ".sandbox-ctl", ".gitignore"), "utf8")).toBe("*");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("upserts, selects by name or sandbox id, and removes bindings", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-config-"));
    try {
      upsertBinding(root, "dev", { sandboxId: "s1", remoteWorkspace: "/workspace/dev" });
      upsertBinding(root, "dev", { sandboxId: "s1", remoteWorkspace: "/workspace/dev", snapshot: "snap", sync: { mode: "git", branch: "daytona/dev" } });
      upsertBinding(root, "dev", { sandboxId: "s1", remoteWorkspace: "/workspace/dev", lifecycle: { autoDeleteInterval: 0 } });
      expect(readConfig(root).sandboxes.dev).toMatchObject({ snapshot: "snap", sync: { mode: "git" }, lifecycle: { autoDeleteInterval: 0 } });
      upsertBinding(root, "prod", { sandboxId: "s2", remoteWorkspace: "/workspace/prod" }, { use: false });
      expect(selectBinding(root, "s2")).toMatchObject({ name: "prod", sandboxId: "s2" });
      expect(readConfig(root).active).toBe("prod");
      removeBinding(root, "dev");
      expect(readConfig(root).sandboxes).not.toHaveProperty("dev");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects malformed structures and secret or env values", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-config-"));
    try {
      expect(() => writeConfig(root, { schemaVersion: 2, adapter: "daytona", sandboxes: {} })).toThrow(/schema/i);
      expect(() => writeConfig(root, { schemaVersion: 1, adapter: "other", sandboxes: {} })).toThrow(/adapter/i);
      expect(() => writeConfig(root, { schemaVersion: 1, adapter: "daytona", sandboxes: { x: { sandboxId: "s", remoteWorkspace: "/w", env: { TOKEN: "secret" } } } })).toThrow(/secret|env/i);
      expect(() => writeConfig(root, { schemaVersion: 1, adapter: "daytona", sandboxes: { x: { sandboxId: "s", remoteWorkspace: "/w", headers: { Authorization: "Bearer secret" } } } })).toThrow(/secret|auth|header/i);
      expect(() => writeConfig(root, { schemaVersion: 1, adapter: "daytona", sandboxes: { x: { sandboxId: "s", remoteWorkspace: "/w", lifecycle: { requestedTtlMinutes: 10 } } } })).toThrow(/ttl|unsupported/i);
      expect(() => writeConfig(root, { schemaVersion: 1, adapter: "daytona", sandboxes: [] })).toThrow(/sandboxes/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("repairs a pre-existing non-protective gitignore before writing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-config-"));
    try {
      mkdirSync(path.join(root, ".sandbox-ctl"), { recursive: true });
      writeFileSync(path.join(root, ".sandbox-ctl", ".gitignore"), "*.log\n");
      writeConfig(root, { schemaVersion: 1, adapter: "daytona", active: null, sandboxes: {} });
      expect(readFileSync(path.join(root, ".sandbox-ctl", ".gitignore"), "utf8")).toBe("*");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects symlinked config directories and files without touching the target", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-config-"));
    const outside = mkdtempSync(path.join(tmpdir(), "sandbox-outside-"));
    try {
      symlinkSync(outside, path.join(root, ".sandbox-ctl"));
      expect(() => writeConfig(root, { schemaVersion: 1, adapter: "daytona", active: null, sandboxes: {} })).toThrow(/symlink|symbolic/i);
      rmSync(path.join(root, ".sandbox-ctl"));
      mkdirSync(path.join(root, ".sandbox-ctl"));
      writeFileSync(path.join(outside, "sentinel"), "safe");
      symlinkSync(path.join(outside, "config.json"), path.join(root, ".sandbox-ctl", "config.json"));
      expect(() => writeConfig(root, { schemaVersion: 1, adapter: "daytona", active: null, sandboxes: {} })).toThrow(/symlink|symbolic/i);
      expect(readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("safe");
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  it("rejects lifecycle values outside the unified policy and invalid sync modes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-config-"));
    try {
      expect(() => writeConfig(root, { schemaVersion: 1, adapter: "daytona", active: null, sandboxes: { x: { sandboxId: "s", remoteWorkspace: "/w", lifecycle: { autoStopInterval: -2 } } } })).toThrow(/lifecycle|interval/i);
      expect(() => writeConfig(root, { schemaVersion: 1, adapter: "daytona", active: null, sandboxes: { x: { sandboxId: "s", remoteWorkspace: "/w", sync: { mode: "bad" } } } })).toThrow(/sync|mode/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails clearly on a busy lock without corrupting the existing config", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-config-"));
    try {
      writeConfig(root, { schemaVersion: 1, adapter: "daytona", active: null, sandboxes: {} });
      writeFileSync(path.join(root, ".sandbox-ctl", "config.json.lock"), "held", { flag: "wx" });
      expect(() => writeConfig(root, { schemaVersion: 1, adapter: "daytona", active: null, sandboxes: { held: { sandboxId: "s", remoteWorkspace: "/w" } } })).toThrow(/busy/i);
      expect(readConfig(root).sandboxes).toEqual({});
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reclaims only an old malformed lock and rejects a fresh malformed lock", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-config-"));
    try {
      const lock = path.join(root, ".sandbox-ctl", "config.json.lock");
      mkdirSync(path.dirname(lock), { recursive: true });
      writeFileSync(lock, "");
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      writeConfig(root, { schemaVersion: 1, adapter: "daytona", active: null, sandboxes: {} });
      writeFileSync(lock, "malformed");
      expect(() => writeConfig(root, { schemaVersion: 1, adapter: "daytona", active: null, sandboxes: {} })).toThrow(/busy/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
