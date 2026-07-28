import { createHash, randomUUID } from "node:crypto";
import {
  access,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  readJsonFile,
  writeJsonFileAtomic
} from "../core/fs/json-file.js";
import { resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  inspectLatestStableReleaseVerification,
  type StableReleaseVerificationAsset,
  type StableReleaseVerificationResult
} from "../release/stable-verification.js";

export type StableCanaryStatus = "PASS" | "FAIL" | "SETUP_REQUIRED";

export type StableCanaryCheckStatus =
  | "pass"
  | "fail"
  | "setup_required";

export type StableCanaryCheckId =
  | "runtime_prerequisites"
  | "stable_artifact_download"
  | "consumer_verification"
  | "package_install"
  | "installed_version"
  | "project_initialize"
  | "doctor"
  | "state_integrity"
  | "read_only_command"
  | "package_uninstall"
  | "project_state_retained"
  | "sandbox_cleanup";

export type StableCanaryCheck = {
  id: StableCanaryCheckId;
  status: StableCanaryCheckStatus;
  reason: string;
  remediation?: string;
};

export type StableCanaryInputManifest = {
  schema_version: "0.1";
  artifact_kind: "stable_canary_input";
  canary_id: string;
  source_verification: {
    verification_id: string;
    state_digest: string;
    repository: string;
    base_branch: string;
    version: string;
    tag: string;
    release_id: number;
    target_commit_sha: string;
    assets: StableReleaseVerificationAsset[];
  };
  download: {
    base_url: string;
    authentication: "public_release";
    credential_provider: string | null;
  };
  runtime: {
    strategy: "mapped_read_only";
    node_root: "C:\\KaironCanary\\runtime\\node";
    node_command: string;
    npm_command: string;
    git_root: "C:\\KaironCanary\\runtime\\git";
    git_command: string;
  };
  fixture: {
    profile: "generated" | "mapped";
    root: "C:\\KaironCanary\\work\\fixture";
    source_root: "C:\\KaironCanary\\fixture" | null;
  };
  sandbox: {
    shared_root: "C:\\KaironCanary\\shared";
    result_path: "C:\\KaironCanary\\shared\\sandbox-result.json";
    timeout_seconds: number;
    keep_on_failure: boolean;
    auto_close: true;
  };
  created_at: string;
  expires_at: string;
  state_digest: string;
};

export type StableCanarySandboxResult = {
  schema_version: "0.1";
  artifact_kind: "stable_canary_sandbox_result";
  canary_id: string;
  input_state_digest: string;
  status: StableCanaryStatus;
  source_release: {
    verification_id: string;
    repository: string;
    version: string;
    tag: string;
    release_id: number;
    target_commit_sha: string;
  };
  sandbox: {
    started_at: string;
    finished_at: string;
    duration_ms: number;
  };
  checks: StableCanaryCheck[];
  installed_version: string | null;
  doctor_ok: boolean | null;
  state_status: string | null;
  project_state_retained: boolean;
  cleanup: {
    package_removed: boolean;
    work_directory_removed: boolean;
    credential_persisted: false;
    process_spawned: false;
  };
  sanitized_command_ids: string[];
  reasons: string[];
  remediation: string[];
};

export type StableCanaryFinalResult = {
  schema_version: "0.1";
  artifact_kind: "stable_canary_final_result";
  finalization_id: string;
  canary_id: string;
  status: StableCanaryStatus;
  source_verification_id: string;
  source_state_digest: string;
  source_release_id: number;
  version: string;
  sandbox_result_status: StableCanaryStatus | "missing" | "invalid";
  sandbox_result_sha256: string | null;
  checks: StableCanaryCheck[];
  cleanup: {
    unknown_sandbox_terminated: false;
    host_cache_created: false;
    host_credential_persisted: false;
    sandbox_work_directory_removed: boolean | null;
    package_removed: boolean | null;
  };
  reasons: string[];
  remediation: string[];
  finalized_at: string;
};

export type PrepareStableCanaryInput = {
  verificationPath?: string;
  outputRoot?: string;
  nodeRuntimeRoot: string;
  gitRuntimeRoot: string;
  fixturePath?: string;
  timeoutSeconds?: number;
  keepOnFailure?: boolean;
  credentialProvider?: string;
};

export type StableCanaryPreparation = {
  manifest: StableCanaryInputManifest;
  output_root: string;
  manifest_path: string;
  bootstrap_path: string;
  sandbox_config_path: string;
  sandbox_result_path: string;
  final_result_path: string;
};

export type StableCanaryFinalization = {
  result: StableCanaryFinalResult;
  result_path: string;
};

export type StableCanaryDependencies = {
  now?: () => Date;
};

const defaultTimeoutSeconds = 30 * 60;
const inputLifetimeMs = 60 * 60_000;
const sandboxSharedRoot = "C:\\KaironCanary\\shared" as const;
const sandboxResultPath =
  "C:\\KaironCanary\\shared\\sandbox-result.json" as const;
const sandboxNodeRoot = "C:\\KaironCanary\\runtime\\node" as const;
const sandboxGitRoot = "C:\\KaironCanary\\runtime\\git" as const;
const expectedCheckIds: StableCanaryCheckId[] = [
  "runtime_prerequisites",
  "stable_artifact_download",
  "consumer_verification",
  "package_install",
  "installed_version",
  "project_initialize",
  "doctor",
  "state_integrity",
  "read_only_command",
  "package_uninstall",
  "project_state_retained",
  "sandbox_cleanup"
];

export async function prepareStableCanary(
  projectRoot: string,
  input: PrepareStableCanaryInput,
  deps: StableCanaryDependencies = {}
): Promise<StableCanaryPreparation> {
  const root = path.resolve(projectRoot);
  const now = deps.now?.() ?? new Date();
  const verification = await resolveStableVerification(
    root,
    input.verificationPath,
    now
  );
  const nodeRuntimeRoot = await validateRuntimeRoot(
    input.nodeRuntimeRoot,
    ["node.exe"]
  );
  const nodeCommand = await resolveRuntimeCommand(
    nodeRuntimeRoot,
    ["node.exe"]
  );
  const npmCommand = await resolveRuntimeCommand(
    nodeRuntimeRoot,
    ["npm.cmd", "npm.ps1", path.join("node_modules", "npm", "bin", "npm-cli.js")]
  );
  const gitRuntimeRoot = await validateRuntimeRoot(
    input.gitRuntimeRoot,
    [path.join("cmd", "git.exe"), path.join("bin", "git.exe"), "git.exe"]
  );
  const gitCommand = await resolveRuntimeCommand(
    gitRuntimeRoot,
    [path.join("cmd", "git.exe"), path.join("bin", "git.exe"), "git.exe"]
  );
  const fixturePath =
    input.fixturePath === undefined
      ? undefined
      : await validateDirectory(input.fixturePath, "Stable canary fixture");
  const timeoutSeconds = normalizeTimeout(input.timeoutSeconds);
  const credentialProvider = normalizeOptionalLabel(input.credentialProvider);

  const manifestWithoutDigest = {
    schema_version: "0.1" as const,
    artifact_kind: "stable_canary_input" as const,
    source_verification: {
      verification_id: verification.verification_id,
      state_digest: verification.state_digest,
      repository: verification.repository,
      base_branch: verification.base_branch,
      version: verification.version,
      tag: verification.tag,
      release_id: verification.release_id as number,
      target_commit_sha: verification.target_commit_sha as string,
      assets: verification.assets.map((asset) => ({ ...asset }))
    },
    download: {
      base_url: buildReleaseDownloadBaseUrl(
        verification.repository,
        verification.tag
      ),
      authentication: "public_release" as const,
      credential_provider: credentialProvider
    },
    runtime: {
      strategy: "mapped_read_only" as const,
      node_root: sandboxNodeRoot,
      node_command: toSandboxRuntimePath(
        sandboxNodeRoot,
        nodeRuntimeRoot,
        nodeCommand
      ),
      npm_command: toSandboxRuntimePath(
        sandboxNodeRoot,
        nodeRuntimeRoot,
        npmCommand
      ),
      git_root: sandboxGitRoot,
      git_command: toSandboxRuntimePath(
        sandboxGitRoot,
        gitRuntimeRoot,
        gitCommand
      )
    },
    fixture: {
      profile: fixturePath === undefined ? "generated" as const : "mapped" as const,
      root: "C:\\KaironCanary\\work\\fixture" as const,
      source_root: fixturePath === undefined
        ? null
        : "C:\\KaironCanary\\fixture" as const
    },
    sandbox: {
      shared_root: sandboxSharedRoot,
      result_path: sandboxResultPath,
      timeout_seconds: timeoutSeconds,
      keep_on_failure: input.keepOnFailure ?? false,
      auto_close: true as const
    },
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + inputLifetimeMs).toISOString()
  };
  const inputDigest = digestJson(manifestWithoutDigest);
  const canaryId =
    `SCN-${formatTimestamp(now)}-${inputDigest.slice(0, 12)}`;
  const manifestBase = {
    ...manifestWithoutDigest,
    canary_id: canaryId
  };
  const manifest: StableCanaryInputManifest = {
    ...manifestBase,
    state_digest: digestJson(manifestBase)
  };
  const outputRoot = resolveCanaryOutputRoot(
    root,
    input.outputRoot,
    canaryId
  );
  const manifestPath = resolveInside(outputRoot, "input.json");
  const bootstrapPath = resolveInside(outputRoot, "bootstrap.ps1");
  const sandboxConfigPath = resolveInside(outputRoot, "stable-canary.wsb");
  const hostSandboxResultPath = resolveInside(outputRoot, "sandbox-result.json");
  const finalResultPath = resolveInside(outputRoot, "final-result.json");

  await ensureFilesDoNotExist([
    manifestPath,
    bootstrapPath,
    sandboxConfigPath,
    hostSandboxResultPath,
    finalResultPath
  ]);
  await writeJsonFileAtomic(manifestPath, manifest);
  await writeTextAtomic(bootstrapPath, stableCanaryBootstrapPowerShell());
  await writeTextAtomic(
    sandboxConfigPath,
    buildWindowsSandboxConfig({
      sharedRoot: outputRoot,
      nodeRuntimeRoot,
      gitRuntimeRoot,
      fixturePath
    })
  );

  return {
    manifest,
    output_root: outputRoot,
    manifest_path: manifestPath,
    bootstrap_path: bootstrapPath,
    sandbox_config_path: sandboxConfigPath,
    sandbox_result_path: hostSandboxResultPath,
    final_result_path: finalResultPath
  };
}

export async function finalizeStableCanary(
  projectRoot: string,
  inputPath: string,
  deps: StableCanaryDependencies = {}
): Promise<StableCanaryFinalization> {
  const root = path.resolve(projectRoot);
  const resolvedInputPath = resolveUserPath(root, inputPath);
  const manifest = await readJsonFile<unknown>(resolvedInputPath);
  if (!isStableCanaryInputManifest(manifest)) {
    throw new Error("Stable canary input manifest is invalid.");
  }
  if (manifest.state_digest !== computeInputStateDigest(manifest)) {
    throw new Error("Stable canary input manifest digest does not match.");
  }

  const outputRoot = path.dirname(resolvedInputPath);
  const sandboxResultPath = resolveInside(outputRoot, "sandbox-result.json");
  const finalResultPath = resolveInside(outputRoot, "final-result.json");
  const finalizedAt = deps.now?.() ?? new Date();
  const checks: StableCanaryCheck[] = [];
  let sandboxResult: StableCanarySandboxResult | undefined;
  let sandboxResultBytes: Buffer | undefined;
  let sandboxResultStatus: StableCanaryFinalResult["sandbox_result_status"] =
    "missing";

  try {
    sandboxResultBytes = await readFile(sandboxResultPath);
    const parsed = JSON.parse(sandboxResultBytes.toString("utf8")) as unknown;
    if (isStableCanarySandboxResult(parsed)) {
      sandboxResult = parsed;
      sandboxResultStatus = parsed.status;
    } else {
      sandboxResultStatus = "invalid";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      sandboxResultStatus = "invalid";
    }
  }

  if (sandboxResult === undefined) {
    checks.push({
      id: "sandbox_cleanup",
      status:
        sandboxResultStatus === "missing" ? "setup_required" : "fail",
      reason:
        sandboxResultStatus === "missing"
          ? "sandbox_result_missing"
          : "sandbox_result_invalid",
      remediation:
        sandboxResultStatus === "missing"
          ? "run the generated Windows Sandbox profile and finalize again"
          : "discard the invalid result and rerun the generated canary profile"
    });
  } else {
    checks.push(...sandboxResult.checks.map((entry) => ({ ...entry })));
    const bindingValid =
      sandboxResult.canary_id === manifest.canary_id &&
      sandboxResult.input_state_digest === manifest.state_digest &&
      sandboxResult.source_release.verification_id ===
        manifest.source_verification.verification_id &&
      sandboxResult.source_release.repository ===
        manifest.source_verification.repository &&
      sandboxResult.source_release.release_id ===
        manifest.source_verification.release_id &&
      sandboxResult.source_release.version ===
        manifest.source_verification.version &&
      sandboxResult.source_release.tag === manifest.source_verification.tag &&
      sandboxResult.source_release.target_commit_sha ===
        manifest.source_verification.target_commit_sha;
    if (!bindingValid) {
      checks.push({
        id: "sandbox_cleanup",
        status: "fail",
        reason: "sandbox_result_source_binding_mismatch",
        remediation: "rerun the canary from the generated input manifest"
      });
    }
    const checkCounts = new Map<StableCanaryCheckId, number>();
    for (const entry of sandboxResult.checks) {
      checkCounts.set(entry.id, (checkCounts.get(entry.id) ?? 0) + 1);
    }
    if (containsSecretMaterial(sandboxResult)) {
      checks.push({
        id: "sandbox_cleanup",
        status: "fail",
        reason: "sandbox_result_contains_secret_material",
        remediation: "remove the unsafe result and inspect the canary harness"
      });
    }
    const missingChecks = expectedCheckIds.filter(
      (id) => (checkCounts.get(id) ?? 0) === 0
    );
    const duplicateChecks = expectedCheckIds.filter(
      (id) => (checkCounts.get(id) ?? 0) > 1
    );
    if (missingChecks.length > 0 || duplicateChecks.length > 0) {
      checks.push({
        id: "sandbox_cleanup",
        status: "fail",
        reason: "sandbox_result_check_contract_incomplete",
        remediation: [
          missingChecks.length === 0
            ? undefined
            : `missing checks: ${missingChecks.join(",")}`,
          duplicateChecks.length === 0
            ? undefined
            : `duplicate checks: ${duplicateChecks.join(",")}`
        ].filter((entry): entry is string => entry !== undefined).join("; ")
      });
    }
    const startedAt = Date.parse(sandboxResult.sandbox.started_at);
    const finishedAt = Date.parse(sandboxResult.sandbox.finished_at);
    const measuredDuration = finishedAt - startedAt;
    const inputExpiresAt = Date.parse(manifest.expires_at);
    const timeContractValid =
      Number.isFinite(startedAt) &&
      Number.isFinite(finishedAt) &&
      finishedAt >= startedAt &&
      Math.abs(measuredDuration - sandboxResult.sandbox.duration_ms) <= 1_000;
    if (!timeContractValid) {
      checks.push({
        id: "sandbox_cleanup",
        status: "fail",
        reason: "sandbox_result_time_contract_invalid",
        remediation: "discard the result and rerun the generated canary profile"
      });
    } else if (
      startedAt > inputExpiresAt ||
      measuredDuration > manifest.sandbox.timeout_seconds * 1_000
    ) {
      checks.push({
        id: "sandbox_cleanup",
        status: "setup_required",
        reason: "sandbox_execution_timeout",
        remediation: "prepare a fresh canary input and verify Sandbox capacity"
      });
    }
    const resultContractValid =
      sandboxResult.status === summarizeCanaryChecks(sandboxResult.checks) &&
      sandboxResult.installed_version ===
        manifest.source_verification.version &&
      typeof sandboxResult.doctor_ok === "boolean" &&
      sandboxResult.state_status === "ok" &&
      sandboxResult.cleanup.package_removed &&
      sandboxResult.cleanup.credential_persisted === false &&
      sandboxResult.cleanup.process_spawned === false &&
      sandboxResult.project_state_retained;
    if (!resultContractValid) {
      checks.push({
        id: "sandbox_cleanup",
        status: "fail",
        reason: "sandbox_result_cleanup_contract_failed",
        remediation: "discard the Sandbox and inspect package/state cleanup"
      });
    }
  }

  const status = summarizeCanaryChecks(checks);
  const reasons = unique(
    checks
      .filter((entry) => entry.status !== "pass")
      .map((entry) => entry.reason)
  );
  const remediation = unique(
    checks
      .map((entry) => entry.remediation)
      .filter((entry): entry is string => entry !== undefined)
  );
  const resultDigest = digestJson({
    canary_id: manifest.canary_id,
    source_state_digest: manifest.source_verification.state_digest,
    sandbox_result_sha256:
      sandboxResultBytes === undefined ? null : sha256(sandboxResultBytes),
    status,
    checks
  });
  const result: StableCanaryFinalResult = {
    schema_version: "0.1",
    artifact_kind: "stable_canary_final_result",
    finalization_id:
      `SCF-${formatTimestamp(finalizedAt)}-${resultDigest.slice(0, 12)}`,
    canary_id: manifest.canary_id,
    status,
    source_verification_id:
      manifest.source_verification.verification_id,
    source_state_digest: manifest.source_verification.state_digest,
    source_release_id: manifest.source_verification.release_id,
    version: manifest.source_verification.version,
    sandbox_result_status: sandboxResultStatus,
    sandbox_result_sha256:
      sandboxResultBytes === undefined ? null : sha256(sandboxResultBytes),
    checks,
    cleanup: {
      unknown_sandbox_terminated: false,
      host_cache_created: false,
      host_credential_persisted: false,
      sandbox_work_directory_removed:
        sandboxResult?.cleanup.work_directory_removed ?? null,
      package_removed: sandboxResult?.cleanup.package_removed ?? null
    },
    reasons,
    remediation,
    finalized_at: finalizedAt.toISOString()
  };
  await writeJsonFileAtomic(finalResultPath, result);
  return { result, result_path: finalResultPath };
}

export function formatStableCanaryPreparation(
  preparation: StableCanaryPreparation,
  projectRoot: string,
  format: "text" | "json" = "text"
): string {
  if (format === "json") {
    return `${JSON.stringify({
      ...preparation,
      manifest: preparation.manifest
    }, null, 2)}\n`;
  }
  return [
    "Kairon Stable canary prepared.",
    `canary_id=${preparation.manifest.canary_id}`,
    `source_verification_id=${preparation.manifest.source_verification.verification_id}`,
    `repository=${preparation.manifest.source_verification.repository}`,
    `version=${preparation.manifest.source_verification.version}`,
    `timeout_seconds=${preparation.manifest.sandbox.timeout_seconds}`,
    `output_root=${displayPath(projectRoot, preparation.output_root)}`,
    `manifest=${displayPath(projectRoot, preparation.manifest_path)}`,
    `sandbox_config=${displayPath(projectRoot, preparation.sandbox_config_path)}`,
    `sandbox_result=${displayPath(projectRoot, preparation.sandbox_result_path)}`,
    "unknown_sandbox_action=refuse"
  ].join("\n");
}

export function formatStableCanaryFinalization(
  finalization: StableCanaryFinalization,
  projectRoot: string,
  format: "text" | "json" = "text"
): string {
  if (format === "json") {
    return `${JSON.stringify(finalization.result, null, 2)}\n`;
  }
  return [
    "Kairon Stable canary finalized.",
    `status=${finalization.result.status}`,
    `canary_id=${finalization.result.canary_id}`,
    `source_verification_id=${finalization.result.source_verification_id}`,
    `version=${finalization.result.version}`,
    `sandbox_result_status=${finalization.result.sandbox_result_status}`,
    `unknown_sandbox_terminated=${finalization.result.cleanup.unknown_sandbox_terminated}`,
    `result=${displayPath(projectRoot, finalization.result_path)}`,
    ...finalization.result.checks.map(
      (entry) =>
        `${entry.status.toUpperCase()} ${entry.id} reason=${entry.reason}`
    ),
    ...finalization.result.remediation.map(
      (entry) => `remediation=${entry}`
    )
  ].join("\n");
}

function buildWindowsSandboxConfig(input: {
  sharedRoot: string;
  nodeRuntimeRoot: string;
  gitRuntimeRoot: string;
  fixturePath?: string;
}): string {
  const mappedFolders = [
    mappedFolder(input.sharedRoot, sandboxSharedRoot, false),
    mappedFolder(input.nodeRuntimeRoot, sandboxNodeRoot, true),
    mappedFolder(input.gitRuntimeRoot, sandboxGitRoot, true),
    ...(input.fixturePath === undefined
      ? []
      : [mappedFolder(input.fixturePath, "C:\\KaironCanary\\fixture", true)])
  ].join("\n");
  return [
    "<Configuration>",
    "  <VGpu>Disable</VGpu>",
    "  <Networking>Default</Networking>",
    "  <ClipboardRedirection>Disable</ClipboardRedirection>",
    "  <PrinterRedirection>Disable</PrinterRedirection>",
    "  <AudioInput>Disable</AudioInput>",
    "  <VideoInput>Disable</VideoInput>",
    "  <ProtectedClient>Enable</ProtectedClient>",
    "  <MappedFolders>",
    mappedFolders,
    "  </MappedFolders>",
    "  <LogonCommand>",
    "    <Command>powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File C:\\KaironCanary\\shared\\bootstrap.ps1 -InputPath C:\\KaironCanary\\shared\\input.json</Command>",
    "  </LogonCommand>",
    "</Configuration>",
    ""
  ].join("\r\n");
}

function mappedFolder(
  hostFolder: string,
  sandboxFolder: string,
  readOnly: boolean
): string {
  return [
    "    <MappedFolder>",
    `      <HostFolder>${escapeXml(hostFolder)}</HostFolder>`,
    `      <SandboxFolder>${escapeXml(sandboxFolder)}</SandboxFolder>`,
    `      <ReadOnly>${readOnly ? "true" : "false"}</ReadOnly>`,
    "    </MappedFolder>"
  ].join("\n");
}

function stableCanaryBootstrapPowerShell(): string {
  return `param(
  [Parameter(Mandatory = $true)][string]$InputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$inputManifest = Get-Content -LiteralPath $InputPath -Raw -Encoding UTF8 | ConvertFrom-Json
$startedAt = [DateTimeOffset]::UtcNow
$checks = [System.Collections.Generic.List[object]]::new()
$commandIds = [System.Collections.Generic.List[string]]::new()
$installedVersion = $null
$doctorOk = $null
$stateStatus = $null
$projectStateRetained = $false
$packageRemoved = $false
$workDirectoryRemoved = $false
$workRoot = Join-Path $env:TEMP ("kairon-stable-canary-" + $inputManifest.canary_id)
$resultPath = [string]$inputManifest.sandbox.result_path

function Add-CanaryCheck {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][ValidateSet("pass","fail","setup_required")][string]$Status,
    [Parameter(Mandatory = $true)][string]$Reason,
    [string]$Remediation = ""
  )
  $entry = [ordered]@{ id = $Id; status = $Status; reason = $Reason }
  if (-not [string]::IsNullOrWhiteSpace($Remediation)) {
    $entry.remediation = $Remediation
  }
  $checks.Add([pscustomobject]$entry)
}

function Invoke-CanaryCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][string]$Command,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory = ""
  )
  $commandIds.Add($Id)
  $pushed = $false
  if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    Push-Location -LiteralPath $WorkingDirectory
    $pushed = $true
  }
  try {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $output = @(& $Command @Arguments 2>&1)
    $exitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 0 }
    $ErrorActionPreference = $previousPreference
    return [pscustomobject]@{
      exit_code = $exitCode
      output = (($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine)
    }
  } finally {
    if ($pushed) {
      Pop-Location
    }
  }
}

function Write-CanaryResult {
  param([Parameter(Mandatory = $true)][object]$Value)
  $temporary = "$resultPath.tmp"
  $json = $Value | ConvertTo-Json -Depth 40
  [System.IO.File]::WriteAllText(
    $temporary,
    $json + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
  )
  Move-Item -LiteralPath $temporary -Destination $resultPath -Force
}

function Get-CanaryStatus {
  if (@($checks | Where-Object { $_.status -eq "fail" }).Count -gt 0) {
    return "FAIL"
  }
  if (@($checks | Where-Object { $_.status -eq "setup_required" }).Count -gt 0) {
    return "SETUP_REQUIRED"
  }
  return "PASS"
}

try {
  $nodeCommand = [string]$inputManifest.runtime.node_command
  $npmCommand = [string]$inputManifest.runtime.npm_command
  $gitCommand = [string]$inputManifest.runtime.git_command
  if (
    -not (Test-Path -LiteralPath $nodeCommand -PathType Leaf) -or
    -not (Test-Path -LiteralPath $npmCommand -PathType Leaf) -or
    -not (Test-Path -LiteralPath $gitCommand -PathType Leaf)
  ) {
    Add-CanaryCheck "runtime_prerequisites" "setup_required" "mapped_runtime_missing" "map Node.js 22+, npm, and Git into the generated Sandbox profile"
    throw "stable_canary_setup_required"
  }
  $nodeVersion = Invoke-CanaryCommand "runtime_node_version" $nodeCommand @("--version")
  $npmVersion = Invoke-CanaryCommand "runtime_npm_version" $npmCommand @("--version")
  $gitVersion = Invoke-CanaryCommand "runtime_git_version" $gitCommand @("--version")
  if (
    $nodeVersion.exit_code -ne 0 -or
    $npmVersion.exit_code -ne 0 -or
    $gitVersion.exit_code -ne 0 -or
    $nodeVersion.output.Trim() -notmatch '^v(2[2-9]|[3-9][0-9])\\.'
  ) {
    Add-CanaryCheck "runtime_prerequisites" "setup_required" "mapped_runtime_incompatible" "use Node.js 22 or later with npm and Git"
    throw "stable_canary_setup_required"
  }
  Add-CanaryCheck "runtime_prerequisites" "pass" "mapped_runtime_ready"

  New-Item -ItemType Directory -Force $workRoot | Out-Null
  $assetRoot = Join-Path $workRoot "assets"
  New-Item -ItemType Directory -Force $assetRoot | Out-Null
  try {
    foreach ($asset in @($inputManifest.source_verification.assets)) {
      $assetPath = Join-Path $assetRoot ([string]$asset.name)
      $assetUrl = ([string]$inputManifest.download.base_url).TrimEnd("/") + "/" +
        [uri]::EscapeDataString([string]$asset.name)
      $commandIds.Add("download_release_asset")
      Invoke-WebRequest -Uri $assetUrl -UseBasicParsing -OutFile $assetPath
      $actualDigest = (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash.ToLowerInvariant()
      $actualSize = (Get-Item -LiteralPath $assetPath).Length
      if (
        $actualDigest -ne ([string]$asset.sha256).ToLowerInvariant() -or
        $actualSize -ne [int64]$asset.size_bytes
      ) {
        Add-CanaryCheck "stable_artifact_download" "fail" "stable_asset_integrity_mismatch" "discard the canary cache and verify the published Stable release again"
        throw "stable_canary_integrity_failure"
      }
    }
    Add-CanaryCheck "stable_artifact_download" "pass" "stable_assets_downloaded_and_verified"
  } catch {
    if (-not @($checks | Where-Object { $_.id -eq "stable_artifact_download" }).Count) {
      Add-CanaryCheck "stable_artifact_download" "setup_required" "stable_artifact_download_unavailable" "confirm public release access and Sandbox network connectivity"
    }
    throw
  }

  $packageAsset = @($inputManifest.source_verification.assets | Where-Object { $_.name -match '\\.tgz$' })[0]
  $checksumAsset = @($inputManifest.source_verification.assets | Where-Object { $_.name -match '\\.tgz\\.sha256\\.json$' })[0]
  $releaseManifestAsset = @($inputManifest.source_verification.assets | Where-Object { $_.name -eq "release-manifest.json" })[0]
  if ($null -eq $packageAsset -or $null -eq $checksumAsset -or $null -eq $releaseManifestAsset) {
    Add-CanaryCheck "consumer_verification" "fail" "stable_asset_contract_incomplete" "rerun published Stable verification"
    throw "stable_canary_contract_failure"
  }
  $packagePath = Join-Path $assetRoot ([string]$packageAsset.name)
  $checksumPath = Join-Path $assetRoot ([string]$checksumAsset.name)
  $releaseManifestPath = Join-Path $assetRoot ([string]$releaseManifestAsset.name)

  $stageRoot = Join-Path $workRoot "consumer-stage"
  $staged = Invoke-CanaryCommand "consumer_stage_install" $npmCommand @(
    "install", "--prefix", $stageRoot, "--ignore-scripts", "--no-audit", "--no-fund", $packagePath
  )
  $stagedCli = Join-Path $stageRoot "node_modules\\kairon\\dist\\cli\\main.js"
  if ($staged.exit_code -ne 0 -or -not (Test-Path -LiteralPath $stagedCli -PathType Leaf)) {
    Add-CanaryCheck "consumer_verification" "fail" "consumer_stage_install_failed" "inspect the Stable package dependency contract"
    throw "stable_canary_consumer_failure"
  }
  $verified = Invoke-CanaryCommand "consumer_release_verify" $nodeCommand @(
    $stagedCli,
    "release", "verify",
    $packagePath,
    "--manifest", $checksumPath,
    "--release-manifest", $releaseManifestPath,
    "--verification-context", "consumer"
  )
  if ($verified.exit_code -ne 0) {
    Add-CanaryCheck "consumer_verification" "fail" "consumer_release_verification_failed" "rerun Stable verification and inspect the release manifest"
    throw "stable_canary_consumer_failure"
  }
  Add-CanaryCheck "consumer_verification" "pass" "consumer_release_verification_passed"

  $npmPrefix = Join-Path $workRoot "npm-global"
  New-Item -ItemType Directory -Force $npmPrefix | Out-Null
  $env:NPM_CONFIG_PREFIX = $npmPrefix
  $env:PATH = "$npmPrefix;$([string]$inputManifest.runtime.node_root);$([string]$inputManifest.runtime.git_root)\\cmd;$([string]$inputManifest.runtime.git_root)\\bin;$env:PATH"
  $installed = Invoke-CanaryCommand "package_global_install" $npmCommand @(
    "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", $packagePath
  )
  $kaironCommand = Join-Path $npmPrefix "kairon.cmd"
  if ($installed.exit_code -ne 0 -or -not (Test-Path -LiteralPath $kaironCommand -PathType Leaf)) {
    Add-CanaryCheck "package_install" "fail" "global_package_install_failed" "inspect the package global install contract"
    throw "stable_canary_install_failure"
  }
  Add-CanaryCheck "package_install" "pass" "global_package_installed"

  $versionResult = Invoke-CanaryCommand "installed_version" $kaironCommand @("--version")
  $installedVersion = $versionResult.output.Trim()
  if (
    $versionResult.exit_code -ne 0 -or
    $installedVersion -ne [string]$inputManifest.source_verification.version
  ) {
    Add-CanaryCheck "installed_version" "fail" "installed_version_mismatch" "uninstall the package and verify the Stable asset version"
    throw "stable_canary_version_failure"
  }
  Add-CanaryCheck "installed_version" "pass" "installed_version_matches_release"

  $fixtureRoot = [string]$inputManifest.fixture.root
  New-Item -ItemType Directory -Force $fixtureRoot | Out-Null
  if ($inputManifest.fixture.profile -eq "mapped") {
    $fixtureSource = [string]$inputManifest.fixture.source_root
    if (
      [string]::IsNullOrWhiteSpace($fixtureSource) -or
      -not (Test-Path -LiteralPath $fixtureSource -PathType Container)
    ) {
      Add-CanaryCheck "project_initialize" "setup_required" "mapped_fixture_missing" "regenerate the Sandbox profile with a valid fixture directory"
      throw "stable_canary_setup_required"
    }
    Get-ChildItem -LiteralPath $fixtureSource -Force | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $fixtureRoot -Recurse -Force
    }
  }
  New-Item -ItemType Directory -Force (Join-Path $fixtureRoot ".git") | Out-Null
  $initialized = Invoke-CanaryCommand "project_initialize" $kaironCommand @("init") $fixtureRoot
  if ($initialized.exit_code -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $fixtureRoot ".kairon\\project.json"))) {
    Add-CanaryCheck "project_initialize" "fail" "canary_project_initialize_failed" "inspect the generated fixture and init diagnostics"
    throw "stable_canary_project_failure"
  }
  Add-CanaryCheck "project_initialize" "pass" "canary_project_initialized"

  $doctor = Invoke-CanaryCommand "project_doctor" $kaironCommand @("doctor", "--format", "json") $fixtureRoot
  try {
    $doctorResult = $doctor.output | ConvertFrom-Json
    $doctorOk = [bool]$doctorResult.ok
    $requiredDoctorChecks = @("config.validation", "git.repository")
    $doctorContract = @($doctorResult.checks | Where-Object {
      $_.id -in $requiredDoctorChecks -and $_.status -eq "pass"
    }).Count -eq $requiredDoctorChecks.Count
    if ($doctor.exit_code -ne 0 -or -not $doctorContract) {
      throw "doctor_contract_failed"
    }
    Add-CanaryCheck "doctor" "pass" "doctor_contract_completed"
  } catch {
    Add-CanaryCheck "doctor" "fail" "doctor_contract_failed" "inspect the clean canary project doctor checks"
    throw "stable_canary_doctor_failure"
  }

  $state = Invoke-CanaryCommand "state_integrity" $kaironCommand @("state", "check", "--format", "json") $fixtureRoot
  try {
    $stateResult = $state.output | ConvertFrom-Json
    $stateStatus = [string]$stateResult.status
    if ($state.exit_code -ne 0 -or $stateStatus -ne "ok") {
      throw "state_integrity_failed"
    }
    Add-CanaryCheck "state_integrity" "pass" "state_integrity_passed"
  } catch {
    Add-CanaryCheck "state_integrity" "fail" "state_integrity_failed" "inspect the generated .kairon state"
    throw "stable_canary_state_failure"
  }

  $statusResult = Invoke-CanaryCommand "read_only_status" $kaironCommand @("status") $fixtureRoot
  if ($statusResult.exit_code -ne 0) {
    Add-CanaryCheck "read_only_command" "fail" "read_only_status_failed" "inspect the canary status command"
    throw "stable_canary_read_only_failure"
  }
  Add-CanaryCheck "read_only_command" "pass" "read_only_status_completed"

  $uninstalled = Invoke-CanaryCommand "package_global_uninstall" $npmCommand @(
    "uninstall", "--global", "kairon", "--no-audit", "--no-fund"
  )
  $packageRemoved =
    $uninstalled.exit_code -eq 0 -and
    -not (Test-Path -LiteralPath $kaironCommand)
  if (-not $packageRemoved) {
    Add-CanaryCheck "package_uninstall" "fail" "global_package_uninstall_failed" "remove the canary npm prefix before rerunning"
    throw "stable_canary_uninstall_failure"
  }
  Add-CanaryCheck "package_uninstall" "pass" "global_package_uninstalled"

  $projectStateRetained = Test-Path -LiteralPath (Join-Path $fixtureRoot ".kairon\\project.json")
  if (-not $projectStateRetained) {
    Add-CanaryCheck "project_state_retained" "fail" "project_state_removed_by_uninstall" "do not release a package whose uninstall removes project state"
    throw "stable_canary_state_retention_failure"
  }
  Add-CanaryCheck "project_state_retained" "pass" "project_state_retained_after_uninstall"
} catch {
  if (
    @($checks | Where-Object {
      $_.status -eq "fail" -or $_.status -eq "setup_required"
    }).Count -eq 0
  ) {
    Add-CanaryCheck "sandbox_cleanup" "fail" "stable_canary_unclassified_failure" "inspect the canary harness and rerun"
  }
} finally {
  Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:NPM_TOKEN -ErrorAction SilentlyContinue
  if (
    (Get-CanaryStatus) -eq "PASS" -or
    -not [bool]$inputManifest.sandbox.keep_on_failure
  ) {
    Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  $workDirectoryRemoved = -not (Test-Path -LiteralPath $workRoot)
  if (-not @($checks | Where-Object { $_.id -eq "package_uninstall" }).Count) {
    $packageRemoved = -not (Test-Path -LiteralPath (Join-Path $workRoot "npm-global\\kairon.cmd"))
    Add-CanaryCheck "package_uninstall" ($(if ($packageRemoved) { "pass" } else { "fail" })) ($(if ($packageRemoved) { "package_absent_after_failure_cleanup" } else { "package_remains_after_failure" }))
  }
  if (-not @($checks | Where-Object { $_.id -eq "project_state_retained" }).Count) {
    Add-CanaryCheck "project_state_retained" "fail" "state_retention_not_verified" "rerun after resolving the preceding canary failure"
  }
  if ($workDirectoryRemoved) {
    Add-CanaryCheck "sandbox_cleanup" "pass" "sandbox_work_directory_removed"
  } elseif ([bool]$inputManifest.sandbox.keep_on_failure) {
    Add-CanaryCheck "sandbox_cleanup" "pass" "failed_work_directory_retained_by_request"
  } else {
    Add-CanaryCheck "sandbox_cleanup" "fail" "sandbox_work_directory_remains" "close the Sandbox to discard its temporary filesystem"
  }

  $finishedAt = [DateTimeOffset]::UtcNow
  $status = Get-CanaryStatus
  $reasons = @($checks | Where-Object { $_.status -ne "pass" } | ForEach-Object { $_.reason } | Select-Object -Unique)
  $remediation = @($checks | Where-Object { -not [string]::IsNullOrWhiteSpace($_.remediation) } | ForEach-Object { $_.remediation } | Select-Object -Unique)
  $result = [ordered]@{
    schema_version = "0.1"
    artifact_kind = "stable_canary_sandbox_result"
    canary_id = [string]$inputManifest.canary_id
    input_state_digest = [string]$inputManifest.state_digest
    status = $status
    source_release = [ordered]@{
      verification_id = [string]$inputManifest.source_verification.verification_id
      repository = [string]$inputManifest.source_verification.repository
      version = [string]$inputManifest.source_verification.version
      tag = [string]$inputManifest.source_verification.tag
      release_id = [int64]$inputManifest.source_verification.release_id
      target_commit_sha = [string]$inputManifest.source_verification.target_commit_sha
    }
    sandbox = [ordered]@{
      started_at = $startedAt.ToString("o")
      finished_at = $finishedAt.ToString("o")
      duration_ms = [int64]($finishedAt - $startedAt).TotalMilliseconds
    }
    checks = @($checks)
    installed_version = $installedVersion
    doctor_ok = $doctorOk
    state_status = $stateStatus
    project_state_retained = $projectStateRetained
    cleanup = [ordered]@{
      package_removed = $packageRemoved
      work_directory_removed = $workDirectoryRemoved
      credential_persisted = $false
      process_spawned = $false
    }
    sanitized_command_ids = @($commandIds | Select-Object -Unique)
    reasons = $reasons
    remediation = $remediation
  }
  Write-CanaryResult $result
  if ([bool]$inputManifest.sandbox.auto_close) {
    Start-Process -FilePath "$env:SystemRoot\\System32\\shutdown.exe" -ArgumentList @("/s", "/t", "0") -WindowStyle Hidden
  }
}
`;
}

async function resolveStableVerification(
  projectRoot: string,
  verificationPath: string | undefined,
  now: Date
): Promise<StableReleaseVerificationResult> {
  let result: unknown;
  if (verificationPath === undefined) {
    const latest = await inspectLatestStableReleaseVerification(projectRoot);
    if (latest.status !== "available") {
      throw new Error(
        "A valid published Stable verification is required before preparing a canary."
      );
    }
    result = latest.result;
  } else {
    result = await readJsonFile<unknown>(
      resolveUserPath(projectRoot, verificationPath)
    );
  }
  if (!isUsableStableVerification(result, now)) {
    throw new Error(
      "Stable canary requires a fresh PASS verification with five verified assets."
    );
  }
  return result;
}

function isUsableStableVerification(
  value: unknown,
  now: Date
): value is StableReleaseVerificationResult & {
  release_id: number;
  target_commit_sha: string;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<StableReleaseVerificationResult>;
  return candidate.schema_version === "0.1" &&
    candidate.artifact_kind === "stable_release_verification" &&
    candidate.status === "PASS" &&
    candidate.integrity_status === "PASS" &&
    candidate.currentness_status === "PASS" &&
    candidate.execution_performed === false &&
    candidate.manifest?.status === "verified" &&
    candidate.channel_selection?.matches_requested_release === true &&
    typeof candidate.release_id === "number" &&
    candidate.release_id > 0 &&
    typeof candidate.target_commit_sha === "string" &&
    /^[a-f0-9]{40}$/u.test(candidate.target_commit_sha) &&
    Array.isArray(candidate.assets) &&
    candidate.assets.length === 5 &&
    candidate.assets.every(isStableVerificationAsset) &&
    new Set(candidate.assets.map((entry) => entry.id)).size === 5 &&
    new Set(candidate.assets.map((entry) => entry.name)).size === 5 &&
    candidate.manifest?.source_commit === candidate.target_commit_sha &&
    typeof candidate.expires_at === "string" &&
    Date.parse(candidate.expires_at) > now.getTime() &&
    typeof candidate.state_digest === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.state_digest);
}

function isStableVerificationAsset(
  value: unknown
): value is StableReleaseVerificationAsset {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<StableReleaseVerificationAsset>;
  return typeof candidate.id === "number" &&
    candidate.id > 0 &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    path.basename(candidate.name) === candidate.name &&
    typeof candidate.size_bytes === "number" &&
    candidate.size_bytes >= 0 &&
    typeof candidate.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.sha256) &&
    candidate.state === "uploaded";
}

function isStableCanaryInputManifest(
  value: unknown
): value is StableCanaryInputManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<StableCanaryInputManifest>;
  return candidate.schema_version === "0.1" &&
    candidate.artifact_kind === "stable_canary_input" &&
    typeof candidate.canary_id === "string" &&
    /^SCN-\d{14}-[a-f0-9]{12}$/u.test(candidate.canary_id) &&
    typeof candidate.state_digest === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.state_digest) &&
    candidate.source_verification !== undefined &&
    typeof candidate.source_verification.verification_id === "string" &&
    typeof candidate.source_verification.release_id === "number" &&
    candidate.sandbox?.result_path === sandboxResultPath;
}

function isStableCanarySandboxResult(
  value: unknown
): value is StableCanarySandboxResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<StableCanarySandboxResult>;
  return candidate.schema_version === "0.1" &&
    candidate.artifact_kind === "stable_canary_sandbox_result" &&
    typeof candidate.canary_id === "string" &&
    typeof candidate.input_state_digest === "string" &&
    isCanaryStatus(candidate.status) &&
    candidate.source_release !== undefined &&
    typeof candidate.source_release.verification_id === "string" &&
    typeof candidate.source_release.repository === "string" &&
    typeof candidate.source_release.version === "string" &&
    typeof candidate.source_release.tag === "string" &&
    typeof candidate.source_release.release_id === "number" &&
    typeof candidate.source_release.target_commit_sha === "string" &&
    candidate.sandbox !== undefined &&
    !Number.isNaN(Date.parse(candidate.sandbox.started_at)) &&
    !Number.isNaN(Date.parse(candidate.sandbox.finished_at)) &&
    typeof candidate.sandbox.duration_ms === "number" &&
    candidate.sandbox.duration_ms >= 0 &&
    Array.isArray(candidate.checks) &&
    candidate.checks.every(isStableCanaryCheck) &&
    Array.isArray(candidate.sanitized_command_ids) &&
    candidate.sanitized_command_ids.every(
      (entry) => typeof entry === "string" && /^[a-z0-9_]+$/u.test(entry)
    ) &&
    candidate.cleanup !== undefined &&
    typeof candidate.cleanup.package_removed === "boolean" &&
    typeof candidate.cleanup.work_directory_removed === "boolean" &&
    candidate.cleanup.credential_persisted === false &&
    candidate.cleanup.process_spawned === false &&
    typeof candidate.project_state_retained === "boolean" &&
    (candidate.installed_version === null ||
      typeof candidate.installed_version === "string") &&
    (candidate.doctor_ok === null ||
      typeof candidate.doctor_ok === "boolean") &&
    (candidate.state_status === null ||
      typeof candidate.state_status === "string");
}

function isStableCanaryCheck(value: unknown): value is StableCanaryCheck {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<StableCanaryCheck>;
  return typeof candidate.id === "string" &&
    expectedCheckIds.includes(candidate.id as StableCanaryCheckId) &&
    (candidate.status === "pass" ||
      candidate.status === "fail" ||
      candidate.status === "setup_required") &&
    typeof candidate.reason === "string";
}

function isCanaryStatus(value: unknown): value is StableCanaryStatus {
  return value === "PASS" || value === "FAIL" || value === "SETUP_REQUIRED";
}

function computeInputStateDigest(
  manifest: StableCanaryInputManifest
): string {
  const { state_digest: _, ...withoutDigest } = manifest;
  return digestJson(withoutDigest);
}

function summarizeCanaryChecks(
  checks: StableCanaryCheck[]
): StableCanaryStatus {
  if (checks.some((entry) => entry.status === "fail")) {
    return "FAIL";
  }
  if (checks.some((entry) => entry.status === "setup_required")) {
    return "SETUP_REQUIRED";
  }
  return checks.length > 0 ? "PASS" : "FAIL";
}

function containsSecretMaterial(value: unknown): boolean {
  const serialized = JSON.stringify(value).toLowerCase();
  return /github_pat_|ghp_[a-z0-9]|authorization["']?\s*:|bearer\s+[a-z0-9]/u
    .test(serialized);
}

async function validateRuntimeRoot(
  value: string,
  commandCandidates: string[]
): Promise<string> {
  const root = await validateDirectory(value, "Stable canary runtime");
  await resolveRuntimeCommand(root, commandCandidates);
  return root;
}

async function validateDirectory(
  value: string,
  label: string
): Promise<string> {
  const resolved = path.resolve(value);
  const info = await stat(resolved).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) {
    throw new Error(`${label} directory was not found.`);
  }
  return resolved;
}

async function resolveRuntimeCommand(
  root: string,
  candidates: string[]
): Promise<string> {
  for (const candidate of candidates) {
    const resolved = path.resolve(root, candidate);
    try {
      await access(resolved);
      return resolved;
    } catch {
      // Try the next known runtime layout.
    }
  }
  throw new Error(
    `Stable canary runtime command was not found below ${path.basename(root)}.`
  );
}

async function ensureFilesDoNotExist(filePaths: string[]): Promise<void> {
  for (const filePath of filePaths) {
    try {
      await access(filePath);
      throw new Error(
        "Stable canary output already exists; use a new output directory."
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function toSandboxRuntimePath(
  sandboxRoot: string,
  hostRoot: string,
  hostCommand: string
): string {
  const relative = path.relative(hostRoot, hostCommand);
  if (
    relative.length === 0 ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Stable canary runtime command escapes its mapped root.");
  }
  return path.win32.join(sandboxRoot, ...relative.split(path.sep));
}

function normalizeTimeout(value: number | undefined): number {
  const timeout = value ?? defaultTimeoutSeconds;
  if (!Number.isInteger(timeout) || timeout < 60 || timeout > 86_400) {
    throw new Error(
      "Stable canary timeout must be an integer from 60 to 86400 seconds."
    );
  }
  return timeout;
}

function normalizeOptionalLabel(value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(normalized)) {
    throw new Error("Stable canary credential provider label is invalid.");
  }
  return normalized;
}

function buildReleaseDownloadBaseUrl(
  repository: string,
  tag: string
): string {
  if (
    !/^[^/\s]+\/[^/\s]+$/u.test(repository) ||
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(tag)
  ) {
    throw new Error("Stable canary release identity is invalid.");
  }
  return `https://github.com/${repository}/releases/download/${tag}`;
}

function resolveCanaryOutputRoot(
  projectRoot: string,
  outputRoot: string | undefined,
  canaryId: string
): string {
  if (outputRoot === undefined) {
    return resolveInside(
      projectRoot,
      ".kairon",
      "release",
      "stable-canaries",
      canaryId
    );
  }
  return resolveUserPath(projectRoot, outputRoot);
}

function resolveUserPath(projectRoot: string, value: string): string {
  return path.isAbsolute(value)
    ? path.resolve(value)
    : resolveInside(projectRoot, value);
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw new Error(
      `Failed to write Stable canary file ${path.basename(filePath)}: ${String(error)}`
    );
  }
}

function digestJson(value: unknown): string {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatTimestamp(value: Date): string {
  return value.toISOString().replace(/\D/gu, "").slice(0, 14);
}

function displayPath(projectRoot: string, value: string): string {
  const relative = path.relative(path.resolve(projectRoot), value);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? toPosixPath(relative)
    : value;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
