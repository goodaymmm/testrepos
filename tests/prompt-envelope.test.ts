import { describe, expect, it } from "vitest";
import { buildJobPrompt } from "../src/agents/prompt-envelope.js";

describe("buildJobPrompt", () => {
  it("includes review_result in stdout fallback for reviewer jobs", () => {
    const outbox = fallbackOutbox(
      buildJobPrompt({
        runId: "RUN-0001",
        taskId: "TASK-0001",
        persona: "reviewer",
        contextPath: ".kairon/runs/RUN-0001/context.md",
        expectedOutboxPath: ".kairon/runs/RUN-0001/outbox.json",
        capabilities: ["review", "json.output"]
      })
    );

    expect(outbox).toMatchObject({
      schema_version: "0.1",
      run_id: "RUN-0001",
      task_id: "TASK-0001",
      persona: "reviewer",
      status: "completed",
      review_result: {
        target: {},
        status: "commented",
        score: { overall: 0.85 },
        findings: [],
        tests_passed: true,
        secret_scan_passed: true
      }
    });
  });

  it("keeps normal job stdout fallback free of review_result", () => {
    const outbox = fallbackOutbox(
      buildJobPrompt({
        runId: "RUN-0002",
        taskId: "TASK-0002",
        persona: "implementer",
        contextPath: ".kairon/runs/RUN-0002/context.md",
        expectedOutboxPath: ".kairon/runs/RUN-0002/outbox.json"
      })
    );

    expect(outbox).not.toHaveProperty("review_result");
  });
});

function fallbackOutbox(prompt: string): Record<string, unknown> {
  const match = /KAIRON_OUTBOX_JSON_START\s*([\s\S]*?)\s*KAIRON_OUTBOX_JSON_END/.exec(
    prompt
  );

  if (match?.[1] === undefined) {
    throw new Error("Prompt is missing stdout fallback JSON.");
  }

  return JSON.parse(match[1]) as Record<string, unknown>;
}
