import { describe, expect, it } from "vitest";
import { evaluateQualityGate, type ReviewPolicy, type ReviewResult } from "../src/review/quality-gate.js";

const policy: ReviewPolicy = {
  required_for_code: true,
  recommended_reviewers: ["claude", "codex"],
  max_iterations: 3,
  minimum_score: 0.85,
  block_on_severity: ["critical", "high"],
  allow_medium_findings: 0,
  require_tests_for_code: true,
  require_secret_scan: true,
  require_reviewer_agreement: true,
  escalate_on_max_iterations: true
};

function review(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    schema_version: "0.1",
    review_id: "REV-0001",
    task_id: "TASK-0001",
    run_id: "RUN-0001",
    reviewer: "codex",
    target: { diff_sha256: "sha256:abc" },
    status: "approved",
    score: { overall: 0.9 },
    findings: [],
    tests_passed: true,
    secret_scan_passed: true,
    ...overrides
  };
}

describe("quality gate", () => {
  it("passes approved review results above threshold", () => {
    expect(evaluateQualityGate(policy, [review()])).toMatchObject({
      status: "passed",
      reasons: []
    });
  });

  it("fails below minimum score", () => {
    expect(
      evaluateQualityGate(policy, [review({ score: { overall: 0.5 } })])
    ).toMatchObject({
      status: "failed"
    });
  });

  it("fails on blocking severity and medium finding policy", () => {
    const result = evaluateQualityGate(policy, [
      review({
        findings: [
          { severity: "high", body: "Unsafe write path." },
          { severity: "medium", body: "Missing test." }
        ]
      })
    ]);

    expect(result.status).toBe("failed");
    expect(result.blocking_findings).toHaveLength(1);
    expect(result.reasons.join("\n")).toContain("medium findings 1 exceeds 0");
  });

  it("requires tests and secret scan when configured", () => {
    expect(
      evaluateQualityGate(policy, [
        review({ tests_passed: false, secret_scan_passed: false })
      ])
    ).toMatchObject({
      status: "failed"
    });
  });
});
