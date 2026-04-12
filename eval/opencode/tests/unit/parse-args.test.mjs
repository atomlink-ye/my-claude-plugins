import { describe, expect, it } from "vitest";
import { parseArgs } from "../../plugins/opencode/scripts/opencode-companion.mjs";

describe("parseArgs", () => {
  const booleanFlags = ["--all", "--background", "--wait", "--adversarial"];
  const stringFlags = ["--directory", "--model", "--base", "--scope", "--port", "--job-id"];

  it("parses boolean flags", () => {
    const result = parseArgs(["--all", "--background", "--wait", "--adversarial"], {
      booleanFlags,
      stringFlags
    });

    expect(result.options).toEqual({
      all: true,
      background: true,
      wait: true,
      adversarial: true
    });
    expect(result.positionals).toEqual([]);
  });

  it("parses string flags", () => {
    const result = parseArgs(
      [
        "--directory",
        "/tmp/project",
        "--model",
        "gpt-4.1",
        "--base",
        "origin/main",
        "--scope",
        "branch",
        "--port",
        "4321",
        "--job-id",
        "task-abc123-def456"
      ],
      {
        booleanFlags,
        stringFlags
      }
    );

    expect(result.options).toEqual({
      directory: "/tmp/project",
      model: "gpt-4.1",
      base: "origin/main",
      scope: "branch",
      port: "4321",
      "job-id": "task-abc123-def456"
    });
    expect(result.positionals).toEqual([]);
  });

  it("parses positional args", () => {
    const result = parseArgs(["alpha", "beta", "gamma"], {
      booleanFlags,
      stringFlags
    });

    expect(result.options).toEqual({});
    expect(result.positionals).toEqual(["alpha", "beta", "gamma"]);
  });

  it("parses mixed flags and positionals", () => {
    const result = parseArgs(
      ["--all", "alpha", "--model", "gpt-4.1", "beta", "--background", "--job-id", "task-1", "gamma"],
      {
        booleanFlags,
        stringFlags
      }
    );

    expect(result.options).toEqual({
      all: true,
      model: "gpt-4.1",
      background: true,
      "job-id": "task-1"
    });
    expect(result.positionals).toEqual(["alpha", "beta", "gamma"]);
  });

  it("stops parsing flags after --", () => {
    const result = parseArgs(["--all", "--", "--background", "alpha", "--model", "beta"], {
      booleanFlags,
      stringFlags
    });

    expect(result.options).toEqual({ all: true });
    expect(result.positionals).toEqual(["--background", "alpha", "--model", "beta"]);
  });

  it("throws on unknown flags", () => {
    expect(() =>
      parseArgs(["--unknown"], {
        booleanFlags,
        stringFlags
      })
    ).toThrow("Unknown option: --unknown");
  });

  it("throws when a string flag is missing a value", () => {
    expect(() =>
      parseArgs(["--directory"], {
        booleanFlags,
        stringFlags
      })
    ).toThrow("Missing value for option: --directory");
  });
});
