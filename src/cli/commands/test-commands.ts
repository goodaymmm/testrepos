import {
  formatOperationTestCommandProfiles,
  resolveOperationTestCommandProfiles
} from "../../operation-test/command-profiles.js";
import {
  formatOperationTestDocGenerationResult,
  writeOperationTestDocs
} from "../../operation-test/test-doc-generator.js";
import { summarizeOperationTestResults } from "../../operation-test/result-summary.js";
import {
  createOperationEvidenceCatalog,
  formatOperationEvidenceCatalog,
  formatOperationEvidenceList,
  formatOperationEvidenceVerification,
  listOperationEvidence,
  verifyOperationEvidenceCatalog
} from "../../operation-test/evidence-catalog.js";
import { spawnCommandRunner } from "../../agents/command-runner.js";
import {
  finalizeStableCanary,
  formatStableCanaryFinalization,
  formatStableCanaryPreparation,
  prepareStableCanary,
  type StableCanaryDependencies
} from "../../operation-test/stable-canary.js";

export type GenerateOperationTestCommandsOptions = {
  profile?: string[];
  range?: string;
  format?: string;
};

export type GenerateOperationTestDocsOptions = {
  range?: string;
  outputDir?: string;
  namePrefix?: string;
  template?: string;
  resultRoot?: string;
  sourceCommit?: string;
  previousResultRoot?: string;
  overwrite?: boolean;
  dryRun?: boolean;
};

export type PrepareStableCanaryCommandOptions = {
  verification?: string;
  output?: string;
  nodeRuntimeRoot?: string;
  gitRuntimeRoot?: string;
  fixture?: string;
  timeoutSeconds?: string;
  keepOnFailure?: boolean;
  credentialProvider?: string;
  format?: string;
};

export type FinalizeStableCanaryCommandOptions = {
  input?: string;
  format?: string;
};

export type OperationEvidenceCatalogCommandOptions = {
  resultRoot?: string[];
  testList?: string[];
  output?: string;
  freshnessHours?: string;
  format?: string;
};

export type OperationEvidenceListCommandOptions = {
  catalog?: string;
  task?: string;
  testId?: string;
  status?: string;
  integrity?: string;
  format?: string;
};

export type OperationEvidenceVerifyCommandOptions = {
  catalog?: string;
  format?: string;
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

  const template = normalizeTemplate(options.template);
  const sourceCommit =
    template === "stable-acceptance"
      ? options.sourceCommit ?? (await resolveSourceCommit(projectRoot))
      : options.sourceCommit;
  const previousSummary =
    template === "stable-acceptance" && options.previousResultRoot !== undefined
      ? await summarizeOperationTestResults({
          projectRoot,
          resultRoot: options.previousResultRoot
        })
      : undefined;

  const result = await writeOperationTestDocs(projectRoot, {
    range: options.range,
    outputDir: options.outputDir,
    namePrefix: options.namePrefix,
    template,
    resultRoot: options.resultRoot,
    sourceCommit,
    previousResultRoot: options.previousResultRoot,
    previousPassIds:
      previousSummary === undefined
        ? undefined
        : previousSummary.pass_ids.filter(
            (id) =>
              !previousSummary.fail_ids.includes(id) &&
              !previousSummary.setup_required_ids.includes(id) &&
              !previousSummary.optional_ids.includes(id)
          ),
    overwrite: options.overwrite,
    dryRun: options.dryRun
  });

  return formatOperationTestDocGenerationResult(result);
}

export async function prepareStableCanaryCommand(
  projectRoot: string,
  options: PrepareStableCanaryCommandOptions,
  deps: StableCanaryDependencies = {}
): Promise<string> {
  if (
    options.nodeRuntimeRoot === undefined ||
    options.nodeRuntimeRoot.trim().length === 0
  ) {
    throw new Error("Specify --node-runtime-root for the clean Windows canary.");
  }
  if (
    options.gitRuntimeRoot === undefined ||
    options.gitRuntimeRoot.trim().length === 0
  ) {
    throw new Error("Specify --git-runtime-root for the clean Windows canary.");
  }
  const format = normalizeTextJsonFormat(options.format);
  const preparation = await prepareStableCanary(projectRoot, {
    verificationPath: options.verification,
    outputRoot: options.output,
    nodeRuntimeRoot: options.nodeRuntimeRoot,
    gitRuntimeRoot: options.gitRuntimeRoot,
    fixturePath: options.fixture,
    timeoutSeconds: parseOptionalInteger(
      options.timeoutSeconds,
      "--timeout-seconds"
    ),
    keepOnFailure: options.keepOnFailure,
    credentialProvider: options.credentialProvider
  }, deps);
  return formatStableCanaryPreparation(preparation, projectRoot, format);
}

export async function finalizeStableCanaryCommand(
  projectRoot: string,
  options: FinalizeStableCanaryCommandOptions,
  deps: StableCanaryDependencies = {}
): Promise<{ text: string; ok: boolean }> {
  if (options.input === undefined || options.input.trim().length === 0) {
    throw new Error("Specify --input for the Stable canary finalization.");
  }
  const format = normalizeTextJsonFormat(options.format);
  const finalization = await finalizeStableCanary(
    projectRoot,
    options.input,
    deps
  );
  return {
    text: formatStableCanaryFinalization(finalization, projectRoot, format),
    ok: finalization.result.status === "PASS"
  };
}

export async function createOperationEvidenceCatalogCommand(
  projectRoot: string,
  options: OperationEvidenceCatalogCommandOptions
): Promise<string> {
  const result = await createOperationEvidenceCatalog(projectRoot, {
    resultRoots: options.resultRoot ?? [],
    testLists: options.testList,
    output: options.output,
    freshnessHours: parseOptionalInteger(
      options.freshnessHours,
      "--freshness-hours"
    )
  });
  return normalizeTextJsonFormat(options.format) === "json"
    ? JSON.stringify(result, null, 2)
    : formatOperationEvidenceCatalog(result);
}

export async function listOperationEvidenceCommand(
  projectRoot: string,
  options: OperationEvidenceListCommandOptions = {}
): Promise<string> {
  const entries = await listOperationEvidence(
    projectRoot,
    options.catalog,
    options
  );
  return normalizeTextJsonFormat(options.format) === "json"
    ? JSON.stringify(entries, null, 2)
    : formatOperationEvidenceList(entries);
}

export async function verifyOperationEvidenceCatalogCommand(
  projectRoot: string,
  catalogPath: string,
  options: OperationEvidenceVerifyCommandOptions = {}
): Promise<{ text: string; ok: boolean }> {
  const verification = await verifyOperationEvidenceCatalog(
    projectRoot,
    catalogPath
  );
  return {
    text:
      normalizeTextJsonFormat(options.format) === "json"
        ? JSON.stringify(verification, null, 2)
        : formatOperationEvidenceVerification(verification),
    ok: verification.status === "PASS"
  };
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

function normalizeTemplate(
  value: string | undefined
): "generic" | "stable-acceptance" {
  if (value === undefined || value.trim().length === 0) {
    return "generic";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "generic" || normalized === "stable-acceptance") {
    return normalized;
  }
  throw new Error(
    `Invalid --template: ${value}. Expected generic or stable-acceptance.`
  );
}

function normalizeTextJsonFormat(
  value: string | undefined
): "text" | "json" {
  if (value === undefined || value.trim().length === 0) {
    return "text";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "text" || normalized === "json") {
    return normalized;
  }
  throw new Error(`Invalid --format: ${value}. Expected text or json.`);
}

function parseOptionalInteger(
  value: string | undefined,
  optionName: string
): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  if (!/^\d+$/u.test(value.trim())) {
    throw new Error(`${optionName} must be an integer.`);
  }
  return Number.parseInt(value.trim(), 10);
}

async function resolveSourceCommit(projectRoot: string): Promise<string> {
  const status = await spawnCommandRunner({
    command: "git",
    args: ["status", "--porcelain", "--untracked-files=no"],
    cwd: projectRoot
  });
  if (status.exitCode !== 0 || status.timedOut) {
    throw new Error(
      "Stable acceptance generation could not inspect the tracked source state."
    );
  }
  if (status.stdout.trim().length > 0) {
    throw new Error(
      "Stable acceptance generation requires a clean tracked source checkout."
    );
  }

  const result = await spawnCommandRunner({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: projectRoot
  });
  const commit = result.stdout.trim().toLowerCase();
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    !/^[a-f0-9]{40,64}$/u.test(commit)
  ) {
    throw new Error("Stable acceptance generation requires a valid Git HEAD commit.");
  }
  return commit;
}
