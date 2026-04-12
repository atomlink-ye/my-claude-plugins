import { afterEach, describe, expect, test } from "vitest";
import {
  makeTempDir,
  removeDir,
  spawnCompanion
} from "./test-helpers.mjs";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    removeDir(tempDirs.pop());
  }
});

function tempWorkspace() {
  const dir = makeTempDir("opencode-smoke-");
  tempDirs.push(dir);
  return dir;
}

describe("companion CLI smoke tests", () => {
  test("--help prints usage and exits 0", async () => {
    const result = await spawnCompanion(["--help"], { cwd: tempWorkspace() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("ensure-serve");
  });

  test("status with no state file prints No jobs recorded and exits 0", async () => {
    const cwd = tempWorkspace();
    const result = await spawnCompanion(["status", "--directory", cwd], { cwd });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No jobs recorded");
  });

  test("cleanup with no state file exits 0", async () => {
    const cwd = tempWorkspace();
    const result = await spawnCompanion(["cleanup", "--directory", cwd], { cwd });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No managed OpenCode serve state found");
  });

  test("cancel with missing job-id exits 1 with error message", async () => {
    const cwd = tempWorkspace();
    const result = await spawnCompanion(["cancel", "--directory", cwd], { cwd });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing job id for cancel.");
  });

  test("result with unknown job-id exits 1 with No job found", async () => {
    const cwd = tempWorkspace();
    const result = await spawnCompanion(["result", "job-missing", "--directory", cwd], { cwd });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No job found");
  });

  test("task with no prompt exits 1 with error message", async () => {
    const cwd = tempWorkspace();
    const result = await spawnCompanion(["task", "--directory", cwd], { cwd });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Task prompt is required.");
  });
});
