import fs from "node:fs";
import path from "node:path";
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
    expect(result.stdout).toContain("serve start");
  });

  test("job list with no state file prints No jobs recorded and exits 0", async () => {
    const cwd = tempWorkspace();
    const result = await spawnCompanion(["job", "list", "--directory", cwd], { cwd });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No jobs recorded");
  });

  test("job list keeps default output compact and only shows log tail in verbose mode", async () => {
    const cwd = tempWorkspace();
    const jobsDir = path.join(cwd, ".opencode-companion", "jobs");
    const jobId = "task-list-verbose";
    const jobDir = path.join(jobsDir, jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobsDir, "index.json"), JSON.stringify([
      {
        id: jobId,
        status: "running",
        startedAt: "2026-05-10T00:00:00.000Z",
        updatedAt: "2026-05-10T00:00:05.000Z",
        directory: cwd,
        promptSummary: "inspect logs",
        logFile: path.join(jobDir, "compat.log")
      }
    ], null, 2));
    fs.writeFileSync(path.join(jobDir, "compat.log"), "first line\nsecond line\n", "utf8");

    const compact = await spawnCompanion(["job", "list", "--directory", cwd], { cwd });
    expect(compact.exitCode).toBe(0);
    expect(compact.stdout).toContain("Running jobs:");
    expect(compact.stdout).not.toContain("Log tail:");
    expect(compact.stdout).not.toContain("second line");

    const verbose = await spawnCompanion(["job", "list", "--verbose", "--directory", cwd], { cwd });
    expect(verbose.exitCode).toBe(0);
    expect(verbose.stdout).toContain("Running jobs:");
    expect(verbose.stdout).toContain("Log tail:");
    expect(verbose.stdout).toContain("second line");
  });

  test("serve stop with no state file exits 0", async () => {
    const cwd = tempWorkspace();
    const result = await spawnCompanion(["serve", "stop", "--server-directory", cwd], { cwd });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No managed OpenCode serve state found");
  });

  test("cancel with missing job-id exits 1 with error message", async () => {
    const cwd = tempWorkspace();
    const result = await spawnCompanion(["job", "cancel", "--directory", cwd], { cwd });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing job id for cancel.");
  });

  test("result with unknown job-id exits 1 with No job found", async () => {
    const cwd = tempWorkspace();
    const result = await spawnCompanion(["job", "result", "job-missing", "--directory", cwd], { cwd });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No job found");
  });

  test("session new with no prompt exits 1 with error message", async () => {
    const cwd = tempWorkspace();
    const result = await spawnCompanion(["session", "new", "--directory", cwd], { cwd });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Task prompt is required.");
  });
});
