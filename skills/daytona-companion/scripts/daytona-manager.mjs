#!/usr/bin/env node

// Backwards-compatible entry point. The implementation now lives in the
// Daytona adapter used by sandbox-ctl; keep this shim so existing skill
// references and imports continue to work unchanged.
import process from "node:process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import * as adapter from "../../sandbox-ctl/scripts/adapters/daytona-manager.mjs";
import { runSandboxCtl } from "../../sandbox-ctl/scripts/sandbox-ctl.mjs";

function isSameRealPath(a, b) {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
}

const isDirectExecution = isSameRealPath(process.argv[1] ?? "", fileURLToPath(import.meta.url));
if (isDirectExecution) runSandboxCtl(process.argv.slice(2)).then((result) => {
  if (typeof result?.exitCode === "number") process.exitCode = result.exitCode;
  else if (result?.ok === false) process.exitCode = 1;
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

export const {
  applyDaytonaEnv, applyProjectEnv, assertRemoteCommandSuccess,
  assertManagedSandbox, assertSafeDestructiveRemoteWorkspace, buildSandboxCreateParams, buildSmokeTestOptions, buildUsage, collectResources,
  createBundle, createClient, createGitBundle, createSandboxWithFallback, downloadFile,
  fetchGitBundleIntoBranch, getSandbox, handleAdopt, handleDown, handleExec,
  handleList, handleDoctor, handlePreview, handlePull, handlePush,
  handleSmokeTest, handleStatus, handleUp, hasExplicitResourceFlags,
  listTarEntries, loadEnvFile, main, parseArgs, parsePort, parseRemoteInteger,
  readProjectState, readRemoteText, redactStateForDisplay, remoteEnsureGitCommand,
  readProjectStateWithSource,
  removeStateSource,
  resolveEnvFile, resolveEnvFiles, resolveProjectPaths, resolveRemoteHome,
  runDaytonaManager, runDoctorCheck, sandboxExec, sanitizeTaskId, shellQuote, toRemoteAbsolute,
  uploadFile, validateGitBranch, validateSandboxClass, validateTarEntries,
  writeProvisionalSandboxState,
} = adapter;
