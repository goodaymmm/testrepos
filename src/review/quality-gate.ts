import { loadConfigFile } from "../core/config/load-config.js";

export type ReviewSeverity = "info" | "low" | "medium" | "high" | "critical";

export type ReviewScore = {
  overall: number;
  correctness?: number;
  safety?: number;
  test_coverage?: number;
  maintainability?: number;
  policy_compliance?: number;
};

export type ReviewFinding = {
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  body: string;
};

export type ReviewResult = {
  schema_version: string;
  review_id: string;
  task_id: string;
  run_id: string;
  reviewer: string;
  target: {
    branch?: string;
    commit_sha?: string;
    diff_path?: string;
    diff_sha256?: string;
  };
  status: "approved" | "changes_requested" | "commented";
  score: ReviewScore;
  findings: ReviewFinding[];
  required_changes?: string[];
  tests_passed?: boolean;
  secret_scan_passed?: boolean;
  created_at?: string;
};

export type ReviewPolicy = {
  required_for_code: boolean;
  recommended_reviewers: string[];
  max_iterations: number;
  minimum_score: number;
  block_on_severity: ReviewSeverity[];
  allow_medium_findings: number;
  require_tests_for_code: boolean;
  require_secret_scan: boolean;
  require_reviewer_agreement: boolean;
  escalate_on_max_iterations: boolean;
  claude_opus_review_path?: string;
};

export type QualityGateDecision = {
  status: "passed" | "failed";
  reasons: string[];
  blocking_findings: ReviewFinding[];
  review_ids: string[];
};

type PoliciesConfig = {
  review: ReviewPolicy;
};

const severityRank: Record<ReviewSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

export async function loadReviewPolicy(projectRoot: string): Promise<ReviewPolicy> {
  const config = await loadConfigFile<PoliciesConfig>(projectRoot, "policies.json");
  return config.review;
}

export function evaluateQualityGate(
  policy: ReviewPolicy,
  results: ReviewResult[]
): QualityGateDecision {
  const reasons: string[] = [];
  const blockingFindings: ReviewFinding[] = [];

  if (results.length === 0) {
    reasons.push("review result is required");
  }

  for (const result of results) {
    if (result.status !== "approved") {
      reasons.push(`${result.review_id}: review status is ${result.status}`);
    }

    if (result.score.overall < policy.minimum_score) {
      reasons.push(
        `${result.review_id}: score ${result.score.overall} is below ${policy.minimum_score}`
      );
    }

    if (policy.require_tests_for_code && result.tests_passed !== true) {
      reasons.push(`${result.review_id}: tests_passed is required`);
    }

    if (policy.require_secret_scan && result.secret_scan_passed !== true) {
      reasons.push(`${result.review_id}: secret_scan_passed is required`);
    }

    const severeFindings = result.findings.filter((finding) =>
      hasBlockingSeverity(finding, policy)
    );
    blockingFindings.push(...severeFindings);

    for (const finding of severeFindings) {
      reasons.push(`${result.review_id}: ${finding.severity} finding blocks gate`);
    }

    const mediumFindings = result.findings.filter(
      (finding) => finding.severity === "medium"
    );
    if (mediumFindings.length > policy.allow_medium_findings) {
      reasons.push(
        `${result.review_id}: medium findings ${mediumFindings.length} exceeds ${policy.allow_medium_findings}`
      );
    }
  }

  if (policy.require_reviewer_agreement && hasMixedReviewStatus(results)) {
    reasons.push("reviewer agreement is required");
  }

  return {
    status: reasons.length === 0 ? "passed" : "failed",
    reasons,
    blocking_findings: blockingFindings,
    review_ids: results.map((result) => result.review_id)
  };
}

export function hasBlockingSeverity(
  finding: ReviewFinding,
  policy: ReviewPolicy
): boolean {
  return policy.block_on_severity.some(
    (severity) => severityRank[finding.severity] >= severityRank[severity]
  );
}

function hasMixedReviewStatus(results: ReviewResult[]): boolean {
  if (results.length <= 1) {
    return false;
  }

  const statuses = new Set(results.map((result) => result.status));
  return statuses.size > 1;
}
