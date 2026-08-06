import { describe, expect, it } from "vitest";
import { linkSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { assertSafeRemoteTransferPath, createBundle, handlePush, listTarEntries, mergeTransferTree, parseArgs, resolveRemoteTransferPath, validateTarEntries } from "../../../../skills/sandbox-ctl/scripts/adapters/daytona-manager.mjs";
import { parseSandboxCtlArgs, runSandboxCtl } from "../../../../skills/sandbox-ctl/scripts/sandbox-ctl.mjs";
import { writeConfig } from "../../../../skills/sandbox-ctl/scripts/project-config.mjs";

describe("explicit full directory transfer", () => {
  it("bundle excludes credentials, control state, agent state, build output, dependencies, and logs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-transfer-fixture-"));
    try {
      for (const name of [".env", ".env.local", ".git", ".sandbox-ctl", "node_modules", "dist", "build", ".claude", ".opencode-state", ".daytona", "logs"]) mkdirSync(path.join(root, name), { recursive: true });
      writeFileSync(path.join(root, "safe.txt"), "safe");
      writeFileSync(path.join(root, "logs", "run.txt"), "log");
      const bundle = createBundle(root, "fixture", { mode: "bundle" });
      try {
        const entries = listTarEntries(bundle.bundlePath);
        expect(entries.some((entry) => entry.endsWith("safe.txt"))).toBe(true);
        for (const blocked of [".env", ".env.local", ".git", ".sandbox-ctl", "node_modules", "dist", "build", ".claude", ".opencode-state", ".daytona", "logs"]) {
          expect(entries.some((entry) => entry === `./${blocked}` || entry.startsWith(`./${blocked}/`))).toBe(false);
        }
      } finally { bundle.cleanup(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("full mode includes harmless sensitive files but never control state", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-transfer-full-"));
    try {
      mkdirSync(path.join(root, ".git"));
      mkdirSync(path.join(root, ".sandbox-ctl"));
      writeFileSync(path.join(root, ".env"), "SAFE=1\n");
      writeFileSync(path.join(root, "file.txt"), "ok");
      const bundle = createBundle(root, "fixture", { mode: "full", includeSensitive: true });
      try {
        const entries = listTarEntries(bundle.bundlePath);
        expect(entries.some((entry) => entry.endsWith(".env"))).toBe(true);
        expect(entries.some((entry) => entry === "./.git" || entry.startsWith("./.git/"))).toBe(true);
        expect(entries.some((entry) => entry === "./.sandbox-ctl" || entry.startsWith("./.sandbox-ctl/"))).toBe(false);
      } finally { bundle.cleanup(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed for full mode without include-sensitive and rejects include-sensitive elsewhere", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-transfer-sensitive-"));
    try {
      expect(() => createBundle(root, "fixture", { mode: "full" })).toThrow(/include-sensitive|credential|secret/i);
      expect(() => createBundle(root, "fixture", { mode: "bundle", includeSensitive: true })).toThrow(/only valid.*full|include-sensitive/i);
      expect(() => createBundle(root, "fixture", { mode: "git", includeSensitive: true })).toThrow(/only valid.*full|include-sensitive/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects unsafe archive paths and link escapes", () => {
    expect(() => validateTarEntries(["/absolute"])).toThrow(/unsafe/i);
    expect(() => validateTarEntries(["../escape"])).toThrow(/unsafe/i);
    expect(() => validateTarEntries(["C:/escape"])).toThrow(/unsafe/i);
    expect(() => validateTarEntries([{ name: "link", type: "symlink", linkname: "../../escape" }])).toThrow(/special|symlink|unsafe/i);
    expect(() => validateTarEntries([{ name: "hard", type: "hardlink", linkname: "/etc/passwd" }])).toThrow(/special|hardlink|unsafe/i);
  });

  it("rejects a real tar symlink escape before extraction", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-transfer-link-"));
    const taskId = `link-leak-${process.pid}`;
    const ownedPrefix = `daytona-input-${taskId}-`;
    try {
      symlinkSync("../../outside", path.join(root, "escape"));
      const before = readdirSync(tmpdir()).filter((entry) => entry.startsWith(ownedPrefix));
      expect(() => createBundle(root, taskId, { mode: "bundle" })).toThrow(/special|symlink|unsafe/i);
      expect(readdirSync(tmpdir()).filter((entry) => entry.startsWith(ownedPrefix))).toEqual(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects special entries even when names contain link-like text, while allowing regular names", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-transfer-link-name-"));
    try {
      writeFileSync(path.join(root, "regular -> escape"), "safe");
      const safe = createBundle(root, "safe", { mode: "bundle" });
      try { expect(listTarEntries(safe.bundlePath).some((entry) => entry.includes("regular"))).toBe(true); }
      finally { safe.cleanup(); }
      symlinkSync("../../outside", path.join(root, "evil -> escape"));
      writeFileSync(path.join(root, "hard source"), "hard");
      linkSync(path.join(root, "hard source"), path.join(root, "hard link to escape"));
      expect(() => createBundle(root, "evil", { mode: "bundle" })).toThrow(/special|symlink|hardlink|unsafe/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("parses explicit transfer flags and positional paths", () => {
    expect(parseArgs(["push", "--mode", "full", "--include-sensitive", "--overwrite"]).options).toMatchObject({ mode: "full", "include-sensitive": true, overwrite: true });
    expect(parseSandboxCtlArgs(["push", "./src", "--remote-path", "/workspace/src", "--mode", "full", "--include-sensitive"]).positionals).toEqual(["./src"]);
    expect(parseSandboxCtlArgs(["pull", "/workspace/src", "--output", "./out", "--overwrite"]).positionals).toEqual(["/workspace/src"]);
  });

  it("lets a positional pull remote path override the active binding default", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-transfer-binding-"));
    try {
      writeConfig(root, { schemaVersion: 1, adapter: "daytona", active: "dev", sandboxes: { dev: { sandboxId: "s1", remoteWorkspace: "/workspace/binding" } } });
      const calls = [];
      const adapter = {
        parseArgs: (argv) => ({ command: argv[0], options: { directory: root }, positionals: [], passthrough: [] }),
        handlePull: async (options) => { calls.push(options); return { ok: true, mode: options.mode ?? "bundle" }; },
      };
      await runSandboxCtl(["pull", "/workspace/explicit", "--directory", root], { adapter });
      expect(calls[0]["remote-path"]).toBe("/workspace/explicit");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects local paths whose symlink or resolved ancestor enters .sandbox-ctl", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-transfer-control-link-"));
    try {
      const control = path.join(root, ".sandbox-ctl");
      mkdirSync(control, { recursive: true });
      writeFileSync(path.join(control, "config.json"), "control");
      const directLink = path.join(root, "control-link");
      symlinkSync(control, directLink);
      expect(() => createBundle(directLink, "fixture", { mode: "full", includeSensitive: true })).toThrow(/sandbox-ctl|control/i);
      const ancestorRoot = path.join(root, "ancestor-link");
      symlinkSync(control, ancestorRoot);
      expect(() => createBundle(path.join(ancestorRoot, "config.json"), "fixture", { mode: "full", includeSensitive: true })).toThrow(/sandbox-ctl|control/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed for remote control roots by lexical and resolved path", async () => {
    expect(() => assertSafeRemoteTransferPath("/workspace/.sandbox-ctl/data")).toThrow(/sandbox-ctl|control/i);
    const sandbox = { process: { executeCommand: async () => ({ exitCode: 0, stdout: "/workspace/.sandbox-ctl\n" }) } };
    await expect(resolveRemoteTransferPath(sandbox, "/workspace/link")).rejects.toThrow(/sandbox-ctl|control/i);
    await expect(resolveRemoteTransferPath({ process: { executeCommand: async () => ({ exitCode: 127, stderr: "realpath unavailable" }) } }, "/workspace/missing")).rejects.toThrow(/realpath|resolve|remote/i);
  });

  it("rejects symlink entries during staging merge even if archive validation was bypassed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-transfer-stage-link-"));
    try {
      const stage = path.join(root, "stage");
      const output = path.join(root, "output");
      mkdirSync(stage);
      mkdirSync(output);
      symlinkSync("../../outside", path.join(stage, "escape"));
      expect(() => mergeTransferTree(stage, output, false)).toThrow(/special|symlink/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports full mode on successful push in human and JSON CLI paths", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-transfer-full-result-"));
    const originalLog = console.log;
    const logs = [];
    try {
      console.log = (...args) => logs.push(args.join(" "));
      writeConfig(root, { schemaVersion: 1, adapter: "daytona", active: "dev", sandboxes: { dev: { sandboxId: "s1", remoteWorkspace: "/workspace/binding" } } });
      const realResult = await handlePush({
        directory: root,
        path: root,
        mode: "full",
        includeSensitive: true,
        client: {
          get: async () => ({
            state: "started",
            process: { executeCommand: async () => ({ exitCode: 0, stdout: "/home/test\n" }) },
            fs: { uploadFiles: async () => {} },
          }),
        },
      });
      expect(realResult).toMatchObject({ ok: true, mode: "full" });
      const fake = {
        parseArgs: (argv) => {
          const options = {};
          for (let index = 1; index < argv.length; index += 1) {
            if (argv[index] === "--mode") options.mode = argv[++index];
            else if (argv[index] === "--include-sensitive") options["include-sensitive"] = true;
          }
          return { command: argv[0], options, positionals: [], passthrough: [] };
        },
        handlePush: async (options) => ({ ok: true, mode: options.mode, human: `Uploaded ${options.mode} archive` }),
      };
      const human = await runSandboxCtl(["push", root, "--mode", "full", "--include-sensitive"], { adapter: fake });
      expect(human).toMatchObject({ ok: true, mode: "full" });
      const json = await runSandboxCtl(["--json", "push", root, "--mode", "full", "--include-sensitive"], { adapter: fake });
      expect(json).toMatchObject({ ok: true, mode: "full" });
      expect(logs.join(" ")).toContain("full");
    } finally { console.log = originalLog; rmSync(root, { recursive: true, force: true }); }
  });
});
