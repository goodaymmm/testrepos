import {
  checkStateIntegrity,
  formatStateIntegrityCheck
} from "../../state/integrity-check.js";
import {
  collectStateSnapshotDryRun,
  formatStateSnapshotDryRun
} from "../../state/snapshot.js";

export type StateCheckCommandOptions = {
  format?: string;
};

export type StateSnapshotCommandOptions = {
  dryRun?: boolean;
  format?: string;
};

export async function stateCheckCommand(
  projectRoot: string,
  options: StateCheckCommandOptions = {}
): Promise<string> {
  const format = parseStateOutputFormat(options.format);
  const result = await checkStateIntegrity(projectRoot);
  return formatStateIntegrityCheck(result, { format });
}

export async function stateSnapshotCommand(
  projectRoot: string,
  options: StateSnapshotCommandOptions = {}
): Promise<string> {
  if (options.dryRun !== true) {
    return [
      "Kairon state snapshot is not implemented.",
      "status=not_implemented",
      "next_action=rerun with --dry-run to list snapshot targets"
    ].join("\n");
  }

  const format = parseStateOutputFormat(options.format);
  const result = await collectStateSnapshotDryRun(projectRoot);
  return formatStateSnapshotDryRun(result, { format });
}

function parseStateOutputFormat(value: string | undefined): "text" | "json" {
  if (value === undefined || value === "text") {
    return "text";
  }
  if (value === "json") {
    return "json";
  }

  throw new Error(`Invalid state output format: ${value}`);
}
