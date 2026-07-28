import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  spawnCommandRunner,
  type CommandRunner
} from "../agents/command-runner.js";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import {
  verifyLocalBetaPackage,
  type LocalBetaPackageManifest
} from "./local-beta.js";
import {
  verifyReleaseProvenance
} from "./provenance.js";
import {
  verifyReleaseSbom
} from "./sbom.js";
import {
  parseReleaseVerificationContext,
  type ReleaseVerificationContext
} from "./verification-context.js";

export type ReleaseInventoryEntry = {
  path: string;
  size_bytes: number;
  type: "file" | "directory";
};

export type ReleaseAttestationBinding = {
  file: string;
  format: string;
  schema_version: string;
  sha256: string;
  size_bytes: number;
};

export type ReleaseManifest = {
  schema_version: "0.1";
  artifact_kind: "kairon_release";
  release_channel: "local_beta";
  package_name: "kairon";
  package_version: string;
  source: {
    commit_sha: string;
    dirty: false;
  };
  runtime_support: {
    operating_systems: ["windows_10_11", "windows_server"];
    node: string;
    npm: "required";
    powershell: ">=5.1";
    git: "required";
  };
  artifact: {
    package_file: string;
    checksum_manifest_file: string;
    sha256: string;
    size_bytes: number;
    checksum_manifest_sha256: string;
  };
  package_inventory: {
    sha256: string;
    files: ReleaseInventoryEntry[];
  };
  attestations?: {
    sbom: ReleaseAttestationBinding & {
      format: "cyclonedx-json";
      schema_version: "1.6";
    };
    provenance: ReleaseAttestationBinding & {
      format: "kairon-local-build-provenance";
      schema_version: "0.1";
    };
  };
  created_at: string;
};

export type ReleaseManifestCheck = {
  id:
    | "manifest_schema"
    | "source_identity"
    | "source_tree_check"
    | "artifact_source_binding"
    | "runtime_support"
    | "package_verification"
    | "package_binding"
    | "checksum_manifest_binding"
    | "package_inventory_binding"
    | "sbom_binding"
    | "provenance_binding";
  status: "pass" | "fail";
  details: string;
};

export type ReleaseManifestVerificationResult = {
  schema_version: "0.1";
  ok: boolean;
  verification_context: ReleaseVerificationContext;
  release_manifest_path: string;
  package_path: string;
  checksum_manifest_path: string;
  package_version: string | null;
  source_commit: string | null;
  checks: ReleaseManifestCheck[];
};

export type ReleaseManifestResult = {
  schema_version: "0.1";
  status: "created";
  release_manifest_path: string;
  package_path: string;
  checksum_manifest_path: string;
  package_version: string;
  source_commit: string;
  artifact_sha256: string;
  inventory_sha256: string;
  files: number;
  sbom_path?: string;
  provenance_path?: string;
  verification: ReleaseManifestVerificationResult;
};

export type CreateReleaseManifestOptions = {
  output?: string;
  sbom?: string;
  provenance?: string;
  commandRunner?: CommandRunner;
  now?: () => Date;
};

export type VerifyReleaseManifestOptions = {
  projectRoot?: string;
  commandRunner?: CommandRunner;
  verificationContext?: ReleaseVerificationContext;
};

export function parseReleaseManifestContent(
  content: Uint8Array | string
): ReleaseManifest {
  let value: unknown;
  try {
    const text = typeof content === "string"
      ? content
      : Buffer.from(content).toString("utf8");
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Release manifest content is not valid JSON.");
  }
  if (!isReleaseManifest(value)) {
    throw new Error("Release manifest schema or artifact kind is invalid.");
  }
  return value;
}

type RootPackageJson = {
  name?: unknown;
  version?: unknown;
  private?: unknown;
  license?: unknown;
  engines?: {
    node?: unknown;
  };
};

export async function createReleaseManifest(
  projectRoot: string,
  packageFile: string,
  checksumManifestFile: string,
  options: CreateReleaseManifestOptions = {}
): Promise<ReleaseManifestResult> {
  const root = path.resolve(projectRoot);
  const packagePath = resolveFromRoot(root, packageFile);
  const checksumManifestPath = resolveFromRoot(root, checksumManifestFile);
  const selectedAttestations = options.sbom !== undefined || options.provenance !== undefined;
  if (selectedAttestations && (options.sbom === undefined || options.provenance === undefined)) {
    throw new Error("Release manifest requires --sbom and --provenance together.");
  }
  const sbomPath = options.sbom === undefined
    ? undefined
    : resolveFromRoot(root, options.sbom);
  const provenancePath = options.provenance === undefined
    ? undefined
    : resolveFromRoot(root, options.provenance);
  const commandRunner = options.commandRunner ?? spawnCommandRunner;
  const sourceCommit = await collectCleanSourceCommit(root, commandRunner);
  const packageVerification = await verifyLocalBetaPackage(
    packagePath,
    checksumManifestPath
  );
  if (!packageVerification.ok) {
    throw new Error(
      `Release manifest requires a verified package: ${packageVerification.checks
        .filter((entry) => entry.status === "fail")
        .map((entry) => entry.id)
        .join(", ")}`
    );
  }

  const [packageJson, checksumManifest, checksumBytes, packageInfo] = await Promise.all([
    readRootPackageJson(root),
    readChecksumManifest(checksumManifestPath),
    readFile(checksumManifestPath),
    stat(packagePath)
  ]);
  const packageVersion = requireString(packageJson.version, "package.json version");
  const nodeSupport = requireString(
    packageJson.engines?.node,
    "package.json engines.node"
  );
  if (
    packageJson.name !== "kairon" ||
    packageJson.private !== true ||
    packageJson.license !== "UNLICENSED" ||
    packageVersion !== packageVerification.package_version ||
    packageVersion !== checksumManifest.package_version
  ) {
    throw new Error(
      "Release manifest package metadata does not match the private local release source and artifact."
    );
  }

  const inventory = normalizeReleaseInventory(checksumManifest.files);
  const attestations = sbomPath === undefined || provenancePath === undefined
    ? undefined
    : await createAttestationBindings({
      root,
      packagePath,
      checksumManifestPath,
      sbomPath,
      provenancePath,
      packageVersion,
      sourceCommit,
      commandRunner
    });
  const releaseManifest: ReleaseManifest = {
    schema_version: "0.1",
    artifact_kind: "kairon_release",
    release_channel: "local_beta",
    package_name: "kairon",
    package_version: packageVersion,
    source: {
      commit_sha: sourceCommit,
      dirty: false
    },
    runtime_support: {
      operating_systems: ["windows_10_11", "windows_server"],
      node: nodeSupport,
      npm: "required",
      powershell: ">=5.1",
      git: "required"
    },
    artifact: {
      package_file: path.basename(packagePath),
      checksum_manifest_file: path.basename(checksumManifestPath),
      sha256: packageVerification.sha256,
      size_bytes: packageInfo.size,
      checksum_manifest_sha256: sha256(checksumBytes)
    },
    package_inventory: {
      sha256: calculateReleaseInventorySha256(inventory),
      files: inventory
    },
    ...(attestations === undefined ? {} : { attestations }),
    created_at: (options.now?.() ?? new Date()).toISOString()
  };
  const releaseManifestPath = options.output === undefined
    ? path.join(path.dirname(packagePath), "release-manifest.json")
    : resolveFromRoot(root, options.output);
  await writeJsonFileAtomic(releaseManifestPath, releaseManifest);

  const verification = await verifyReleaseManifest(
    releaseManifestPath,
    packagePath,
    checksumManifestPath,
    {
      projectRoot: root,
      commandRunner,
      verificationContext: "source"
    }
  );
  if (!verification.ok) {
    throw new Error(
      `Release manifest verification failed: ${verification.checks
        .filter((entry) => entry.status === "fail")
        .map((entry) => entry.id)
        .join(", ")}`
    );
  }

  return {
    schema_version: "0.1",
    status: "created",
    release_manifest_path: releaseManifestPath,
    package_path: packagePath,
    checksum_manifest_path: checksumManifestPath,
    package_version: packageVersion,
    source_commit: sourceCommit,
    artifact_sha256: releaseManifest.artifact.sha256,
    inventory_sha256: releaseManifest.package_inventory.sha256,
    files: inventory.length,
    ...(sbomPath === undefined ? {} : { sbom_path: sbomPath }),
    ...(provenancePath === undefined ? {} : { provenance_path: provenancePath }),
    verification
  };
}

export async function verifyReleaseManifest(
  releaseManifestFile: string,
  packageFile?: string,
  checksumManifestFile?: string,
  options: VerifyReleaseManifestOptions = {}
): Promise<ReleaseManifestVerificationResult> {
  const verificationContext = parseReleaseVerificationContext(
    options.verificationContext
  );
  const releaseManifestPath = path.resolve(releaseManifestFile);
  const rawManifest = await readUnknownJson(releaseManifestPath, "release manifest");
  const manifestValid = isReleaseManifest(rawManifest);
  const manifest = manifestValid ? rawManifest : null;
  const packagePath = path.resolve(
    packageFile ?? path.join(path.dirname(releaseManifestPath), manifest?.artifact.package_file ?? "missing.tgz")
  );
  const checksumManifestPath = path.resolve(
    checksumManifestFile ?? path.join(
      path.dirname(releaseManifestPath),
      manifest?.artifact.checksum_manifest_file ?? "missing.sha256.json"
    )
  );
  const checks: ReleaseManifestCheck[] = [];
  checks.push(resultCheck(
    "manifest_schema",
    manifestValid,
    manifestValid
      ? "Release manifest schema and artifact kind are valid."
      : "Release manifest schema or artifact kind is invalid."
  ));

  const sourceValid = manifest !== null &&
    /^[a-f0-9]{40,64}$/u.test(manifest.source.commit_sha) &&
    manifest.source.dirty === false;
  checks.push(resultCheck(
    "source_identity",
    sourceValid,
    sourceValid
      ? `Release is bound to clean source commit ${manifest?.source.commit_sha}.`
      : "Release source must contain a valid commit SHA and dirty=false."
  ));
  let sourceTreeValid = sourceValid;
  if (verificationContext === "source") {
    try {
      sourceTreeValid = sourceValid &&
        manifest!.source.commit_sha === await collectCleanSourceCommit(
          path.resolve(options.projectRoot ?? process.cwd()),
          options.commandRunner ?? spawnCommandRunner
        );
    } catch {
      sourceTreeValid = false;
    }
  }
  checks.push(resultCheck(
    "source_tree_check",
    sourceTreeValid,
    sourceTreeValid
      ? verificationContext === "source"
        ? "Release source commit matches the selected clean tracked source tree."
        : "Consumer verification does not compare the host project Git tree."
      : "Release source does not match the selected clean tracked source tree."
  ));
  const runtimeValid = manifest !== null &&
    manifest.runtime_support.node === ">=22" &&
    manifest.runtime_support.npm === "required" &&
    manifest.runtime_support.powershell === ">=5.1" &&
    manifest.runtime_support.git === "required" &&
    JSON.stringify(manifest.runtime_support.operating_systems) ===
      JSON.stringify(["windows_10_11", "windows_server"]);
  checks.push(resultCheck(
    "runtime_support",
    runtimeValid,
    runtimeValid
      ? "Runtime support matrix matches the Windows local release baseline."
      : "Runtime support matrix does not match the Windows local release baseline."
  ));

  let packageVerification;
  let checksumManifest: LocalBetaPackageManifest | null = null;
  let checksumBytes: Buffer | null = null;
  try {
    packageVerification = await verifyLocalBetaPackage(packagePath, checksumManifestPath);
    checksumManifest = await readChecksumManifest(checksumManifestPath);
    checksumBytes = await readFile(checksumManifestPath);
  } catch {
    packageVerification = null;
  }
  const packageVerified = packageVerification?.ok === true;
  checks.push(resultCheck(
    "package_verification",
    packageVerified,
    packageVerified
      ? "Local release package and checksum manifest verification passed."
      : "Local release package or checksum manifest verification failed."
  ));

  const packageBound = manifest !== null &&
    packageVerification !== null &&
    manifest.package_name === packageVerification.package_name &&
    manifest.package_version === packageVerification.package_version &&
    manifest.artifact.package_file === path.basename(packagePath) &&
    manifest.artifact.sha256 === packageVerification.sha256 &&
    manifest.artifact.size_bytes === packageVerification.size_bytes;
  checks.push(resultCheck(
    "package_binding",
    packageBound,
    packageBound
      ? "Release manifest is bound to the selected package name, version, size, and SHA-256."
      : "Release manifest package binding does not match the selected package."
  ));

  const checksumBound = manifest !== null &&
    checksumBytes !== null &&
    manifest.artifact.checksum_manifest_file === path.basename(checksumManifestPath) &&
    manifest.artifact.checksum_manifest_sha256 === sha256(checksumBytes);
  checks.push(resultCheck(
    "checksum_manifest_binding",
    checksumBound,
    checksumBound
      ? "Checksum manifest filename and SHA-256 match the release manifest."
      : "Checksum manifest filename or SHA-256 does not match the release manifest."
  ));

  const normalizedInventory = checksumManifest === null
    ? []
    : normalizeReleaseInventory(checksumManifest.files);
  const inventoryBound = manifest !== null &&
    JSON.stringify(manifest.package_inventory.files) === JSON.stringify(normalizedInventory) &&
    manifest.package_inventory.sha256 === calculateReleaseInventorySha256(normalizedInventory);
  checks.push(resultCheck(
    "package_inventory_binding",
    inventoryBound,
    inventoryBound
      ? "Sorted package inventory and inventory SHA-256 match."
      : "Package inventory or inventory SHA-256 does not match the checksum manifest."
  ));

  let artifactSourceBound =
    manifest !== null &&
    manifest.attestations === undefined &&
    sourceValid;
  if (manifest?.attestations !== undefined) {
    const sbomPath = path.resolve(
      path.dirname(releaseManifestPath),
      manifest.attestations.sbom.file
    );
    const provenancePath = path.resolve(
      path.dirname(releaseManifestPath),
      manifest.attestations.provenance.file
    );
    let sbomBound = false;
    let provenanceBound = false;
    try {
      const [sbomBytes, sbomInfo, sbomVerification] = await Promise.all([
        readFile(sbomPath),
        stat(sbomPath),
        verifyReleaseSbom(sbomPath, {
          projectRoot: options.projectRoot,
          checksumManifest: checksumManifestPath,
          verificationContext
        })
      ]);
      sbomBound =
        sbomVerification.ok &&
        sbomVerification.package_version === manifest.package_version &&
        manifest.attestations.sbom.sha256 === sha256(sbomBytes) &&
        manifest.attestations.sbom.size_bytes === sbomInfo.size;
    } catch {
      sbomBound = false;
    }
    checks.push(resultCheck(
      "sbom_binding",
      sbomBound,
      sbomBound
        ? "CycloneDX SBOM content, size, and release bindings match."
        : "CycloneDX SBOM content or release binding does not match."
    ));

    try {
      const [provenanceBytes, provenanceInfo, provenanceVerification] =
        await Promise.all([
          readFile(provenancePath),
          stat(provenancePath),
          verifyReleaseProvenance(provenancePath, {
            projectRoot: options.projectRoot,
            package: packagePath,
            checksumManifest: checksumManifestPath,
            sbom: sbomPath,
            commandRunner: options.commandRunner,
            verificationContext
          })
        ]);
      provenanceBound =
        provenanceVerification.ok &&
        provenanceVerification.package_version === manifest.package_version &&
        manifest.attestations.provenance.sha256 === sha256(provenanceBytes) &&
        manifest.attestations.provenance.size_bytes === provenanceInfo.size;
      artifactSourceBound =
        provenanceVerification.ok &&
        provenanceVerification.source_commit === manifest.source.commit_sha;
    } catch {
      provenanceBound = false;
    }
    checks.push(resultCheck(
      "provenance_binding",
      provenanceBound,
      provenanceBound
        ? "Local build provenance content, size, and release bindings match."
        : "Local build provenance content or release binding does not match."
    ));
  }
  checks.push(resultCheck(
    "artifact_source_binding",
    artifactSourceBound,
    artifactSourceBound
      ? manifest?.attestations === undefined
        ? "Legacy manifest has no provenance attestation; source syntax remains valid."
        : "Release manifest and provenance use the same source commit."
      : "Release manifest and provenance source commits do not match."
  ));

  return {
    schema_version: "0.1",
    ok: checks.every((entry) => entry.status === "pass"),
    verification_context: verificationContext,
    release_manifest_path: releaseManifestPath,
    package_path: packagePath,
    checksum_manifest_path: checksumManifestPath,
    package_version: manifest?.package_version ?? null,
    source_commit: manifest?.source.commit_sha ?? null,
    checks
  };
}

export function normalizeReleaseInventory(
  files: LocalBetaPackageManifest["files"]
): ReleaseInventoryEntry[] {
  return files
    .map((entry) => ({
      path: entry.path.replaceAll("\\", "/"),
      size_bytes: entry.size_bytes,
      type: entry.type
    }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function calculateReleaseInventorySha256(
  files: ReleaseInventoryEntry[]
): string {
  return sha256(Buffer.from(`${JSON.stringify(files)}\n`, "utf8"));
}

export function formatReleaseManifest(result: ReleaseManifestResult): string {
  return [
    "Kairon release manifest created.",
    `status=${result.status}`,
    `release_manifest=${result.release_manifest_path}`,
    `package=${result.package_path}`,
    `checksum_manifest=${result.checksum_manifest_path}`,
    `version=${result.package_version}`,
    `source_commit=${result.source_commit}`,
    `artifact_sha256=${result.artifact_sha256}`,
    `inventory_sha256=${result.inventory_sha256}`,
    `files=${result.files}`,
    ...(result.sbom_path === undefined ? [] : [`sbom=${result.sbom_path}`]),
    ...(result.provenance_path === undefined
      ? []
      : [`provenance=${result.provenance_path}`]),
    `verification.ok=${result.verification.ok}`
  ].join("\n");
}

export function formatReleaseManifestVerification(
  result: ReleaseManifestVerificationResult
): string {
  return [
    "Kairon release manifest verification:",
    `release_manifest.verification.ok=${result.ok}`,
    `verification_context=${result.verification_context}`,
    `release_manifest=${result.release_manifest_path}`,
    `package=${result.package_path}`,
    `checksum_manifest=${result.checksum_manifest_path}`,
    `version=${result.package_version ?? "unknown"}`,
    `source_commit=${result.source_commit ?? "unknown"}`,
    ...result.checks.map(
      (entry) => `${entry.status.toUpperCase()} ${entry.id} ${entry.details}`
    )
  ].join("\n");
}

async function collectCleanSourceCommit(
  projectRoot: string,
  commandRunner: CommandRunner
): Promise<string> {
  const status = await commandRunner({
    command: "git",
    args: ["status", "--porcelain", "--untracked-files=no"],
    cwd: projectRoot
  });
  if (status.exitCode !== 0 || status.timedOut) {
    throw new Error("Failed to inspect tracked source state before release manifest generation.");
  }
  const dirty = status.stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (dirty.length > 0) {
    throw new Error(
      `Release manifest requires a clean tracked worktree. Dirty tracked entries: ${dirty
        .slice(0, 20)
        .join(", ")}`
    );
  }

  const revision = await commandRunner({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: projectRoot
  });
  const commit = revision.stdout.trim().toLowerCase();
  if (
    revision.exitCode !== 0 ||
    revision.timedOut ||
    !/^[a-f0-9]{40,64}$/u.test(commit)
  ) {
    throw new Error("Release manifest requires a valid Git HEAD commit.");
  }
  return commit;
}

async function readRootPackageJson(projectRoot: string): Promise<RootPackageJson> {
  const value = await readUnknownJson(path.join(projectRoot, "package.json"), "package.json");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("package.json must contain an object.");
  }
  return value as RootPackageJson;
}

async function readChecksumManifest(
  checksumManifestPath: string
): Promise<LocalBetaPackageManifest> {
  const value = await readUnknownJson(checksumManifestPath, "checksum manifest");
  if (!isLocalBetaChecksumManifest(value)) {
    throw new Error("Checksum manifest schema is invalid.");
  }
  return value;
}

async function readUnknownJson(filePath: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    throw new Error(`Failed to read ${label}.`);
  }
}

function isLocalBetaChecksumManifest(value: unknown): value is LocalBetaPackageManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<LocalBetaPackageManifest>;
  return candidate.schema_version === "0.1" &&
    candidate.artifact_kind === "local_beta_package" &&
    candidate.package_name === "kairon" &&
    typeof candidate.package_version === "string" &&
    typeof candidate.package_file === "string" &&
    typeof candidate.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.sha256) &&
    Number.isInteger(candidate.size_bytes) &&
    Array.isArray(candidate.files) &&
    candidate.files.every((entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.path === "string" &&
      Number.isInteger(entry.size_bytes) &&
      (entry.type === "file" || entry.type === "directory")
    ) &&
    typeof candidate.created_at === "string";
}

export function isReleaseManifest(value: unknown): value is ReleaseManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<ReleaseManifest>;
  return candidate.schema_version === "0.1" &&
    candidate.artifact_kind === "kairon_release" &&
    candidate.release_channel === "local_beta" &&
    candidate.package_name === "kairon" &&
    typeof candidate.package_version === "string" &&
    typeof candidate.source === "object" &&
    candidate.source !== null &&
    typeof candidate.source.commit_sha === "string" &&
    candidate.source.dirty === false &&
    typeof candidate.runtime_support === "object" &&
    candidate.runtime_support !== null &&
    Array.isArray(candidate.runtime_support.operating_systems) &&
    typeof candidate.runtime_support.node === "string" &&
    candidate.runtime_support.npm === "required" &&
    candidate.runtime_support.powershell === ">=5.1" &&
    candidate.runtime_support.git === "required" &&
    typeof candidate.artifact === "object" &&
    candidate.artifact !== null &&
    isPlainFilename(candidate.artifact.package_file) &&
    isPlainFilename(candidate.artifact.checksum_manifest_file) &&
    typeof candidate.artifact.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.artifact.sha256) &&
    Number.isInteger(candidate.artifact.size_bytes) &&
    typeof candidate.artifact.checksum_manifest_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.artifact.checksum_manifest_sha256) &&
    typeof candidate.package_inventory === "object" &&
    candidate.package_inventory !== null &&
    typeof candidate.package_inventory.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.package_inventory.sha256) &&
    Array.isArray(candidate.package_inventory.files) &&
    candidate.package_inventory.files.every((entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.path === "string" &&
      Number.isInteger(entry.size_bytes) &&
      (entry.type === "file" || entry.type === "directory")
    ) &&
    (candidate.attestations === undefined ||
      isReleaseAttestations(candidate.attestations)) &&
    typeof candidate.created_at === "string" &&
    !Number.isNaN(Date.parse(candidate.created_at));
}

async function createAttestationBindings(input: {
  root: string;
  packagePath: string;
  checksumManifestPath: string;
  sbomPath: string;
  provenancePath: string;
  packageVersion: string;
  sourceCommit: string;
  commandRunner: CommandRunner;
}): Promise<NonNullable<ReleaseManifest["attestations"]>> {
  const [sbomBytes, sbomInfo, sbomVerification, provenanceBytes, provenanceInfo,
    provenanceVerification] = await Promise.all([
    readFile(input.sbomPath),
    stat(input.sbomPath),
    verifyReleaseSbom(input.sbomPath, {
      projectRoot: input.root,
      checksumManifest: input.checksumManifestPath,
      verificationContext: "source"
    }),
    readFile(input.provenancePath),
    stat(input.provenancePath),
    verifyReleaseProvenance(input.provenancePath, {
      projectRoot: input.root,
      package: input.packagePath,
      checksumManifest: input.checksumManifestPath,
      sbom: input.sbomPath,
      commandRunner: input.commandRunner,
      verificationContext: "source"
    })
  ]);
  if (
    !sbomVerification.ok ||
    sbomVerification.package_version !== input.packageVersion
  ) {
    throw new Error("Release manifest requires an SBOM bound to the selected release.");
  }
  if (
    !provenanceVerification.ok ||
    provenanceVerification.package_version !== input.packageVersion ||
    provenanceVerification.source_commit !== input.sourceCommit
  ) {
    throw new Error("Release manifest requires provenance bound to the selected release.");
  }
  return {
    sbom: {
      file: path.basename(input.sbomPath),
      format: "cyclonedx-json",
      schema_version: "1.6",
      sha256: sha256(sbomBytes),
      size_bytes: sbomInfo.size
    },
    provenance: {
      file: path.basename(input.provenancePath),
      format: "kairon-local-build-provenance",
      schema_version: "0.1",
      sha256: sha256(provenanceBytes),
      size_bytes: provenanceInfo.size
    }
  };
}

function isReleaseAttestations(
  value: unknown
): value is NonNullable<ReleaseManifest["attestations"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<NonNullable<ReleaseManifest["attestations"]>>;
  return isAttestationBinding(
    candidate.sbom,
    "cyclonedx-json",
    "1.6"
  ) && isAttestationBinding(
    candidate.provenance,
    "kairon-local-build-provenance",
    "0.1"
  );
}

function isAttestationBinding(
  value: unknown,
  format: string,
  schemaVersion: string
): value is ReleaseAttestationBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<ReleaseAttestationBinding>;
  return isPlainFilename(candidate.file) &&
    candidate.format === format &&
    candidate.schema_version === schemaVersion &&
    typeof candidate.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.sha256) &&
    Number.isInteger(candidate.size_bytes) &&
    (candidate.size_bytes ?? -1) >= 0;
}

function resultCheck(
  id: ReleaseManifestCheck["id"],
  passed: boolean,
  details: string
): ReleaseManifestCheck {
  return { id, status: passed ? "pass" : "fail", details };
}

function isPlainFilename(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    path.basename(value) === value;
}

function resolveFromRoot(projectRoot: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectRoot, value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing ${field}.`);
  }
  return value;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
