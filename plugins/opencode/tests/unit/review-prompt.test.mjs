import { describe, expect, it } from "vitest";
import { buildReviewPrompt } from "../../scripts/opencode-companion.mjs";

describe("buildReviewPrompt", () => {
  const metadata = {
    scope: "branch",
    directory: "/tmp/example repo",
    branch: "feature/review-prompt",
    base: "origin/main",
    head: "abc1234",
    commitLog: "abc1234 tighten prompt\ndef5678 add review metadata",
    statFooter: " 3 files changed, 21 insertions(+), 8 deletions(-)"
  };

  it("renders a short branch review prompt without inlined diff bodies", () => {
    const prompt = buildReviewPrompt(metadata, { focusText: "prompt size" });

    expect(prompt).toContain("git -C '/tmp/example repo' diff origin/main...HEAD");
    expect(prompt).toContain("abc1234 tighten prompt");
    expect(prompt).toContain("def5678 add review metadata");
    expect(prompt).toContain("Focus the review on: prompt size");
    expect(prompt).not.toContain("diff --git ");
    expect(prompt).not.toContain("@@ ");
  });

  it("includes adversarial framing when requested", () => {
    const prompt = buildReviewPrompt(metadata, { adversarial: true });

    expect(prompt).toContain("You are performing an adversarial code review.");
  });
});
