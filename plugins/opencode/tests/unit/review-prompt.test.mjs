import { describe, expect, it } from "vitest";
import { buildReviewPrompt } from "../../scripts/opencode-companion.mjs";

describe("buildReviewPrompt", () => {
  const reviewContext = [
    "Repository: /tmp/example repo",
    "Base ref: origin/main",
    "Head ref: HEAD",
    "Review commands:",
    "- git -C '/tmp/example repo' diff origin/main...HEAD",
    "- git -C '/tmp/example repo' log --oneline origin/main..HEAD",
    "Commits:",
    "abc1234 tighten prompt",
    "def5678 add review metadata",
    "Diff summary:",
    "3 files changed, 21 insertions(+), 8 deletions(-)",
  ].join("\n");

  it("renders a short branch review prompt without inlined diff bodies", () => {
    const prompt = buildReviewPrompt(reviewContext, { focusText: "prompt size" });

    expect(prompt).toContain("git -C '/tmp/example repo' diff origin/main...HEAD");
    expect(prompt).toContain("abc1234 tighten prompt");
    expect(prompt).toContain("def5678 add review metadata");
    expect(prompt).toContain("Focus the review on: prompt size");
    expect(prompt).not.toContain("diff --git ");
    expect(prompt).not.toContain("@@ ");
  });

  it("includes adversarial framing when requested", () => {
    const prompt = buildReviewPrompt(reviewContext, { adversarial: true });

    expect(prompt).toContain("You are performing an adversarial code review.");
  });
});
