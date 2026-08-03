import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  spawnCommandRunner,
  type CommandRunner
} from "../agents/command-runner.js";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { verifyLocalBetaPackage } from "./local-beta.js";
import { verifyReleaseSbom } from "./sbom.js";
import {
  parseReleaseVerificationContext,
  type ReleaseVerificationContext
} from "./verification-context.js";

export type ReleaseProvenanceSubject = {
  kind: "package" | "checksum_manifest" | "sbom";
  name: string;
  sha256: string;
  size_bytes: number;
};

export type ReleaseProvenance = {
  schema_version: "0.1";
  artifact_kind: "kairon_local_build_provenance";
  package_name: "kairon";
  package_version: string;
  source: {
    commit_sha: string;
    dirty: false;
  };
  build: {
    command_id: "npm_run_release_pack";
    node_version: string;
    npm_version: string;
  };
  materials: {
    package_lock: {
      file: "package-lock.json";
      sha256: string;
    };
    package_inventory: {
      sha256: string;
    };
  };
  subjects: [
    ReleaseProvenanceSubject,
    ReleaseProvenanceSubject,
    ReleaseProvenanceSubject
  ];
  created_at: string;
};

export type ReleaseProvenanceCheck = {
  id:
    | "provenance_schema"
    | "source_identity"
    | "build_environment"
    | "package_binding"
    | "checksum_manifest_binding"
    | "sbom_binding"
    | "package_lock_binding"
    | "package_inventory_binding"
    | "host_data_absent";
  status: "pass" | "fail";
  details: string;
};

export type ReleaseProvenanceVerificationResult = {
  schema_version: "0.1";
  ok: boolean;
  verification_context: ReleaseVerificationContext;
  provenance_path: string;
  package_path: string;
  checksum_manifest_path: string;
  sbom_path: string;
  package_version: string | null;
  source_commit: string | null;
  sha256: string;
  size_bytes: number;
  checks: ReleaseProvenanceCheck[];
};

export type CreateReleaseProvenanceOptions = {
  output?: string;
  commandRunner?: CommandRunner;
  now?: () => Date;
  nodeVersion?: string;
  npmVersion?: string;
};

export type VerifyReleaseProvenanceOptions = {
  projectRoot?: string;
  package?: string;
  checksumManifest?: string;
  sbom?: string;
  commandRunner?: CommandRunner;
  verificationContext?: ReleaseVerificationContext;
};

export type ReleaseProvenanceResult = {
  schema_version: "0.1";
  status: "created";
  provenance_path: string;
  package_version: string;
  source_commit: string;
  sha256: string;
  size_bytes: number;
  verification: ReleaseProvenanceVerificationResult;
};

export async function createReleaseProvenance(
  projectRoot: string,
  packageFile: string,
  checksumManifestFile: string,
  sbomFile: string,
  options: CreateReleaseProvenanceOptions = {}
): Promise<ReleaseProvenanceResult> {
  const root = path.resolve(projectRoot);
  const packagePath = resolveFromRoot(root, packageFile);
  const checksumPath = resolveFromRoot(root, checksumManifestFile);
  const sbomPath = resolveFromRoot(root, sbomFile);
  const commandRunner = options.commandRunner ?? spawnCommandRunner;
  const [sourceCommit, packageVerification, sbomVerification, checksumBytes, sbomBytes] =
    await Promise.all([
      collectCleanSourceCommit(root, commandRunner),
      verifyLocalBetaPackage(packagePath, checksumPath),
      verifyReleaseSbom(sbomPath, {
        projectRoot: root,
        checksumManifest: checksumPath
      }),
      readFile(checksumPath),
      readFile(sbomPath)
    ]);
  if (!packageVerification.ok) {
    throw new Error("Release provenance requires a verified package.");
  }
  if (!sbomVerification.ok) {
    throw new Error("Release provenance requires a verified SBOM.");
  }
  if (
    packageVerification.package_version === null ||
    packageVerification.package_version !== sbomVerification.package_version ||
    sbomVerification.package_lock_sha256 === null ||
    sbomVerification.package_inventory_sha256 === null
  ) {
    throw new Error("Release provenance package, SBOM, and lockfile identities do not match.");
  }

  const [packageInfo, checksumInfo, sbomInfo, npmVersion] = await Promise.all([
    stat(packagePath),
    stat(checksumPath),
    stat(sbomPath),
    options.npmVersion === undefined
      ? collectNpmVersion(root, commandRunner)
      : Promise.resolve(normalizeNpmVersion(options.npmVersion))
  ]);
  const provenance: ReleaseProvenance = {
    schema_version: "0.1",
    artifact_kind: "kairon_local_build_provenance",
    package_name: "kairon",
    package_version: packageVerification.package_version,
    source: {
      commit_sha: sourceCommit,
      dirty: false
    },
    build: {
      command_id: "npm_run_release_pack",
      node_version: normalizeNodeVersion(options.nodeVersion ?? process.version),
      npm_version: npmVersion
    },
    materials: {
      package_lock: {
        file: "package-lock.json",
        sha256: sbomVerification.package_lock_sha256
      },
      package_inventory: {
        sha256: sbomVerification.package_inventory_sha256
      }
    },
    subjects: [
      subject("package", packagePath, packageVerification.sha256, packageInfo.size),
      subject("checksum_manifest", checksumPath, sha256(checksumBytes), checksumInfo.size),
      subject("sbom", sbomPath, sha256(sbomBytes), sbomInfo.size)
    ],
    created_at: (options.now?.() ?? new Date()).toISOString()
  };
  const outputPath = options.output === undefined
    ? path.join(path.dirname(packagePath), "provenance.json")
    : resolveFromRoot(root, options.output);
  await writeJsonFileAtomic(outputPath, provenance);
  const verification = await verifyReleaseProvenance(outputPath, {
    projectRoot: root,
    package: packagePath,
    checksumManifest: checksumPath,
    sbom: sbomPath,
    commandRunner,
    verificationContext: "source"
  });
  if (!verification.ok) {
    throw new Error(
      `Release provenance verification failed: ${verification.checks
        .filter((entry) => entry.status === "fail")
        .map((entry) => entry.id)
        .join(", ")}`
    );
  }
  return {
    schema_version: "0.1",
    status: "created",
    provenance_path: outputPath,
    package_version: provenance.package_version,
    source_commit: provenance.source.commit_sha,
    sha256: verification.sha256,
    size_bytes: verification.size_bytes,
    verification
  };
}

export async function verifyReleaseProvenance(
  provenanceFile: string,
  options: VerifyReleaseProvenanceOptions = {}
): Promise<ReleaseProvenanceVerificationResult> {
  const verificationContext = parseReleaseVerificationContext(
    options.verificationContext
  );
  const provenancePath = path.resolve(provenanceFile);
  const bytes = await readFile(provenancePath);
  const info = await stat(provenancePath);
  const raw = parseUnknownJson(bytes);
  const schemaValid = isReleaseProvenance(raw);
  const provenance = schemaValid ? raw : null;
  const base = path.dirname(provenancePath);
  const packagePath = resolveSubjectPath(base, options.package, provenance, "package");
  const checksumPath = resolveSubjectPath(
    base,
    options.checksumManifest,
    provenance,
    "checksum_manifest"
  );
  const sbomPath = resolveSubjectPath(base, options.sbom, provenance, "sbom");
  const checks: ReleaseProvenanceCheck[] = [
    resultCheck(
      "provenance_schema",
      schemaValid,
      schemaValid
        ? "Kairon local build provenance schema is valid."
        : "Kairon local build provenance schema is invalid."
    )
  ];

  let sourceValid = provenance !== null &&
    /^[a-f0-9]{40,64}$/u.test(provenance.source.commit_sha) &&
    provenance.source.dirty === false;
  if (sourceValid && verificationContext === "source") {
    try {
      sourceValid = provenance!.source.commit_sha === await collectCleanSourceCommit(
        path.resolve(options.projectRoot ?? process.cwd()),
        options.commandRunner ?? spawnCommandRunner
      );
    } catch {
      sourceValid = false;
    }
  }
  checks.push(resultCheck(
    "source_identity",
    sourceValid,
    sourceValid
      ? verificationContext === "source"
        ? "Provenance source commit matches a clean tracked source tree."
        : "Provenance source identity is valid for consumer artifact verification."
      : "Provenance source identity is invalid or does not match the selected source tree."
  ));

  const buildValid = provenance !== null &&
    provenance.build.command_id === "npm_run_release_pack" &&
    isNodeVersion(provenance.build.node_version) &&
    isNpmVersion(provenance.build.npm_version);
  checks.push(resultCheck(
    "build_environment",
    buildValid,
    buildValid
      ? "Build command ID and Node/npm versions are valid."
      : "Build command ID or Node/npm version is invalid."
  ));

  let packageVerified = false;
  let packageBound = false;
  try {
    const verification = await verifyLocalBetaPackage(packagePath, checksumPath);
    packageVerified = verification.ok;
    packageBound = provenance !== null &&
      verification.ok &&
      verification.package_name === provenance.package_name &&
      verification.package_version === provenance.package_version &&
      subjectMatches(
        provenance,
        "package",
        packagePath,
        verification.sha256,
        verification.size_bytes
      );
  } catch {
    packageVerified = false;
  }
  checks.push(resultCheck(
    "package_binding",
    packageVerified && packageBound,
    packageVerified && packageBound
      ? "Package name, version, size, and SHA-256 match provenance."
      : "Package does not match provenance."
  ));

  const checksumBound = provenance !== null &&
    await fileMatchesSubject(provenance, "checksum_manifest", checksumPath);
  checks.push(resultCheck(
    "checksum_manifest_binding",
    checksumBound,
    checksumBound
      ? "Checksum manifest size and SHA-256 match provenance."
      : "Checksum manifest does not match provenance."
  ));

  let sbomVerification = null;
  try {
    sbomVerification = await verifyReleaseSbom(sbomPath, {
      projectRoot: options.projectRoot,
      checksumManifest: checksumPath,
      verificationContext
    });
  } catch {
    sbomVerification = null;
  }
  const sbomBound = provenance !== null &&
    sbomVerification?.ok === true &&
    await fileMatchesSubject(provenance, "sbom", sbomPath);
  checks.push(resultCheck(
    "sbom_binding",
    sbomBound,
    sbomBound
      ? "SBOM content, size, and SHA-256 match provenance."
      : "SBOM does not match provenance."
  ));

  const lockBound = provenance !== null &&
    sbomVerification?.package_lock_sha256 !== null &&
    provenance.materials.package_lock.sha256 === sbomVerification?.package_lock_sha256;
  checks.push(resultCheck(
    "package_lock_binding",
    lockBound,
    lockBound
      ? "Package-lock SHA-256 matches the SBOM material."
      : "Package-lock SHA-256 does not match the SBOM material."
  ));
  const inventoryBound = provenance !== null &&
    sbomVerification?.package_inventory_sha256 !== null &&
    provenance.materials.package_inventory.sha256 ===
      sbomVerification?.package_inventory_sha256;
  checks.push(resultCheck(
    "package_inventory_binding",
    inventoryBound,
    inventoryBound
      ? "Package inventory SHA-256 matches the SBOM material."
      : "Package inventory SHA-256 does not match the SBOM material."
  ));

  const hostDataAbsent = !containsHostSpecificData(raw);
  checks.push(resultCheck(
    "host_data_absent",
    hostDataAbsent,
    hostDataAbsent
      ? "Provenance contains no absolute path, account, host, or credential field."
      : "Provenance contains host-specific or credential-like data."
  ));
  return {
    schema_version: "0.1",
    ok: checks.every((entry) => entry.status === "pass"),
    verification_context: verificationContext,
    provenance_path: provenancePath,
    package_path: packagePath,
    checksum_manifest_path: checksumPath,
    sbom_path: sbomPath,
    package_version: provenance?.package_version ?? null,
    source_commit: provenance?.source.commit_sha ?? null,
    sha256: sha256(bytes),
    size_bytes: info.size,
    checks
  };
}

export function formatReleaseProvenance(result: ReleaseProvenanceResult): string {
  return [
    "Kairon release provenance created.",
    `status=${result.status}`,
    `provenance=${result.provenance_path}`,
    `version=${result.package_version}`,
    `source_commit=${result.source_commit}`,
    `sha256=${result.sha256}`,
    `size_bytes=${result.size_bytes}`,
    `verification.ok=${result.verification.ok}`
  ].join("\n");
}

export function isReleaseProvenance(value: unknown): value is ReleaseProvenance {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<ReleaseProvenance>;
  return candidate.schema_version === "0.1" &&
    candidate.artifact_kind === "kairon_local_build_provenance" &&
    candidate.package_name === "kairon" &&
    typeof candidate.package_version === "string" &&
    candidate.package_version.length > 0 &&
    typeof candidate.source === "object" &&
    candidate.source !== null &&
    typeof candidate.source.commit_sha === "string" &&
    candidate.source.dirty === false &&
    typeof candidate.build === "object" &&
    candidate.build !== null &&
    candidate.build.command_id === "npm_run_release_pack" &&
    typeof candidate.build.node_version === "string" &&
    typeof candidate.build.npm_version === "string" &&
    typeof candidate.materials === "object" &&
    candidate.materials !== null &&
    candidate.materials.package_lock?.file === "package-lock.json" &&
    isSha256(candidate.materials.package_lock.sha256) &&
    isSha256(candidate.materials.package_inventory?.sha256) &&
    Array.isArray(candidate.subjects) &&
    candidate.subjects.length === 3 &&
    hasExpectedSubjects(candidate.subjects) &&
    typeof candidate.created_at === "string" &&
    !Number.isNaN(Date.parse(candidate.created_at));
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
  if (status.exitCode !== 0 || status.timedOut || status.stdout.trim().length > 0) {
    throw new Error("Release provenance requires a clean tracked worktree.");
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
    throw new Error("Release provenance requires a valid Git HEAD commit.");
  }
  return commit;
}

async function collectNpmVersion(
  projectRoot: string,
  commandRunner: CommandRunner
): Promise<string> {
  const result = await commandRunner({
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["--version"],
    cwd: projectRoot
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error("Release provenance could not collect the npm version.");
  }
  return normalizeNpmVersion(result.stdout);
}

function subject(
  kind: ReleaseProvenanceSubject["kind"],
  file: string,
  digest: string,
  sizeBytes: number
): ReleaseProvenanceSubject {
  return {
    kind,
    name: path.basename(file),
    sha256: digest,
    size_bytes: sizeBytes
  };
}

function hasExpectedSubjects(
  subjects: ReleaseProvenanceSubject[]
): subjects is ReleaseProvenance["subjects"] {
  const kinds = subjects.map((entry) => entry.kind).sort().join(",");
  return kinds === "checksum_manifest,package,sbom" &&
    subjects.every((entry) =>
      (entry.kind === "package" ||
        entry.kind === "checksum_manifest" ||
        entry.kind === "sbom") &&
      isPlainFilename(entry.name) &&
      isSha256(entry.sha256) &&
      Number.isInteger(entry.size_bytes) &&
      entry.size_bytes >= 0
    );
}

function resolveSubjectPath(
  base: string,
  selected: string | undefined,
  provenance: ReleaseProvenance | null,
  kind: ReleaseProvenanceSubject["kind"]
): string {
  if (selected !== undefined) {
    return path.resolve(selected);
  }
  const name = provenance?.subjects.find((entry) => entry.kind === kind)?.name ??
    `missing-${kind}`;
  return path.resolve(base, name);
}

async function fileMatchesSubject(
  provenance: ReleaseProvenance,
  kind: ReleaseProvenanceSubject["kind"],
  file: string
): Promise<boolean> {
  try {
    const [bytes, info] = await Promise.all([readFile(file), stat(file)]);
    return subjectMatches(provenance, kind, file, sha256(bytes), info.size);
  } catch {
    return false;
  }
}

function subjectMatches(
  provenance: ReleaseProvenance,
  kind: ReleaseProvenanceSubject["kind"],
  file: string,
  digest: string,
  sizeBytes: number
): boolean {
  const expected = provenance.subjects.find((entry) => entry.kind === kind);
  return expected !== undefined &&
    expected.name === path.basename(file) &&
    expected.sha256 === digest &&
    expected.size_bytes === sizeBytes;
}

function normalizeNodeVersion(value: string): string {
  const normalized = value.trim();
  if (!isNodeVersion(normalized)) {
    throw new Error(`Unsupported Node version for provenance: ${value}`);
  }
  return normalized.startsWith("v") ? normalized : `v${normalized}`;
}

function normalizeNpmVersion(value: string): string {
  const normalized = value.trim();
  if (!isNpmVersion(normalized)) {
    throw new Error(`Unsupported npm version for provenance: ${value}`);
  }
  return normalized;
}

function isNodeVersion(value: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value);
}

function isNpmVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value);
}

function containsHostSpecificData(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return (
    /(?:[A-Za-z]:\\|\/Users\/|\/home\/)/u.test(serialized) ||
    /(?:token|password|secret|authorization|hostname|username)/iu.test(serialized)
  );
}

function parseUnknownJson(content: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(content).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function resultCheck(
  id: ReleaseProvenanceCheck["id"],
  passed: boolean,
  details: string
): ReleaseProvenanceCheck {
  return { id, status: passed ? "pass" : "fail", details };
}

function isPlainFilename(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    path.basename(value) === value;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function resolveFromRoot(root: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
