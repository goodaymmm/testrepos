import {
  formatOperationTestCommandProfiles,
  resolveOperationTestCommandProfiles
} from "../../operation-test/command-profiles.js";
import {
  formatOperationTestDocGenerationResult,
  writeOperationTestDocs
} from "../../operation-test/test-doc-generator.js";

export type GenerateOperationTestCommandsOptions = {
  profile?: string[];
  range?: string;
  format?: string;
};

export type GenerateOperationTestDocsOptions = {
  range?: string;
  outputDir?: string;
  namePrefix?: string;
  overwrite?: boolean;
  dryRun?: boolean;
};

export function generateOperationTestCommandsCommand(
  options: GenerateOperationTestCommandsOptions = {}
): string {
  const format = normalizeFormat(options.format);
  const resolution = resolveOperationTestCommandProfiles({
    profiles: options.profile,
    range: options.range,
    format
  });

  return formatOperationTestCommandProfiles(resolution, format);
}

export async function generateOperationTestDocsCommand(
  projectRoot: string,
  options: GenerateOperationTestDocsOptions = {}
): Promise<string> {
  if (options.range === undefined || options.range.trim().length === 0) {
    throw new Error("Specify --range, for example --range T130-T143.");
  }

  const result = await writeOperationTestDocs(projectRoot, {
    range: options.range,
    outputDir: options.outputDir,
    namePrefix: options.namePrefix,
    overwrite: options.overwrite,
    dryRun: options.dryRun
  });

  return formatOperationTestDocGenerationResult(result);
}

function normalizeFormat(value: string | undefined): "powershell" | "json" {
  if (value === undefined || value.trim().length === 0) {
    return "powershell";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "powershell" || normalized === "json") {
    return normalized;
  }

  throw new Error(`Invalid --format: ${value}. Expected powershell or json.`);
}
