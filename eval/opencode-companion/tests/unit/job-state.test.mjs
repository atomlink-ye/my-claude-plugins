import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildJobLivenessEvent,
  formatReadableTimestamp,
  isActiveJob,
  readJobs,
  refreshStaleRunningJobs,
  upsertJob
} from "../../../../skills/opencode-companion/scripts/opencode-companion.mjs";
import {
  createJobLogFile,
  readJobSnapshot,
  recordJobEvent,
  renderJobSnapshotMarkdown
} from "../../../../skills/opencode-companion/scripts/opencode-companion/jobs.mjs";
import {
  jobCompatLogFilePath,
  jobEventsFilePath,
  jobSnapshotMarkdownFilePath,
  jobSnapshotStateFilePath,
  jobsFilePath,
  resolveArtifactRoot
} from "../../../../skills/opencode-companion/scripts/opencode-companion/config.mjs";

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
    expect(job.directory).toBe(directory);
    expect(job.startedAt).toBeUndefined();
    expect(job.completedAt).toBeUndefined();
    expect(readJobs(directory)).toHaveLength(1);
  });

  it("stores job records under the default .opencode-companion artifact root", () => {
    upsertJob(directory, {
      id: "task-layout",
      status: "queued",
      prompt: "hello world"
    });

    expect(jobsFilePath(directory)).toBe(path.join(directory, ".opencode-companion", "jobs", "index.json"));
    expect(fs.existsSync(jobsFilePath(directory))).toBe(true);
  });

  it("resolves artifact root precedence as cli flag, then env var, then default", () => {
    const previous = process.env.OPENCODE_ARTIFACT_ROOT;

    process.env.OPENCODE_ARTIFACT_ROOT = "env-artifacts";
    expect(resolveArtifactRoot(directory)).toBe(path.join(directory, "env-artifacts"));
    expect(resolveArtifactRoot(directory, "cli-artifacts")).toBe(path.join(directory, "cli-artifacts"));

    delete process.env.OPENCODE_ARTIFACT_ROOT;
    expect(resolveArtifactRoot(directory)).toBe(path.join(directory, ".opencode-companion"));

    if (previous == null) {
      delete process.env.OPENCODE_ARTIFACT_ROOT;
    } else {
      process.env.OPENCODE_ARTIFACT_ROOT = previous;
    }
  });

  it("records durable events and derived snapshots in each job artifact directory", () => {
    const jobId = "task-snapshot";
    const logFile = createJobLogFile(directory, jobId);

    expect(logFile).toBe(path.join(directory, ".opencode-companion", "jobs", jobId, "compat.log"));
    expect(fs.existsSync(jobCompatLogFilePath(directory, jobId))).toBe(true);

    recordJobEvent(directory, jobId, {
      type: "job.lifecycle",
      status: "running",
      summary: "Background worker started",
      sessionId: "ses_demo",
      activityKind: "worker_started"
    });
    recordJobEvent(directory, jobId, {
      type: "job.result",
      status: "completed",
      summary: "Final answer ready",
      final: { combinedText: "final answer" },
      activityKind: "result_ready"
    });

    expect(fs.existsSync(jobEventsFilePath(directory, jobId))).toBe(true);
    expect(fs.existsSync(jobSnapshotStateFilePath(directory, jobId))).toBe(true);
    expect(fs.existsSync(jobSnapshotMarkdownFilePath(directory, jobId))).toBe(true);

    const snapshot = readJobSnapshot(directory, jobId);
    expect(snapshot.status).toBe("completed");
    expect(snapshot.latestActivity.kind).toBe("result_ready");
    expect(snapshot.final.combinedText).toBe("final answer");
  });

  it("default liveness snapshot surfaces active descendant sessions from the session hierarchy", () => {
    const jobId = "task-descendant-liveness";
    upsertJob(directory, {
      id: jobId,
      status: "running",
      sessionId: "ses_root",
      prompt: "show me descendant liveness",
      promptSummary: "show me descendant liveness"
    });

    const hierarchyContext = {
      summariesById: new Map([
        [
          "ses_root",
          {
            id: "ses_root",
            status: "busy",
            createdAt: "2026-05-10T00:00:00.000Z",
            updatedAt: "2026-05-10T00:00:10.000Z"
          }
        ],
        [
          "ses_child",
          {
            id: "ses_child",
            parentId: "ses_root",
            status: "busy",
            createdAt: "2026-05-10T00:00:05.000Z",
            updatedAt: "2026-05-10T00:00:20.000Z"
          }
        ]
      ]),
      childrenByParent: new Map([["ses_root", ["ses_child"]]])
    };

    recordJobEvent(
      directory,
      jobId,
      buildJobLivenessEvent(
        {
          id: jobId,
          status: "running",
          sessionId: "ses_root",
          promptSummary: "show me descendant liveness"
        },
        hierarchyContext,
        []
      )
    );

    const snapshot = readJobSnapshot(directory, jobId);
    expect(snapshot.latestActivity.kind).toBe("descendant_activity");
    expect(snapshot.active.descendantSessionIds).toEqual(["ses_child"]);
    expect(renderJobSnapshotMarkdown(snapshot)).toContain("Current focus: active descendant sessions: ses_child");
  });

  it("renders readable latest-activity timestamps in default and verbose job status views", () => {
    const latestActivityAt = 1778399738319;
    const readableAt = formatReadableTimestamp(latestActivityAt);
    const snapshot = {
      jobId: "task-readable-time",
      status: "running",
      latestActivity: {
        at: latestActivityAt,
        kind: "descendant_activity",
        sessionId: "ses_demo",
        summary: "Child session emitted progress"
      },
      hierarchy: {
        rootSessionId: "ses_demo",
        verdict: "active_descendants",
        statusCounts: { busy: 1 },
        sessionCount: 1,
        descendantCount: 0,
        latestActivityAt,
        latestActivitySessionId: "ses_demo"
      }
    };

    const compactView = renderJobSnapshotMarkdown(snapshot);
    const verboseView = renderJobSnapshotMarkdown(snapshot, { verbose: true });

    expect(compactView).toContain(`Latest activity: ${readableAt}`);
    expect(compactView).not.toContain(`Latest activity: ${latestActivityAt}`);
    expect(verboseView).toContain(`- latest hierarchy activity: ${readableAt}`);
    expect(verboseView).not.toContain(`- latest hierarchy activity: ${latestActivityAt}`);
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
    fs.mkdirSync(path.dirname(jobsFilePath(directory)), { recursive: true });
    writeFileSync(
      jobsFilePath(directory),
      JSON.stringify(
        [
          {
            id: "task-dead",
            status: "running",
            startedAt: "2024-01-01T00:00:00.000Z",
            pid: 999999,
            directory,
            logFile: jobCompatLogFilePath(directory, "task-dead")
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

    fs.mkdirSync(path.dirname(jobsFilePath(directory)), { recursive: true });
    writeFileSync(
      jobsFilePath(directory),
      JSON.stringify(
        [
          {
            id: "task-queued",
            status: "queued",
            startedAt: "2024-01-01T00:00:00.000Z",
            pid: null,
            directory,
            logFile: jobCompatLogFilePath(directory, "task-queued")
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

    fs.mkdirSync(path.dirname(jobsFilePath(directory)), { recursive: true });
    writeFileSync(
      jobsFilePath(directory),
      JSON.stringify(
        [
          {
            id: "task-live",
            status: "running",
            startedAt: "2024-01-01T00:00:00.000Z",
            pid: process.pid,
            directory,
            logFile: jobCompatLogFilePath(directory, "task-live")
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
