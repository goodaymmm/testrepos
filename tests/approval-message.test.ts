import { describe, expect, it } from "vitest";
import {
  buildApprovalMessage,
  containsUnsafeApprovalMessageData
} from "../src/discord/approval-message.js";

describe("buildApprovalMessage", () => {
  it("builds compact approval payload with action buttons", () => {
    const message = buildApprovalMessage({
      id: "APR-0001",
      task_id: "TASK-0001",
      title: "Merge approval",
      type: "merge",
      risk_level: "high",
      risk_reason: "Touches protected workflow",
      summary_items: [
        "Board approval added",
        "Tests passed",
        "Review passed",
        "Deploy not included",
        "This item should be omitted"
      ],
      checks: [
        { name: "tests", status: "passed" },
        { name: "review", status: "passed" }
      ],
      branch: "auto/TASK-0001/codex",
      commit_sha: "abcdef1234567890",
      nonce: "n42",
      actions: ["approve", "reject", "request_changes", "snooze"]
    });

    expect(message.content).toBe("Approval requested: APR-0001");
    expect(message.embeds[0]?.fields.map((field) => field.name)).toEqual(
      expect.arrayContaining(["Approval", "Summary", "Checks"])
    );
    expect(message.embeds[0]?.fields.find((field) => field.name === "Summary")?.value).not.toContain(
      "This item should be omitted"
    );
    expect(message.components[0]?.components.map((button) => button.custom_id)).toEqual(
      expect.arrayContaining([
        "kr:v1:apr:APR-0001:approve:n42",
        "kr:v1:apr:APR-0001:reject:n42",
        "kr:v1:apr:APR-0001:changes:n42",
        "kr:v1:apr:APR-0001:snooze:n42"
      ])
    );
  });

  it("redacts secret-like text and avoids full diff/log fields", () => {
    const message = buildApprovalMessage({
      id: "APR-0002",
      title: "Token update",
      type: "secret_change",
      summary_items: ["API_TOKEN=secret"],
      branch: "auto/TASK-0002/codex",
      diff: "full diff should not be emitted"
    });

    expect(JSON.stringify(message)).not.toContain("API_TOKEN=secret");
    expect(JSON.stringify(message)).not.toContain("full diff should not be emitted");
    expect(containsUnsafeApprovalMessageData({ ...message, id: "APR-0002", title: "x", type: "x" })).toBe(false);
    expect(
      containsUnsafeApprovalMessageData({
        id: "APR-0002",
        title: "x",
        type: "x",
        diff: "diff --git a/a b/a"
      })
    ).toBe(true);
  });
});
