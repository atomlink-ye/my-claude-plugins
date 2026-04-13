import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isActiveJob, readJobs, refreshStaleRunningJobs, upsertJob } from "../../../../plugins/opencode/scripts/opencode-companion.mjs";

const { mkdtempSync, rmSync, writeFileSync } = fs;
const { tmpdir } = os;

describe("job state helpers", () => {
  let directory;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "opencode-slave-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  });

  it("upsertJob creates a new job record", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

    const job = upsertJob(directory, {
      id: "task-1",
      status: "queued",
      prompt: "hello world"
    });

    expect(job).toMatchObject({
      id: "task-1",
      status: "queued",
      prompt: "hello world"
    });
    expect(job.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(job.updatedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(job.directory).toBeUndefined();
    expect(job.startedAt).toBeUndefined();
    expect(job.completedAt).toBeUndefined();
    expect(readJobs(directory)).toHaveLength(1);
  });

  it("upsertJob updates an existing job by merging fields", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

    const created = upsertJob(directory, {
      id: "task-2",
      status: "queued",
      prompt: "original prompt",
      model: "gpt-4"
    });

    vi.setSystemTime(new Date("2024-01-01T00:00:10.000Z"));

    const updated = upsertJob(directory, {
      id: "task-2",
      status: "running",
      pid: 4321
    });

    expect(updated).toMatchObject({
      id: "task-2",
      status: "running",
      prompt: "original prompt",
      model: "gpt-4",
      pid: 4321,
      createdAt: created.createdAt
    });
    expect(updated.updatedAt).toBe("2024-01-01T00:00:10.000Z");
  });

  it("readJobs returns an empty array when the file is missing", () => {
    expect(readJobs(directory)).toEqual([]);
  });

  it("refreshStaleRunningJobs marks a dead running job as failed", () => {
    writeFileSync(
      path.join(directory, ".opencode-jobs.json"),
      JSON.stringify(
        [
          {
            id: "task-dead",
            status: "running",
            startedAt: "2024-01-01T00:00:00.000Z",
            pid: 999999,
            directory,
            logFile: path.join(directory, ".opencode-job-task-dead.log")
          }
        ],
        null,
        2
      ),
      "utf8"
    );

    const jobs = refreshStaleRunningJobs(directory);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: "task-dead",
      status: "failed",
      pid: null,
      error: "Worker process died unexpectedly"
    });
    expect(jobs[0].completedAt).toBeTruthy();
  });

  it("refreshStaleRunningJobs marks an old queued job with no pid as failed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:01:00.000Z"));

    writeFileSync(
      path.join(directory, ".opencode-jobs.json"),
      JSON.stringify(
        [
          {
            id: "task-queued",
            status: "queued",
            startedAt: "2024-01-01T00:00:00.000Z",
            pid: null,
            directory,
            logFile: path.join(directory, ".opencode-job-task-queued.log")
          }
        ],
        null,
        2
      ),
      "utf8"
    );

    const jobs = refreshStaleRunningJobs(directory);

    expect(jobs[0]).toMatchObject({
      id: "task-queued",
      status: "failed",
      pid: null,
      error: "Worker process died unexpectedly"
    });
  });

  it("refreshStaleRunningJobs leaves alive jobs untouched", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:01:00.000Z"));

    writeFileSync(
      path.join(directory, ".opencode-jobs.json"),
      JSON.stringify(
        [
          {
            id: "task-live",
            status: "running",
            startedAt: "2024-01-01T00:00:00.000Z",
            pid: process.pid,
            directory,
            logFile: path.join(directory, ".opencode-job-task-live.log")
          }
        ],
        null,
        2
      ),
      "utf8"
    );

    const jobs = refreshStaleRunningJobs(directory);

    expect(jobs[0]).toMatchObject({
      id: "task-live",
      status: "running",
      pid: process.pid
    });
  });

  it("isActiveJob returns true for queued and running jobs and false otherwise", () => {
    expect(isActiveJob({ status: "queued" })).toBe(true);
    expect(isActiveJob({ status: "running" })).toBe(true);
    expect(isActiveJob({ status: "completed" })).toBe(false);
    expect(isActiveJob({ status: "failed" })).toBe(false);
  });
});
