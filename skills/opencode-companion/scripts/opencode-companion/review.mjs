import { runCommandCapture } from "./process-utils.mjs";
import { opencodeEnv } from "./serve.mjs";
import { firstNonEmptyLine } from "./text-utils.mjs";

export async function runGitCommand(directory, args, { timeoutMs = 10000, allowNonZero = false } = {}) {
  const result = await runCommandCapture("git", args, {
    cwd: directory,
    env: opencodeEnv(directory),
    timeoutMs
  });

  if (result.error?.code === "ENOENT") {
    throw new Error("Git is not installed or is not on PATH.");
  }

  if (result.timedOut) {
    throw new Error(`Timed out while running git ${args.join(" ")}.`);
  }

  if (!allowNonZero && result.exitCode !== 0) {
    const details = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout) || "Unknown error.";
    throw new Error(`git ${args.join(" ")} failed: ${details}`);
  }

  return result;
}

export async function gitText(directory, args, options = {}) {
  const result = await runGitCommand(directory, args, options);
  return String(result.stdout ?? "").trimEnd();
}

export async function resolveDefaultReviewBaseRef(directory) {
  const upstream = await gitText(directory, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    allowNonZero: true
  });
  if (upstream) {
    return upstream;
  }

  const originHead = await gitText(directory, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
    allowNonZero: true
  });
  if (originHead) {
    return originHead;
  }

  for (const candidate of ["origin/main", "main", "origin/master", "master"]) {
    const exists = await gitText(directory, ["rev-parse", "--verify", "--quiet", candidate], {
      allowNonZero: true
    });
    if (exists) {
      return candidate;
    }
  }

  return null;
}

export async function getCurrentGitBranch(directory) {
  const branch = await gitText(directory, ["branch", "--show-current"], {
    allowNonZero: true
  });
  return branch || null;
}

export async function getAheadCommitCount(directory, baseRef) {
  const count = await gitText(directory, ["rev-list", "--count", `${baseRef}..HEAD`]);
  const parsed = Number(count);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeReviewScope(scope) {
  const value = String(scope ?? "auto").trim();
  if (!value) {
    return "auto";
  }
  if (value === "auto" || value === "working-tree" || value === "branch") {
    return value;
  }
  throw new Error(`Invalid review scope: ${scope}. Use auto, working-tree, or branch.`);
}

export async function collectWorkingTreeReviewContext(directory) {
  const status = await gitText(directory, ["status", "--short", "--untracked-files=all"]);
  const staged = await gitText(directory, ["diff", "--cached", "--no-ext-diff", "--unified=3"]);
  const unstaged = await gitText(directory, ["diff", "--no-ext-diff", "--unified=3"]);

  if (!status.trim() && !staged.trim() && !unstaged.trim()) {
    throw new Error("No staged or unstaged changes found for working-tree review.");
  }

  const sections = [
    "Review scope: working-tree",
    `Directory: ${directory}`
  ];

  if (status.trim()) {
    sections.push("", "Git status:", status.trimEnd());
  }

  sections.push("", "Staged diff:", staged.trimEnd() || "(none)", "", "Unstaged diff:", unstaged.trimEnd() || "(none)");
  return sections.join("\n");
}

export async function collectBranchReviewContext(directory, baseRef) {
  const branch = await getCurrentGitBranch(directory);
  const head = await gitText(directory, ["rev-parse", "--short", "HEAD"]);
  const log = await gitText(directory, ["log", "--oneline", `${baseRef}..HEAD`]);
  const diff = await gitText(directory, ["diff", "--no-ext-diff", "--unified=3", `${baseRef}...HEAD`]);

  if (!log.trim() && !diff.trim()) {
    throw new Error(`No commits or diff found between ${baseRef} and HEAD for branch review.`);
  }

  const sections = [
    "Review scope: branch",
    `Directory: ${directory}`,
    `Branch: ${branch ?? "detached HEAD"}`,
    `Base: ${baseRef}`,
    `Head: ${head || "unknown"}`
  ];

  if (log.trim()) {
    sections.push("", `Commit log (${baseRef}..HEAD):`, log.trimEnd());
  }

  if (diff.trim()) {
    sections.push("", `Diff (${baseRef}...HEAD):`, diff.trimEnd());
  }

  return sections.join("\n");
}

export function buildReviewPrompt(context, { adversarial = false, focusText = null } = {}) {
  const sections = [];

  if (adversarial) {
    sections.push(
      "You are performing an adversarial code review. Challenge design decisions, question tradeoffs, and identify assumptions."
    );
  }

  sections.push(
    "Please review the following code changes and report findings by severity (Critical/High/Medium/Low). Include file paths and line numbers."
  );

  if (focusText) {
    sections.push("", `Focus the review on: ${focusText}`);
  }

  sections.push("", context);
  return sections.join("\n");
}
