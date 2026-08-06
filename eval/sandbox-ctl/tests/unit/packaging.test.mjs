import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file) => readFileSync(path.join(root, file), "utf8");

describe("sandbox-ctl packaging", () => {
  it("registers the canonical executable and skill", () => {
    const pkg = JSON.parse(read("package.json"));
    const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
    expect(pkg.bin).toEqual({ "sandbox-ctl": "./skills/sandbox-ctl/scripts/sandbox-ctl.mjs" });
    expect(marketplace.plugins.flatMap((plugin) => plugin.skills)).toContain("./skills/sandbox-ctl");
  });

  it("has secure sandbox-ctl skill frontmatter and guidance", () => {
    const skill = read("skills/sandbox-ctl/SKILL.md");
    expect(skill).toMatch(/^---\nname: sandbox-ctl\ndescription: ["']Use when/);
    expect(skill.trim().split(/\s+/).length).toBeLessThan(500);
    expect(skill).toMatch(/deprecated.*task|task.*deprecated/i);
    expect(skill).not.toMatch(/metadata-only/i);
    expect(skill).not.toMatch(/task-v1|project-v1/i);
    expect(skill).toMatch(/MCP|daemon/i);
    expect(skill).toMatch(/--keep|nextActions/);
  });

  it("ships offline smoke checks with executable permissions", () => {
    for (const file of ["eval/sandbox-ctl/tests/smoke.sh", "eval/sandbox-ctl/tests/real-smoke.sh"]) {
      expect(statSync(path.join(root, file)).mode & 0o111).toBeTruthy();
      expect(read(file)).toMatch(/SANDBOX_CTL_REAL_SMOKE/);
    }
    expect(read("eval/sandbox-ctl/tests/smoke.sh")).toMatch(/unknown adapter|exit 7|legacy/i);
  });

  it("makes real smoke opt-in, isolated, and cleanup-safe", () => {
    const smoke = read("eval/sandbox-ctl/tests/real-smoke.sh");
    expect(smoke).toMatch(/SANDBOX_CTL_SNAPSHOT:-personal-dev-env-control-20260806/);
    expect(smoke).toMatch(/--snapshot[\s\S]+\$SNAPSHOT/);
    expect(smoke).toMatch(/UP_ATTEMPTED=1/);
    expect(smoke).toMatch(/if \[\[? "\$UP_ATTEMPTED"/);
    expect(smoke).toMatch(/OUT\/success/);
    expect(smoke).toMatch(/OUT\/exit7/);
    expect(smoke).toMatch(/exit-code\.txt/);
    expect(smoke).toMatch(/finish/);
    expect(smoke).not.toMatch(/\/tmp\/sandbox-ctl-real-(up|exit7)/);
  });

  it("documents executable run/artifact/JSON contracts and safe maintenance scope", () => {
    const skill = read("skills/sandbox-ctl/SKILL.md");
    const daytona = read("skills/sandbox-ctl/references/daytona.md");
    const maintenance = read("skills/sandbox-ctl/references/maintenance.md");
    const runtime = read("skills/daytona-companion/references/remote-agent-runtime.md");
    for (const flag of ["--directory", "--task-id", "--output", "--snapshot", "--json", "--keep", "--"]) expect(skill).toContain(flag);
    for (const artifact of ["stdout.txt", "stderr.txt", "exit-code.txt", "manifest.json"]) expect(daytona).toContain(artifact);
    expect(daytona).not.toMatch(/metadata-only|task-v1|project-v1/i);
    expect(daytona).toMatch(/sandbox-v1/);
    expect(maintenance).toMatch(/sandbox-ctl list --json/);
    expect(maintenance).toMatch(/sandbox-ctl doctor --json/);
    expect(maintenance).toMatch(/df -h/);
    expect(maintenance).toMatch(/future|not.*implemented/i);
    expect(runtime).toMatch(/deprecated|tombstone/i);
    expect(runtime).not.toMatch(/daemon start|PASEO_DAEMON|agent credentials/i);
    expect(read("skills/daytona-companion/references/troubleshooting.md")).not.toMatch(/paseo daemon (stop|start)|PASEO_DAEMON|paseo run --host|remote agents? are/i);
    expect(daytona).toMatch(/reuse.*lifecycle/i);
    expect(skill).toMatch(/stateDirectory/);
    expect(skill).toMatch(/error.*optional|optional.*error/i);
  });

  it("keeps smoke cleanup evidence and uses temporary offline paths", () => {
    const adapter = read("skills/sandbox-ctl/scripts/adapters/daytona-manager.mjs");
    const real = read("eval/sandbox-ctl/tests/real-smoke.sh");
    const offline = read("eval/sandbox-ctl/tests/smoke.sh");
    expect(adapter).toMatch(/Smoke cleanup failed/);
    expect(adapter).toMatch(/sandbox-ctl finish --directory/);
    expect(real).toMatch(/retained state|WARNING: cleanup failed/i);
    expect(real).toMatch(/rm -rf .*\$WORK.*\$OUT/);
    expect(real).toMatch(/node "\$CLI" --json finish --directory "\$WORK" --state-directory "\$STATE" --task-id "\$TASK"/);
    expect(offline).toMatch(/mktemp/);
    expect(offline).not.toMatch(/>\/tmp\//);
  });
});
