import {
  applyCleanupProposal,
  archiveCleanupProposal,
  listCleanupProposals,
  readCleanupProposalById,
  type CleanupApplyResult,
  type CleanupArchiveResult,
  type CleanupProposal,
  type CleanupProposalSummary
} from "../../maintenance/cleanup-proposals.js";

export type CleanupApplyCommandOptions = {
  dryRun?: boolean;
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

export function formatCleanupProposalList(proposals: CleanupProposalSummary[]): string {
  if (proposals.length === 0) {
    return "No Kairon cleanup proposals found.";
  }

  return [
    "Kairon cleanup proposals:",
    ...proposals.map(
      (proposal) =>
        `date=${proposal.date} candidates=${proposal.candidates} size_bytes=${proposal.size_bytes} path=${proposal.proposal_path}`
    )
  ].join("\n");
}

export function formatCleanupProposal(proposal: CleanupProposal): string {
  return [
    "Kairon cleanup proposal:",
    `date=${proposal.date}`,
    `proposal_path=${proposal.proposal_path}`,
    `direct_delete=${proposal.direct_delete}`,
    `candidates=${proposal.candidates.length}`,
    ...proposal.candidates.map(
      (candidate) =>
        `candidate=${candidate.id} kind=${candidate.kind} path=${candidate.path} action=${candidate.proposed_action} destination=${candidate.destination} size_bytes=${candidate.size_bytes}`
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
    ...result.candidates.map(
      (candidate) =>
        `- ${candidate.id} ${candidate.status} ${candidate.path} -> ${candidate.destination}`
    )
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
