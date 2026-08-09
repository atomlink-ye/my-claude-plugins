import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync, rmSync, mkdirSync, writeFileSync, symlinkSync, utimesSync } from "node:fs";
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
  it("uses exact-directory config scope and validates the v1 shape", () => {
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
      expect(discoverConfig(nested)).toBeNull();
      expect(readConfig(nested)).toBeNull();
      upsertBinding(nested, "child", { sandboxId: "s2", remoteWorkspace: "/workspace/child" });
      expect(readConfig(nested)).toMatchObject({ active: "child", sandboxes: { child: { sandboxId: "s2" } } });
      expect(readConfig(root).sandboxes).not.toHaveProperty("child");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("canonicalizes legacy cube adapter configs on read and write", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-config-cube-"));
    try {
      mkdirSync(path.join(root, ".sandbox-ctl"), { recursive: true });
      writeFileSync(path.join(root, ".sandbox-ctl", "config.json"), JSON.stringify({
        schemaVersion: 1,
        adapter: "cube",
        active: "dev",
        sandboxes: { dev: { sandboxId: "s1", remoteWorkspace: "workspace/dev" } },
      }));
      expect(readConfig(root).adapter).toBe("cube-sandbox");
      writeConfig(root, readConfig(root));
      expect(JSON.parse(readFileSync(path.join(root, ".sandbox-ctl", "config.json"), "utf8")).adapter).toBe("cube-sandbox");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects endpoint, proxy, and secret fields from project config", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-config-fields-"));
    try {
      for (const field of ["endpoint", "proxy", "apiKey"]) {
        expect(() => writeConfig(root, { schemaVersion: 1, adapter: "cube-sandbox", [field]: "https://example.test", active: null, sandboxes: {} })).toThrow(/unsupported|config|secret|endpoint|proxy/i);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed when adding a binding with an adapter different from config", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-config-mixed-"));
    try {
      writeConfig(root, { schemaVersion: 1, adapter: "cube-sandbox", active: null, sandboxes: {} });
      expect(() => upsertBinding(root, "daytona", { sandboxId: "s1", remoteWorkspace: "/workspace/daytona" }, { adapter: "daytona" })).toThrow(/already bound|cube-sandbox/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps active bindings isolated between parent and child directories", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-config-"));
    try {
      const child = path.join(root, "child");
      mkdirSync(child);
      upsertBinding(root, "parent", { sandboxId: "p1", remoteWorkspace: "/workspace/parent" });
      upsertBinding(child, "child", { sandboxId: "c1", remoteWorkspace: "/workspace/child" });
      expect(readConfig(root).active).toBe("parent");
      expect(readConfig(child).active).toBe("child");
      selectBinding(child, "child");
      expect(readConfig(root).active).toBe("parent");
      expect(readConfig(child).active).toBe("child");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reads and writes an explicitly supplied canonical config target", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-config-"));
    try {
      const file = path.join(root, ".sandbox-ctl", "config.json");
      writeConfig(file, { schemaVersion: 1, adapter: "daytona", active: null, sandboxes: {} });
      expect(readConfig(file)).toEqual({ schemaVersion: 1, adapter: "daytona", active: null, sandboxes: {} });
      upsertBinding(file, "dev", { sandboxId: "s1", remoteWorkspace: "/workspace/dev" });
      expect(readConfig(file)).toMatchObject({ active: "dev", sandboxes: { dev: { sandboxId: "s1" } } });
      expect(readConfig(root)).toMatchObject({ active: "dev" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("treats a real project directory named config.json as a directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-config-"));
    try {
      const directory = path.join(root, "config.json");
      mkdirSync(directory);
      writeConfig(directory, { schemaVersion: 1, adapter: "daytona", active: null, sandboxes: {} });
      expect(readConfig(directory)).toEqual({ schemaVersion: 1, adapter: "daytona", active: null, sandboxes: {} });
      expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
      expect(existsSync(path.join(root, "config.json", ".sandbox-ctl", ".gitignore"))).toBe(true);
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

  it("rejects symlinked or non-regular config files while reading", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-config-"));
    const outside = mkdtempSync(path.join(tmpdir(), "sandbox-outside-"));
    try {
      writeConfig(outside, { schemaVersion: 1, adapter: "daytona", active: null, sandboxes: {} });
      writeFileSync(path.join(outside, "sentinel"), "must not be read");

      symlinkSync(path.join(outside, ".sandbox-ctl"), path.join(root, ".sandbox-ctl"));
      expect(() => readConfig(root)).toThrow(/symlink|symbolic/i);
      rmSync(path.join(root, ".sandbox-ctl"));

      mkdirSync(path.join(root, ".sandbox-ctl"));
      symlinkSync(path.join(outside, ".sandbox-ctl", "config.json"), path.join(root, ".sandbox-ctl", "config.json"));
      expect(() => readConfig(root)).toThrow(/symlink|symbolic/i);
      rmSync(path.join(root, ".sandbox-ctl", "config.json"));

      mkdirSync(path.join(root, ".sandbox-ctl", "config.json"));
      expect(() => readConfig(root)).toThrow(/regular|file|directory/i);
      expect(readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("must not be read");
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
