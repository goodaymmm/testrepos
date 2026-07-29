import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  spawnCommandRunner,
  type CommandRunner
} from "../agents/command-runner.js";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { toPosixPath } from "../core/fs/paths.js";
import {
  evaluateArchivePolicy,
  stableArchivePolicyLimits,
  validatePortableArchivePath
} from "../security/path-policy.js";

export type LocalBetaPackageManifest = {
  schema_version: "0.1";
  artifact_kind: "local_beta_package";
  package_name: "kairon";
  package_version: string;
  package_file: string;
  sha256: string;
  size_bytes: number;
  files: Array<{
    path: string;
    size_bytes: number;
    type: "file" | "directory";
  }>;
  created_at: string;
};

export type LocalBetaVerificationCheck = {
  id:
    | "package_extension"
    | "manifest_schema"
    | "manifest_filename"
    | "package_size"
    | "package_sha256"
    | "tar_limits_safe"
    | "tar_paths_safe"
    | "tar_case_collisions_absent"
    | "tar_links_absent"
    | "required_files"
    | "forbidden_files_absent"
    | "package_metadata"
    | "manifest_file_set";
  status: "pass" | "fail";
  details: string;
};

export type LocalBetaVerificationResult = {
  schema_version: "0.1";
  ok: boolean;
  package_path: string;
  manifest_path: string;
  package_name: string | null;
  package_version: string | null;
  sha256: string;
  size_bytes: number;
  files: number;
  checks: LocalBetaVerificationCheck[];
};

export type LocalBetaPackResult = {
  schema_version: "0.1";
  status: "created";
  package_path: string;
  manifest_path: string;
  package_name: string;
  package_version: string;
  sha256: string;
  size_bytes: number;
  files: number;
  verification: LocalBetaVerificationResult;
};

export type LocalBetaPackOptions = {
  output?: string;
  commandRunner?: CommandRunner;
  now?: () => Date;
};

type PackageJson = {
  name?: unknown;
  version?: unknown;
  private?: unknown;
  license?: unknown;
  bin?: unknown;
  files?: unknown;
};

type NpmPackRecord = {
  filename?: unknown;
};

type TarEntry = {
  path: string;
  size: number;
  type: "file" | "directory" | "link" | "other";
  content: Buffer;
};

const requiredPackageFiles = [
  "package/package.json",
  "package/README.md",
  "package/dist/cli/main.js",
  "package/docs/installation.md",
  "package/scripts/local-beta-common.ps1",
  "package/scripts/install-local-beta.ps1",
  "package/scripts/update-local-beta.ps1",
  "package/scripts/uninstall-local-beta.ps1",
  "package/scripts/kairon-update-check-task.ps1",
  "package/scripts/kairon-dr-verify-task.ps1"
];

const requiredFilesAllowlist = [
  "dist/",
  "scripts/local-beta-common.ps1",
  "scripts/install-local-beta.ps1",
  "scripts/update-local-beta.ps1",
  "scripts/uninstall-local-beta.ps1",
  "scripts/kairon-update-check-task.ps1",
  "scripts/kairon-dr-verify-task.ps1",
  "docs/installation.md",
  "README.md"
];

const forbiddenPackagePathPatterns = [
  /^package\/(?:tests?|src|node_modules|operation-test-results|release-artifacts)(?:\/|$)/u,
  /^package\/\.kairon(?:\/|$)/u,
  /(?:^|\/)\.env(?:\.|$)/u,
  /^package\/docs\/(?!installation\.md$)/u
];

export async function createLocalBetaPackage(
  projectRoot: string,
  options: LocalBetaPackOptions = {}
): Promise<LocalBetaPackResult> {
  await assertLocalBetaSource(projectRoot);
  const outputRoot = path.resolve(
    projectRoot,
    options.output ?? path.join("release-artifacts", await readPackageVersion(projectRoot))
  );
  await mkdir(outputRoot, { recursive: true });
  const commandRunner = options.commandRunner ?? spawnCommandRunner;
  const result = await commandRunner({
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["pack", "--json", "--pack-destination", outputRoot],
    cwd: projectRoot,
    timeoutMs: 120_000
  });

  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(
      `npm pack failed: ${sanitizeProcessError(result.stderr || result.stdout)}`
    );
  }

  const packageFile = parseNpmPackFilename(result.stdout);
  const packagePath = path.resolve(outputRoot, packageFile);
  await access(packagePath);
  const inspection = await inspectPackage(packagePath);
  const packageJson = parsePackagedPackageJson(inspection.entries);
  const manifestPath = `${packagePath}.sha256.json`;
  const manifest: LocalBetaPackageManifest = {
    schema_version: "0.1",
    artifact_kind: "local_beta_package",
    package_name: "kairon",
    package_version: requireString(packageJson.version, "package version"),
    package_file: path.basename(packagePath),
    sha256: inspection.sha256,
    size_bytes: inspection.sizeBytes,
    files: inspection.entries.map((entry) => ({
      path: entry.path,
      size_bytes: entry.size,
      type: entry.type === "directory" ? "directory" : "file"
    })),
    created_at: (options.now?.() ?? new Date()).toISOString()
  };
  await writeJsonFileAtomic(manifestPath, manifest);
  const verification = await verifyLocalBetaPackage(packagePath, manifestPath);
  if (!verification.ok) {
    throw new Error(
      `Local release package verification failed: ${verification.checks
        .filter((check) => check.status === "fail")
        .map((check) => check.id)
        .join(", ")}`
    );
  }

  return {
    schema_version: "0.1",
    status: "created",
    package_path: packagePath,
    manifest_path: manifestPath,
    package_name: manifest.package_name,
    package_version: manifest.package_version,
    sha256: manifest.sha256,
    size_bytes: manifest.size_bytes,
    files: verification.files,
    verification
  };
}

export async function verifyLocalBetaPackage(
  packageFile: string,
  manifestFile?: string
): Promise<LocalBetaVerificationResult> {
  const packagePath = path.resolve(packageFile);
  const manifestPath = path.resolve(manifestFile ?? `${packagePath}.sha256.json`);
  const checks: LocalBetaVerificationCheck[] = [];
  checks.push(check(
    "package_extension",
    packagePath.toLowerCase().endsWith(".tgz"),
    packagePath.toLowerCase().endsWith(".tgz")
      ? "Package uses the .tgz extension."
      : "Local release package must use the .tgz extension."
  ));

  const manifest = await readManifest(manifestPath);
  checks.push(check(
    "manifest_schema",
    isLocalBetaManifest(manifest),
    isLocalBetaManifest(manifest)
      ? "Checksum manifest schema and artifact kind are valid."
      : "Checksum manifest schema or artifact kind is invalid."
  ));

  const inspection = await inspectPackage(packagePath);
  const packageJson = parsePackagedPackageJson(inspection.entries);
  const packageName = optionalString(packageJson.name);
  const packageVersion = optionalString(packageJson.version);
  const manifestValid = isLocalBetaManifest(manifest);
  checks.push(check(
    "manifest_filename",
    manifestValid && manifest.package_file === path.basename(packagePath),
    manifestValid && manifest.package_file === path.basename(packagePath)
      ? "Manifest is bound to the selected package filename."
      : "Manifest package_file does not match the selected package."
  ));
  checks.push(check(
    "package_size",
    manifestValid && manifest.size_bytes === inspection.sizeBytes,
    manifestValid && manifest.size_bytes === inspection.sizeBytes
      ? `Package size matches ${inspection.sizeBytes} bytes.`
      : "Package size does not match the manifest."
  ));
  checks.push(check(
    "package_sha256",
    manifestValid && safeEqual(manifest.sha256, inspection.sha256),
    manifestValid && safeEqual(manifest.sha256, inspection.sha256)
      ? "Package SHA-256 matches the manifest."
      : "Package SHA-256 does not match the manifest."
  ));
  checks.push(check(
    "tar_limits_safe",
    true,
    `Archive limits passed: compressed=${inspection.sizeBytes} expanded=${inspection.expandedBytes} entries=${inspection.entries.length}.`
  ));

  const unsafePaths = inspection.entries.filter((entry) => !isSafeTarPath(entry.path));
  checks.push(check(
    "tar_paths_safe",
    unsafePaths.length === 0,
    unsafePaths.length === 0
      ? "All package paths are relative and traversal-free."
      : `Unsafe package paths: ${unsafePaths.map((entry) => entry.path).join(", ")}`
  ));
  const pathCounts = new Map<string, number>();
  for (const entry of inspection.entries) {
    const normalized = entry.path.toLowerCase();
    pathCounts.set(normalized, (pathCounts.get(normalized) ?? 0) + 1);
  }
  const caseCollisions = [...pathCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([entryPath]) => entryPath);
  checks.push(check(
    "tar_case_collisions_absent",
    caseCollisions.length === 0,
    caseCollisions.length === 0
      ? "Package contains no case-insensitive path collisions."
      : `Case-insensitive package path collisions: ${caseCollisions.join(", ")}`
  ));
  const links = inspection.entries.filter((entry) => entry.type === "link");
  checks.push(check(
    "tar_links_absent",
    links.length === 0,
    links.length === 0
      ? "Package contains no symbolic or hard links."
      : `Package links are forbidden: ${links.map((entry) => entry.path).join(", ")}`
  ));

  const entryPaths = new Set(inspection.entries.map((entry) => entry.path));
  const missing = requiredPackageFiles.filter((required) => !entryPaths.has(required));
  checks.push(check(
    "required_files",
    missing.length === 0,
    missing.length === 0
      ? "All required runtime, script, and documentation files are present."
      : `Required package files are missing: ${missing.join(", ")}`
  ));
  const forbidden = inspection.entries.filter((entry) =>
    forbiddenPackagePathPatterns.some((pattern) => pattern.test(entry.path)) ||
    !isAllowedPackagePath(entry.path)
  );
  checks.push(check(
    "forbidden_files_absent",
    forbidden.length === 0,
    forbidden.length === 0
      ? "Tests, local state, credentials, and local-only documents are absent."
      : `Forbidden package files are present: ${forbidden
          .map((entry) => entry.path)
          .join(", ")}`
  ));

  const metadataValid =
    packageName === "kairon" &&
    typeof packageVersion === "string" &&
    /^\d+\.\d+\.\d+$/u.test(packageVersion) &&
    packageJson.private === true &&
    packageJson.license === "UNLICENSED" &&
    hasExpectedBin(packageJson.bin) &&
    hasExpectedFilesAllowlist(packageJson.files);
  checks.push(check(
    "package_metadata",
    metadataValid,
    metadataValid
      ? `Package metadata is valid for private local release ${packageVersion}.`
      : "Package metadata must keep name=kairon, private=true, license=UNLICENSED, the CLI bin, and the fixed files allowlist."
  ));

  const actualManifestFiles = inspection.entries.map((entry) => ({
    path: entry.path,
    size_bytes: entry.size,
    type: entry.type === "directory" ? "directory" as const : "file" as const
  }));
  const fileSetValid =
    manifestValid &&
    JSON.stringify(manifest.files) === JSON.stringify(actualManifestFiles);
  checks.push(check(
    "manifest_file_set",
    fileSetValid,
    fileSetValid
      ? "Manifest file inventory matches the tarball exactly."
      : "Manifest file inventory does not match the tarball."
  ));

  return {
    schema_version: "0.1",
    ok: checks.every((entry) => entry.status === "pass"),
    package_path: packagePath,
    manifest_path: manifestPath,
    package_name: packageName,
    package_version: packageVersion,
    sha256: inspection.sha256,
    size_bytes: inspection.sizeBytes,
    files: inspection.entries.length,
    checks
  };
}

function isAllowedPackagePath(value: string): boolean {
  return (
    value === "package/package.json" ||
    value === "package/README.md" ||
    value === "package/docs/installation.md" ||
    value === "package/scripts/local-beta-common.ps1" ||
    value === "package/scripts/install-local-beta.ps1" ||
    value === "package/scripts/update-local-beta.ps1" ||
    value === "package/scripts/uninstall-local-beta.ps1" ||
    value === "package/scripts/kairon-update-check-task.ps1" ||
    value === "package/scripts/kairon-dr-verify-task.ps1" ||
    value === "package/dist" ||
    value.startsWith("package/dist/")
  );
}

export function formatLocalBetaPack(result: LocalBetaPackResult): string {
  return [
    "Kairon local release package created.",
    `status=${result.status}`,
    `package=${result.package_path}`,
    `manifest=${result.manifest_path}`,
    `name=${result.package_name}`,
    `version=${result.package_version}`,
    `sha256=${result.sha256}`,
    `size_bytes=${result.size_bytes}`,
    `files=${result.files}`,
    `verification.ok=${result.verification.ok}`
  ].join("\n");
}

export function formatLocalBetaVerification(
  result: LocalBetaVerificationResult
): string {
  return [
    "Kairon local release package verification:",
    `verification.ok=${result.ok}`,
    `package=${result.package_path}`,
    `manifest=${result.manifest_path}`,
    `name=${result.package_name ?? "unknown"}`,
    `version=${result.package_version ?? "unknown"}`,
    `sha256=${result.sha256}`,
    `size_bytes=${result.size_bytes}`,
    `files=${result.files}`,
    ...result.checks.map(
      (entry) => `${entry.status.toUpperCase()} ${entry.id} ${entry.details}`
    )
  ].join("\n");
}

async function assertLocalBetaSource(projectRoot: string): Promise<void> {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8")
  ) as PackageJson;
  if (
    packageJson.name !== "kairon" ||
    packageJson.private !== true ||
    packageJson.license !== "UNLICENSED" ||
    !hasExpectedBin(packageJson.bin) ||
    !hasExpectedFilesAllowlist(packageJson.files)
  ) {
    throw new Error(
      "package.json does not satisfy the private local release package policy."
    );
  }

  for (const required of requiredPackageFiles.filter((entry) => entry !== "package/package.json")) {
    const sourcePath = required.replace(/^package\//u, "");
    await access(path.join(projectRoot, sourcePath));
  }
}

async function inspectPackage(packagePath: string): Promise<{
  sha256: string;
  sizeBytes: number;
  expandedBytes: number;
  entries: TarEntry[];
}> {
  const info = await stat(packagePath);
  if (info.size > stableArchivePolicyLimits.max_archive_bytes) {
    throw new Error("Local release package exceeds the archive size limit.");
  }
  const buffer = await readFile(packagePath);
  let tar: Buffer;
  try {
    tar = gunzipSync(buffer, {
      maxOutputLength: stableArchivePolicyLimits.max_expanded_bytes
    });
  } catch {
    throw new Error(
      "Local release package is not a valid or bounded gzip archive."
    );
  }
  const entries = parseTar(tar);
  const policy = evaluateArchivePolicy({
    archive_bytes: info.size,
    expanded_bytes: tar.length,
    required_root: "package",
    entries: entries
      .filter((entry) => entry.type !== "other")
      .map((entry) => ({
        path: entry.path,
        size_bytes: entry.size,
        type: entry.type as "file" | "directory" | "link"
      }))
  });
  if (!policy.ok) {
    throw new Error(
      `Local release package violates archive limits: ${policy.violations.join(", ")}.`
    );
  }
  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    sizeBytes: info.size,
    expandedBytes: tar.length,
    entries
  };
}

function parseTar(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let headerCount = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    headerCount += 1;
    if (headerCount > stableArchivePolicyLimits.max_entries) {
      throw new Error("Local beta tarball exceeds the header count limit.");
    }
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const entryPath = toPosixPath(prefix.length > 0 ? `${prefix}/${name}` : name);
    const sizeText = readTarString(header, 124, 12).trim();
    const size = sizeText.length === 0 ? 0 : Number.parseInt(sizeText, 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Invalid tar entry size for ${entryPath || "unknown"}.`);
    }
    if (size > stableArchivePolicyLimits.max_entry_bytes) {
      throw new Error(
        `Tar entry exceeds the size limit: ${entryPath || "unknown"}.`
      );
    }
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const type = tarEntryType(typeFlag);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > buffer.length) {
      throw new Error(`Truncated tar entry: ${entryPath}.`);
    }
    if (entryPath.length > 0 && type !== "other") {
      if (entries.length >= stableArchivePolicyLimits.max_entries) {
        throw new Error("Local beta tarball exceeds the entry count limit.");
      }
      entries.push({
        path: entryPath.replace(/\/$/u, ""),
        size,
        type,
        content: Buffer.from(buffer.subarray(contentStart, contentEnd))
      });
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  if (entries.length === 0) {
    throw new Error("Local beta tarball contains no package entries.");
  }
  return entries;
}

function tarEntryType(value: string): TarEntry["type"] {
  if (value === "\0" || value === "0") {
    return "file";
  }
  if (value === "5") {
    return "directory";
  }
  if (value === "1" || value === "2") {
    return "link";
  }
  return "other";
}

function readTarString(buffer: Buffer, start: number, length: number): string {
  const end = buffer.indexOf(0, start);
  const actualEnd = end === -1 || end > start + length ? start + length : end;
  return buffer.subarray(start, actualEnd).toString("utf8").trim();
}

function parsePackagedPackageJson(entries: TarEntry[]): PackageJson {
  const packageEntry = entries.find(
    (entry) => entry.path === "package/package.json" && entry.type === "file"
  );
  if (packageEntry === undefined) {
    return {};
  }
  try {
    return JSON.parse(packageEntry.content.toString("utf8")) as PackageJson;
  } catch {
    return {};
  }
}

async function readManifest(manifestPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Failed to read local release checksum manifest: ${String(error)}`);
  }
}

function isLocalBetaManifest(value: unknown): value is LocalBetaPackageManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const manifest = value as Partial<LocalBetaPackageManifest>;
  return (
    manifest.schema_version === "0.1" &&
    manifest.artifact_kind === "local_beta_package" &&
    manifest.package_name === "kairon" &&
    typeof manifest.package_version === "string" &&
    typeof manifest.package_file === "string" &&
    typeof manifest.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(manifest.sha256) &&
    Number.isInteger(manifest.size_bytes) &&
    (manifest.size_bytes ?? 0) > 0 &&
    Array.isArray(manifest.files)
  );
}

function isSafeTarPath(value: string): boolean {
  return validatePortableArchivePath(value, {
    requiredRoot: "package"
  }).length === 0;
}

function hasExpectedBin(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).kairon === "./dist/cli/main.js"
  );
}

function hasExpectedFilesAllowlist(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === requiredFilesAllowlist.length &&
    requiredFilesAllowlist.every((entry, index) => value[index] === entry)
  );
}

function parseNpmPackFilename(stdout: string): string {
  try {
    const records = JSON.parse(stdout) as NpmPackRecord[];
    const filename = records[0]?.filename;
    if (typeof filename === "string" && filename.endsWith(".tgz")) {
      return path.basename(filename);
    }
  } catch {
    // The normalized error below deliberately excludes raw npm output.
  }
  throw new Error("npm pack did not return a valid JSON package filename.");
}

async function readPackageVersion(projectRoot: string): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8")
  ) as PackageJson;
  return requireString(packageJson.version, "package version");
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing ${field}.`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function check(
  id: LocalBetaVerificationCheck["id"],
  passed: boolean,
  details: string
): LocalBetaVerificationCheck {
  return { id, status: passed ? "pass" : "fail", details };
}

function safeEqual(left: string, right: string): boolean {
  return left.length === right.length && left === right;
}

function sanitizeProcessError(value: string): string {
  return value
    .replace(
      /(api[_-]?key|api[_-]?token|token|secret|password|authorization|cookie)\s*[:=]\s*["']?[^"',;\s]+/giu,
      "$1=[redacted]"
    )
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/giu, "Bearer [redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}
