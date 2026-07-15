import {
  applyCleanupProposal,
  archiveCleanupProposal,
  listCleanupProposals,
  planCleanupRetention,
  readCleanupProposalById,
  type CleanupApplyResult,
  type CleanupArchiveResult,
  type CleanupProposal,
  type CleanupProposalSummary,
  type CleanupRetentionPlanResult
} from "../../maintenance/cleanup-proposals.js";

export type CleanupApplyCommandOptions = {
  dryRun?: boolean;
};

export type CleanupRetentionPlanCommandOptions = {
  dryRun?: boolean;
  writeProposal?: boolean;
};

export async function listCleanupCommand(projectRoot: string): Promise<string> {
  return formatCleanupProposalList(await listCleanupProposals(projectRoot));
}

export async function showCleanupCommand(
  projectRoot: string,
  proposalId: string
): Promise<string> {
  return formatCleanupProposal(await readCleanupProposalById(projectRoot, proposalId));
}

export async function applyCleanupCommand(
  projectRoot: string,
  proposalId: string,
  options: CleanupApplyCommandOptions = {}
): Promise<string> {
  return formatCleanupApplyResult(
    await applyCleanupProposal({
      projectRoot,
      proposalId,
      dryRun: options.dryRun
    })
  );
}

export async function archiveCleanupCommand(
  projectRoot: string,
  proposalId: string
): Promise<string> {
  return formatCleanupArchiveResult(
    await archiveCleanupProposal({
      projectRoot,
      proposalId
    })
  );
}

export async function planCleanupRetentionCommand(
  projectRoot: string,
  options: CleanupRetentionPlanCommandOptions = {}
): Promise<string> {
  if (options.dryRun === true && options.writeProposal === true) {
    throw new Error("Use either --dry-run or --write-proposal, not both.");
  }
  return formatCleanupRetentionPlan(
    await planCleanupRetention(projectRoot, {
      writeProposal: options.writeProposal === true
    })
  );
}

export function formatCleanupProposalList(proposals: CleanupProposalSummary[]): string {
  if (proposals.length === 0) {
    return "No Kairon cleanup proposals found.";
  }

  return [
    "Kairon cleanup proposals:",
    ...proposals.map(
      (proposal) =>
        `proposal_id=${proposal.proposal_id} date=${proposal.date} candidates=${proposal.candidates} size_bytes=${proposal.size_bytes} path=${proposal.proposal_path}`
    )
  ].join("\n");
}

export function formatCleanupProposal(proposal: CleanupProposal): string {
  return [
    "Kairon cleanup proposal:",
    `proposal_id=${proposal.proposal_id ?? proposal.date}`,
    `date=${proposal.date}`,
    `proposal_path=${proposal.proposal_path}`,
    `direct_delete=${proposal.direct_delete}`,
    `candidates=${proposal.candidates.length}`,
    ...(proposal.retention_summary === undefined
      ? []
      : [
          `retention.scanned=${proposal.retention_summary.scanned_items}`,
          `retention.protected=${proposal.retention_summary.protected_items}`,
          `retention.candidates=${proposal.retention_summary.candidates}`,
          `retention.candidate_bytes=${proposal.retention_summary.candidate_bytes}`,
          `retention.skipped_symbolic_links=${proposal.retention_summary.skipped_symbolic_links}`
        ]),
    ...proposal.candidates.map(
      (candidate) => {
        const retention =
          candidate.category === undefined
            ? ""
            : ` category=${candidate.category} age_days=${candidate.age_days}`;
        return `candidate=${candidate.id} kind=${candidate.kind} path=${candidate.path} action=${candidate.proposed_action} destination=${candidate.destination} size_bytes=${candidate.size_bytes}${retention} reason=${candidate.reason}`;
      }
    )
  ].join("\n");
}

export function formatCleanupRetentionPlan(
  result: CleanupRetentionPlanResult
): string {
  const proposal = result.proposal;
  const summary = proposal.retention_summary;
  return [
    result.dry_run
      ? "Kairon cleanup retention dry run."
      : "Kairon cleanup retention proposal created.",
    `proposal_id=${proposal.proposal_id}`,
    `proposal_path=${proposal.proposal_path}`,
    `written=${result.written}`,
    `retention.scanned=${summary?.scanned_items ?? 0}`,
    `retention.protected=${summary?.protected_items ?? 0}`,
    `retention.candidates=${summary?.candidates ?? 0}`,
    `retention.candidate_bytes=${summary?.candidate_bytes ?? 0}`,
    `retention.skipped_symbolic_links=${summary?.skipped_symbolic_links ?? 0}`,
    ...proposal.candidates.map(
      (candidate) =>
        `- ${candidate.id} category=${candidate.category} path=${candidate.path} age_days=${candidate.age_days} size_bytes=${candidate.size_bytes} reason=${candidate.reason}`
    )
  ].join("\n");
}

export function formatCleanupApplyResult(result: CleanupApplyResult): string {
  const lines = [
    result.dry_run
      ? "Kairon cleanup apply dry run."
      : "Kairon cleanup proposal applied.",
    `proposal_date=${result.proposal_date}`,
    `proposal_path=${result.proposal_path}`,
    `dry_run=${result.dry_run}`,
    `applied=${result.applied}`,
    `moved=${result.moved}`,
    `planned=${result.planned}`,
    `missing=${result.missing}`,
    `blocked=${result.blocked}`
  ];

  if (result.artifact_path !== undefined) {
    lines.push(`artifact=${result.artifact_path}`);
  }

  lines.push(
    ...result.candidates.map((candidate) => {
      const reason =
        candidate.reason === undefined ? "" : ` reason=${candidate.reason}`;
      return `- ${candidate.id} ${candidate.status} ${candidate.path} -> ${candidate.destination}${reason}`;
    })
  );

  return lines.join("\n");
}

export function formatCleanupArchiveResult(result: CleanupArchiveResult): string {
  return [
    "Kairon cleanup proposal archived.",
    `proposal_date=${result.proposal_date}`,
    `proposal_path=${result.proposal_path}`,
    `archived_path=${result.archived_path}`
  ].join("\n");
}
