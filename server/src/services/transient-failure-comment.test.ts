import { describe, expect, it } from "vitest";
import {
  shouldInsertTransientFailureComment,
  buildTransientFailureCommentBody,
} from "./transient-failure-comment.js";

describe("shouldInsertTransientFailureComment", () => {
  it("returns true when livenessReason is claude_transient_upstream and no comment was posted", () => {
    expect(shouldInsertTransientFailureComment("claude_transient_upstream", null)).toBe(true);
    expect(shouldInsertTransientFailureComment("claude_transient_upstream", undefined)).toBe(true);
  });

  it("returns false when agent already posted a comment in the run window", () => {
    expect(
      shouldInsertTransientFailureComment("claude_transient_upstream", { id: "comment-abc" }),
    ).toBe(false);
  });

  it("returns false when livenessReason is not claude_transient_upstream", () => {
    expect(shouldInsertTransientFailureComment("process_lost", null)).toBe(false);
    expect(shouldInsertTransientFailureComment("timeout", null)).toBe(false);
    expect(shouldInsertTransientFailureComment(null, null)).toBe(false);
    expect(shouldInsertTransientFailureComment(undefined, null)).toBe(false);
    expect(shouldInsertTransientFailureComment("codex_transient_upstream", null)).toBe(false);
  });
});

describe("buildTransientFailureCommentBody", () => {
  it("includes the run id and agent name in the comment body", () => {
    const body = buildTransientFailureCommentBody("run-xyz", "Erast");
    expect(body).toContain("run-xyz");
    expect(body).toContain("Erast");
    expect(body).toContain("claude_transient_upstream");
    expect(body).toContain("adapter_failed");
    expect(body).toContain("todo");
  });
});
