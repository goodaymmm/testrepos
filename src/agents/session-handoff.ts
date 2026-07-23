import { createHash } from "node:crypto";

export type SessionHandoffReason =
  | "daily_boundary"
  | "budget_compaction"
  | "budget_rotation";

export type SessionHandoffDecision = {
  kind: "run_status" | "approval";
  reference: string;
  status: string;
};

export type SessionHandoffSummary = {
  schema_version: "0.1";
  kind: "session_handoff_summary";
  reason: SessionHandoffReason;
  objective: string | null;
  unfinished_work: string[];
  decisions: SessionHandoffDecision[];
  artifact_references: string[];
  source_hash: string;
  created_at: string;
};

const maxHandoffItemsPerSection = 50;

export function createSessionHandoffSummary(input: {
  reason: SessionHandoffReason;
  objective?: string | null;
  unfinishedWork?: string[];
  decisions?: SessionHandoffDecision[];
  artifactReferences?: string[];
  createdAt?: Date;
}): SessionHandoffSummary {
  const content = {
    reason: input.reason,
    objective: cleanOptionalText(input.objective),
    unfinished_work: uniqueSafeValues(input.unfinishedWork),
    decisions: uniqueDecisions(input.decisions),
    artifact_references: uniqueSafeValues(input.artifactReferences)
  };

  return {
    schema_version: "0.1",
    kind: "session_handoff_summary",
    ...content,
    source_hash: sha256(JSON.stringify(content)),
    created_at: (input.createdAt ?? new Date()).toISOString()
  };
}

export function renderSessionHandoffSummary(summary: SessionHandoffSummary): string {
  return [
    "# Kairon Session Handoff",
    "",
    `Reason: ${summary.reason}`,
    `Objective: ${summary.objective ?? "(none)"}`,
    `Source hash: ${summary.source_hash}`,
    "",
    "## Unfinished Work",
    "",
    ...(summary.unfinished_work.length === 0
      ? ["- None."]
      : summary.unfinished_work.map((item) => `- ${item}`)),
    "",
    "## Decisions",
    "",
    ...(summary.decisions.length === 0
      ? ["- None."]
      : summary.decisions.map(
          (decision) =>
            `- ${decision.kind}: ${decision.reference} status=${decision.status}`
        )),
    "",
    "## Artifact References",
    "",
    ...(summary.artifact_references.length === 0
      ? ["- None."]
      : summary.artifact_references.map((reference) => `- ${reference}`)),
    ""
  ].join("\n");
}

function uniqueSafeValues(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => sanitizeLine(value))
        .filter((value): value is string => value !== null)
    )
  ].sort().slice(0, maxHandoffItemsPerSection);
}

function uniqueDecisions(
  values: SessionHandoffDecision[] | undefined
): SessionHandoffDecision[] {
  const unique = new Map<string, SessionHandoffDecision>();
  for (const value of values ?? []) {
    const reference = sanitizeLine(value.reference);
    const status = sanitizeLine(value.status);
    if (reference === null || status === null) {
      continue;
    }
    const decision = {
      kind: value.kind,
      reference,
      status
    } satisfies SessionHandoffDecision;
    unique.set(`${decision.kind}:${decision.reference}:${decision.status}`, decision);
  }
  return [...unique.values()]
    .sort((left, right) =>
      `${left.kind}:${left.reference}`.localeCompare(
        `${right.kind}:${right.reference}`
      )
    )
    .slice(0, maxHandoffItemsPerSection);
}

function cleanOptionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return sanitizeLine(value);
}

function sanitizeLine(value: string): string | null {
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
  return normalized.length === 0 ? null : normalized;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
