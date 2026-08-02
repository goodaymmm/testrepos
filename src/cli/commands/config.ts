import {
  applyConfigProposal,
  createConfigProposal,
  formatConfigProposalApplyResult,
  formatConfigProposalCreateResult
} from "../../core/config/config-proposals.js";

export type ConfigApplyCommandOptions = {
  dryRun?: boolean;
};

export async function proposeConfig(projectRoot: string): Promise<string> {
  return formatConfigProposalCreateResult(
    await createConfigProposal({ projectRoot })
  );
}

export async function applyConfig(
  projectRoot: string,
  proposalId: string,
  options: ConfigApplyCommandOptions = {}
): Promise<string> {
  return formatConfigProposalApplyResult(
    await applyConfigProposal({
      projectRoot,
      proposalId,
      dryRun: options.dryRun
    })
  );
}
