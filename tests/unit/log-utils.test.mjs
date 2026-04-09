import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLogTail } from "../../scripts/opencode-companion.mjs";

const { mkdtempSync, rmSync, writeFileSync } = fs;
const { tmpdir } = os;

describe("readLogTail", () => {
  let directory;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "opencode-slave-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("returns an empty array for an empty file", () => {
    const file = path.join(directory, "empty.log");
    writeFileSync(file, "", "utf8");

    expect(readLogTail(file)).toEqual([]);
  });

  it("trims trailing newlines", () => {
    const file = path.join(directory, "trimmed.log");
    writeFileSync(file, "line-1\nline-2\n", "utf8");

    expect(readLogTail(file)).toEqual(["line-1", "line-2"]);
  });

  it("returns the last N lines when there are more", () => {
    const file = path.join(directory, "tail.log");
    writeFileSync(file, "one\ntwo\nthree\nfour\nfive\n", "utf8");

    expect(readLogTail(file, 2)).toEqual(["four", "five"]);
  });

  it("returns all lines when there are fewer than N", () => {
    const file = path.join(directory, "short.log");
    writeFileSync(file, "alpha\nbeta\n", "utf8");

    expect(readLogTail(file, 5)).toEqual(["alpha", "beta"]);
  });
});
