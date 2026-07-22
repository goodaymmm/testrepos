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

export type ReleaseInventoryEntry = {
  path: string;
  size_bytes: number;
  type: "file" | "directory";
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
  created_at: string;
};

export type ReleaseManifestCheck = {
  id:
    | "manifest_schema"
    | "source_identity"
    | "runtime_support"
    | "package_verification"
    | "package_binding"
    | "checksum_manifest_binding"
    | "package_inventory_binding";
  status: "pass" | "fail";
  details: string;
};

export type ReleaseManifestVerificationResult = {
  schema_version: "0.1";
  ok: boolean;
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
  verification: ReleaseManifestVerificationResult;
};

export type CreateReleaseManifestOptions = {
  output?: string;
  commandRunner?: CommandRunner;
  now?: () => Date;
};

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
      "Release manifest package metadata does not match the private local beta source and artifact."
    );
  }

  const inventory = normalizeReleaseInventory(checksumManifest.files);
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
    created_at: (options.now?.() ?? new Date()).toISOString()
  };
  const releaseManifestPath = options.output === undefined
    ? path.join(path.dirname(packagePath), "release-manifest.json")
    : resolveFromRoot(root, options.output);
  await writeJsonFileAtomic(releaseManifestPath, releaseManifest);

  const verification = await verifyReleaseManifest(
    releaseManifestPath,
    packagePath,
    checksumManifestPath
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
    verification
  };
}

export async function verifyReleaseManifest(
  releaseManifestFile: string,
  packageFile?: string,
  checksumManifestFile?: string
): Promise<ReleaseManifestVerificationResult> {
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
      ? "Runtime support matrix matches the Windows local beta baseline."
      : "Runtime support matrix does not match the Windows local beta baseline."
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
      ? "Local beta package and checksum manifest verification passed."
      : "Local beta package or checksum manifest verification failed."
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

  return {
    schema_version: "0.1",
    ok: checks.every((entry) => entry.status === "pass"),
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
    `verification.ok=${result.verification.ok}`
  ].join("\n");
}

export function formatReleaseManifestVerification(
  result: ReleaseManifestVerificationResult
): string {
  return [
    "Kairon release manifest verification:",
    `release_manifest.verification.ok=${result.ok}`,
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

function isReleaseManifest(value: unknown): value is ReleaseManifest {
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
    typeof candidate.created_at === "string";
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
