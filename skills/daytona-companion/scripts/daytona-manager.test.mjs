import test from "node:test";
import assert from "node:assert/strict";

import {
  assertSafeDestructiveRemoteWorkspace,
  buildUsage,
  collectResources,
  parseArgs,
  parsePort,
  sanitizeTaskId,
  shellQuote,
  toRemoteAbsolute,
  validateGitBranch,
  validateSandboxClass,
  validateTarEntries,
} from "./daytona-manager.mjs";

test("help documents resource, preview, git, and smoke-test capabilities", () => {
  const usage = buildUsage();
  assert.match(usage, /--class small\|medium\|large/);
  assert.match(usage, /preview/);
  assert.match(usage, /--mode bundle\|git/);
  assert.match(usage, /smoke-test/);
});

test("parser accepts new flags and command passthrough", () => {
  const parsed = parseArgs(["up", "--class", "small", "--cpu", "1", "--", "ignored"]);
  assert.equal(parsed.command, "up");
  assert.equal(parsed.options.class, "small");
  assert.equal(parsed.options.cpu, "1");
  assert.deepEqual(parsed.passthrough, ["ignored"]);
});

test("small class maps to observed self-hosted small resources", () => {
  assert.deepEqual(collectResources({ class: "small" }), { cpu: 1, memory: 1, disk: 3, gpu: 0 });
  assert.deepEqual(collectResources({ class: "small", cpu: "2" }), { cpu: 2 });
  assert.throws(() => collectResources({ cpu: "0" }), /Invalid cpu/);
  assert.deepEqual(collectResources({ gpu: "0" }), { gpu: 0 });
});

test("validates class, task id, port, remote paths, and tar entries", () => {
  const remoteHome = "/home/dev";
  assert.equal(validateSandboxClass("SMALL"), "small");
  assert.throws(() => validateSandboxClass("tiny"), /Invalid class/);
  assert.equal(sanitizeTaskId("abc_123"), "abc_123");
  assert.throws(() => sanitizeTaskId("../bad"), /Invalid/);
  assert.equal(parsePort("3000"), 3000);
  assert.throws(() => parsePort("70000"), /Invalid port/);
  assert.equal(toRemoteAbsolute("workspace/demo", remoteHome), "/home/dev/workspace/demo");
  assert.equal(toRemoteAbsolute("/tmp/demo"), "/tmp/demo");
  assert.throws(() => toRemoteAbsolute("workspace/demo"), /Relative remote paths require a remote home/);
  assert.throws(() => toRemoteAbsolute("workspace/../demo"), /Unsafe remote path/);
  assert.equal(assertSafeDestructiveRemoteWorkspace("workspace/demo", remoteHome), "/home/dev/workspace/demo");
  assert.equal(assertSafeDestructiveRemoteWorkspace("/workspace/demo", remoteHome), "/workspace/demo");
  assert.throws(() => assertSafeDestructiveRemoteWorkspace("/home/daytona/workspace/demo", remoteHome), /Refusing destructive/);
  assert.throws(() => assertSafeDestructiveRemoteWorkspace("/"), /Refusing destructive/);
  assert.equal(validateGitBranch("daytona/demo"), "daytona/demo");
  assert.throws(() => validateGitBranch("main"), /under daytona/);
  assert.deepEqual(validateTarEntries(["./stdout.txt"]), ["./stdout.txt"]);
  assert.throws(() => validateTarEntries(["../escape"]), /Unsafe tar entry/);
});

test("shellQuote safely quotes single quotes", () => {
  assert.equal(shellQuote("a'b"), "'a'\"'\"'b'");
});
