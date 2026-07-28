import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  spawnCommandRunner,
  type CommandRunner
} from "../../agents/command-runner.js";
import { readJsonFile, writeJsonFileAtomic } from "../../core/fs/json-file.js";
import { resolveInside } from "../../core/fs/paths.js";
import {
  createLocalBetaPackage,
  formatLocalBetaPack,
  formatLocalBetaVerification,
  verifyLocalBetaPackage,
  type LocalBetaPackOptions
} from "../../release/local-beta.js";
import {
  createReleaseManifest,
  formatReleaseManifest,
  formatReleaseManifestVerification,
  verifyReleaseManifest,
  type CreateReleaseManifestOptions
} from "../../release/release-manifest.js";
import { parseReleaseVerificationContext } from "../../release/verification-context.js";
import {
  createReleaseProvenance,
  formatReleaseProvenance,
  type CreateReleaseProvenanceOptions
} from "../../release/provenance.js";
import {
  createReleaseSbom,
  formatReleaseSbom,
  type CreateReleaseSbomOptions
} from "../../release/sbom.js";
import {
  formatGitHubReleaseResult,
  planGitHubRelease,
  publishGitHubRelease,
  verifyGitHubRelease,
  type GitHubReleaseDependencies,
  type GitHubReleasePlanRequest,
  type GitHubReleasePublishRequest,
  type GitHubReleaseVerifyRequest
} from "../../release/github-release.js";
import {
  applyStablePromotion,
  formatStablePromotionResult,
  planStablePromotion,
  type StablePromotionApplyRequest,
  type StablePromotionDependencies,
  type StablePromotionPlanRequest
} from "../../release/stable-promotion.js";

export type ReleaseCheckResult = {
  schema_version: string;
  package_version: string;
  cli_version: string;
  version_sync: boolean;
  docs: {
    release_checklist: boolean;
    release_notes: boolean;
  };
  recommended_commands: string[];
  manual_checks: string[];
};

export type ReleaseValidationCheck = {
  id:
    | "package_version_semver"
    | "cli_version_semver"
    | "version_sync"
    | "package_lock_version"
    | "release_checklist"
    | "release_notes_unreleased"
    | "release_notes_target_version";
  status: "pass" | "fail";
  details: string;
};

export type ReleaseValidationResult = {
  schema_version: string;
  ok: boolean;
  target_version: string;
  package_version: string;
  cli_version: string;
  checks: ReleaseValidationCheck[];
};

export type ReleaseNotesResult = {
  schema_version: string;
  since: string;
  commit_count: number;
  commits: string[];
  dry_run: boolean;
  write: boolean;
  target_path: string;
  action: "would_append" | "appended";
  backup_artifact?: string;
  append_preview: string;
};

export type ReleaseBumpType = "major" | "minor" | "patch" | "explicit";

export type ReleaseBumpResult = {
  schema_version: string;
  type: ReleaseBumpType;
  current_version: string;
  next_version: string;
  dry_run: boolean;
  write: boolean;
  backup_artifact?: string;
  diff_preview: string[];
  files: Array<{
    path: string;
    current: string;
    next: string;
    action: "unchanged" | "would_update" | "updated";
  }>;
};

export type ReleaseNotesCommandOptions = {
  since?: string;
  dryRun?: boolean;
  write?: boolean;
  commandRunner?: CommandRunner;
  now?: () => Date;
};

export type ReleaseBumpCommandOptions = {
  type?: string;
  version?: string;
  dryRun?: boolean;
  write?: boolean;
  commandRunner?: CommandRunner;
  now?: () => Date;
};

export type ReleaseVerifyCommandOptions = {
  manifest?: string;
  releaseManifest?: string;
  verificationContext?: string;
  commandRunner?: CommandRunner;
};

export type ReleaseManifestCommandOptions = CreateReleaseManifestOptions & {
  package?: string;
  manifest?: string;
};

export type ReleaseSbomCommandOptions = CreateReleaseSbomOptions & {
  manifest?: string;
};

export type ReleaseProvenanceCommandOptions = CreateReleaseProvenanceOptions & {
  package?: string;
  manifest?: string;
  sbom?: string;
};

export type ReleaseGitHubPlanCommandOptions = GitHubReleasePlanRequest;
export type ReleaseGitHubPublishCommandOptions = Omit<
  GitHubReleasePublishRequest,
  "planId"
>;
export type ReleaseGitHubVerifyCommandOptions = GitHubReleaseVerifyRequest;
export type ReleaseStablePromotionPlanCommandOptions = StablePromotionPlanRequest;
export type ReleaseStablePromotionApplyCommandOptions = Omit<
  StablePromotionApplyRequest,
  "planId"
>;

type PackageJson = {
  version?: unknown;
  [key: string]: unknown;
};

type PackageLockJson = {
  version?: unknown;
  packages?: Record<string, { version?: unknown; [key: string]: unknown }>;
  [key: string]: unknown;
};

export async function releaseCheckCommand(projectRoot: string): Promise<string> {
  return formatReleaseCheck(await collectReleaseCheck(projectRoot));
}

export async function releaseNotesCommand(
  projectRoot: string,
  options: ReleaseNotesCommandOptions = {}
): Promise<string> {
  return formatReleaseNotes(await createReleaseNotesDraft(projectRoot, options));
}

export async function releaseBumpCommand(
  projectRoot: string,
  options: ReleaseBumpCommandOptions = {}
): Promise<string> {
  return formatReleaseBump(await planReleaseBump(projectRoot, options));
}

export async function releasePackCommand(
  projectRoot: string,
  options: LocalBetaPackOptions = {}
): Promise<string> {
  const releaseValidation = await validateRelease(projectRoot);
  if (!releaseValidation.ok) {
    throw new Error(
      `Release validation failed before pack: ${releaseValidation.checks
        .filter((check) => check.status === "fail")
        .map((check) => check.id)
        .join(", ")}`
    );
  }
  return formatLocalBetaPack(await createLocalBetaPackage(projectRoot, options));
}

export async function releaseVerifyCommand(
  packageFile: string,
  options: ReleaseVerifyCommandOptions = {},
  projectRoot?: string
): Promise<{ text: string; ok: boolean }> {
  const result = await verifyLocalBetaPackage(packageFile, options.manifest);
  if (options.releaseManifest === undefined) {
    return { text: formatLocalBetaVerification(result), ok: result.ok };
  }

  const verificationContext = parseReleaseVerificationContext(
    options.verificationContext
  );
  const releaseManifest = await verifyReleaseManifest(
    options.releaseManifest,
    packageFile,
    options.manifest,
    {
      projectRoot,
      commandRunner: options.commandRunner,
      verificationContext
    }
  );
  return {
    text: [
      formatLocalBetaVerification(result),
      "",
      formatReleaseManifestVerification(releaseManifest)
    ].join("\n"),
    ok: result.ok && releaseManifest.ok
  };
}

export async function releaseSbomCommand(
  projectRoot: string,
  options: ReleaseSbomCommandOptions = {}
): Promise<string> {
  if (options.manifest === undefined || options.manifest.trim().length === 0) {
    throw new Error("Specify --manifest <checksum-manifest.json>.");
  }
  return formatReleaseSbom(await createReleaseSbom(
    projectRoot,
    options.manifest,
    options
  ));
}

export async function releaseProvenanceCommand(
  projectRoot: string,
  options: ReleaseProvenanceCommandOptions = {}
): Promise<string> {
  if (options.package === undefined || options.package.trim().length === 0) {
    throw new Error("Specify --package <package.tgz>.");
  }
  if (options.manifest === undefined || options.manifest.trim().length === 0) {
    throw new Error("Specify --manifest <checksum-manifest.json>.");
  }
  if (options.sbom === undefined || options.sbom.trim().length === 0) {
    throw new Error("Specify --sbom <sbom.cdx.json>.");
  }
  return formatReleaseProvenance(await createReleaseProvenance(
    projectRoot,
    options.package,
    options.manifest,
    options.sbom,
    options
  ));
}

export async function releaseManifestCommand(
  projectRoot: string,
  options: ReleaseManifestCommandOptions = {}
): Promise<string> {
  if (options.package === undefined || options.package.trim().length === 0) {
    throw new Error("Specify --package <package.tgz>.");
  }
  if (options.manifest === undefined || options.manifest.trim().length === 0) {
    throw new Error("Specify --manifest <checksum-manifest.json>.");
  }
  const releaseValidation = await validateRelease(projectRoot);
  if (!releaseValidation.ok) {
    throw new Error(
      `Release validation failed before manifest generation: ${releaseValidation.checks
        .filter((check) => check.status === "fail")
        .map((check) => check.id)
        .join(", ")}`
    );
  }
  return formatReleaseManifest(await createReleaseManifest(
    projectRoot,
    options.package,
    options.manifest,
    options
  ));
}

export async function releaseGitHubPlanCommand(
  projectRoot: string,
  options: ReleaseGitHubPlanCommandOptions,
  deps: GitHubReleaseDependencies = {}
): Promise<string> {
  return formatGitHubReleaseResult(
    await planGitHubRelease(projectRoot, options, deps),
    projectRoot
  );
}

export async function releaseGitHubPublishCommand(
  projectRoot: string,
  planId: string,
  options: ReleaseGitHubPublishCommandOptions,
  deps: GitHubReleaseDependencies = {}
): Promise<string> {
  return formatGitHubReleaseResult(
    await publishGitHubRelease(projectRoot, { planId, ...options }, deps),
    projectRoot
  );
}

export async function releaseGitHubVerifyCommand(
  projectRoot: string,
  options: ReleaseGitHubVerifyCommandOptions,
  deps: GitHubReleaseDependencies = {}
): Promise<string> {
  return formatGitHubReleaseResult(
    await verifyGitHubRelease(projectRoot, options, deps),
    projectRoot
  );
}

export async function releaseStablePromotionPlanCommand(
  projectRoot: string,
  options: ReleaseStablePromotionPlanCommandOptions,
  deps: StablePromotionDependencies = {}
): Promise<string> {
  return formatStablePromotionResult(
    await planStablePromotion(projectRoot, options, deps),
    projectRoot
  );
}

export async function releaseStablePromotionApplyCommand(
  projectRoot: string,
  planId: string,
  options: ReleaseStablePromotionApplyCommandOptions,
  deps: StablePromotionDependencies = {}
): Promise<string> {
  return formatStablePromotionResult(
    await applyStablePromotion(projectRoot, { planId, ...options }, deps),
    projectRoot
  );
}

export async function collectReleaseCheck(
  projectRoot: string
): Promise<ReleaseCheckResult> {
  const packageVersion = await readPackageVersion(projectRoot);
  const cliVersion = await readCliVersion(projectRoot);

  return {
    schema_version: "0.1",
    package_version: packageVersion,
    cli_version: cliVersion,
    version_sync: packageVersion === cliVersion,
    docs: {
      release_checklist: await fileExists(projectRoot, "docs/release-checklist-v0.md"),
      release_notes: await fileExists(projectRoot, "docs/release-notes-v0.md")
    },
    recommended_commands: [
      "git status --short",
      "kairon release validate",
      "kairon readiness check",
      "npm run build",
      "npm test",
      "npx vitest run tests\\pr-release-docs.test.ts"
    ],
    manual_checks: [
      "Confirm release PRs are merged.",
      "Confirm operation-test evidence is recorded when the release scope requires it.",
      "Confirm generated artifacts, local state, and secret values are not committed."
    ]
  };
}

export async function validateRelease(
  projectRoot: string
): Promise<ReleaseValidationResult> {
  const packageVersion = await readPackageVersion(projectRoot);
  const cliVersion = await readCliVersion(projectRoot);
  const packageLockVersions = await readPackageLockVersions(projectRoot);
  const checklist = await readOptionalText(projectRoot, "docs/release-checklist-v0.md");
  const notes = await readOptionalText(projectRoot, "docs/release-notes-v0.md");
  const packageVersionValid = isCoreSemanticVersion(packageVersion);
  const cliVersionValid = isCoreSemanticVersion(cliVersion);
  const checklistValid = hasAllMarkers(checklist, [
    "<!-- kairon:release-readiness -->",
    "<!-- kairon:release-evidence -->",
    "<!-- kairon:versioning-policy -->"
  ]);
  const unreleasedValid = notes !== undefined &&
    /^##\s+Unreleased\s*$/mu.test(notes) &&
    notes.includes("<!-- kairon:release-notes-unreleased -->");
  const targetVersionValid = packageVersionValid &&
    notes !== undefined &&
    releaseNotesContainVersion(notes, packageVersion);
  const checks: ReleaseValidationCheck[] = [
    validationCheck(
      "package_version_semver",
      packageVersionValid,
      packageVersionValid
        ? `package.json version ${packageVersion} is valid.`
        : `package.json version ${packageVersion} must use x.y.z core SemVer.`
    ),
    validationCheck(
      "cli_version_semver",
      cliVersionValid,
      cliVersionValid
        ? `KAIRON_VERSION ${cliVersion} is valid.`
        : `KAIRON_VERSION ${cliVersion} must use x.y.z core SemVer.`
    ),
    validationCheck(
      "version_sync",
      packageVersion === cliVersion,
      packageVersion === cliVersion
        ? `package.json and KAIRON_VERSION both use ${packageVersion}.`
          : `Version mismatch: package.json=${packageVersion}, KAIRON_VERSION=${cliVersion}.`
    ),
    validationCheck(
      "package_lock_version",
      packageLockVersions === null || (
        packageLockVersions.version === packageVersion &&
        packageLockVersions.rootVersion === packageVersion
      ),
      packageLockVersions === null
        ? "package-lock.json is absent; no lockfile version sync is required."
        : packageLockVersions.version === packageVersion &&
            packageLockVersions.rootVersion === packageVersion
          ? `package-lock.json versions match ${packageVersion}.`
          : `package-lock.json version mismatch: top=${packageLockVersions.version}, root=${packageLockVersions.rootVersion}, package=${packageVersion}.`
    ),
    validationCheck(
      "release_checklist",
      checklistValid,
      checklistValid
        ? "Release checklist contains all required markers."
        : checklist === undefined
          ? "docs/release-checklist-v0.md is missing."
          : "Release checklist must contain readiness, evidence, and versioning markers."
    ),
    validationCheck(
      "release_notes_unreleased",
      unreleasedValid,
      unreleasedValid
        ? "Release notes contain the Unreleased heading and marker."
        : notes === undefined
          ? "docs/release-notes-v0.md is missing."
          : "Release notes must contain the Unreleased heading and marker."
    ),
    validationCheck(
      "release_notes_target_version",
      targetVersionValid,
      targetVersionValid
        ? `Release notes contain target version ${packageVersion}.`
        : packageVersionValid
          ? `Release notes must contain a heading for target version ${packageVersion}.`
          : "Target version entry cannot be checked until package.json uses valid SemVer."
    )
  ];

  return {
    schema_version: "0.1",
    ok: checks.every((check) => check.status === "pass"),
    target_version: packageVersion,
    package_version: packageVersion,
    cli_version: cliVersion,
    checks
  };
}

export async function createReleaseNotesDraft(
  projectRoot: string,
  options: ReleaseNotesCommandOptions = {}
): Promise<ReleaseNotesResult> {
  if (options.since === undefined || options.since.trim().length === 0) {
    throw new Error("Specify --since <ref>.");
  }

  const since = options.since.trim();
  const commandRunner = options.commandRunner ?? spawnCommandRunner;
  const result = await commandRunner({
    command: "git",
    args: ["log", "--no-merges", "--pretty=format:%s", `${since}..HEAD`],
    cwd: projectRoot
  });

  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`Failed to collect release notes: ${result.stderr || result.stdout}`);
  }

  const commits = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const sanitizedCommits = commits.map(redactReleaseText);
  const write = options.write === true;
  if (write && options.dryRun === true) {
    throw new Error("Use either --write or --dry-run, not both.");
  }
  const targetPath = "docs/release-notes-v0.md";
  const appendPreview = formatReleaseNotesAppendBlock({
    since,
    commits: sanitizedCommits,
    now: options.now?.() ?? new Date()
  });
  let backupArtifact: string | undefined;

  if (write) {
    await assertCleanTrackedTree(projectRoot, commandRunner);
    const targetAbsolutePath = resolveInside(projectRoot, targetPath);
    const current = await readFile(targetAbsolutePath, "utf8");
    const next = appendReleaseNotesBlock(current, appendPreview);
    backupArtifact = await writeReleaseBackup(projectRoot, [
      {
        relativePath: targetPath,
        content: current
      }
    ], options.now?.() ?? new Date());
    await writeFile(targetAbsolutePath, next, "utf8");
  }

  return {
    schema_version: "0.1",
    since,
    commit_count: sanitizedCommits.length,
    commits: sanitizedCommits,
    dry_run: !write,
    write,
    target_path: targetPath,
    action: write ? "appended" : "would_append",
    backup_artifact: backupArtifact,
    append_preview: appendPreview
  };
}

export async function planReleaseBump(
  projectRoot: string,
  options: ReleaseBumpCommandOptions = {}
): Promise<ReleaseBumpResult> {
  const type = parseBumpType(options);
  const write = options.write === true;
  if (write && options.dryRun === true) {
    throw new Error("Use either --write or --dry-run, not both.");
  }
  const dryRun = !write;
  const commandRunner = options.commandRunner ?? spawnCommandRunner;
  const packagePath = resolveInside(projectRoot, "package.json");
  const indexPath = resolveInside(projectRoot, "src", "index.ts");
  const packageJson = await readJsonFile<PackageJson>(packagePath);
  const currentVersion = assertSemanticVersion(
    assertVersion(packageJson.version, "package.json"),
    "package.json"
  );
  const cliSource = await readFile(indexPath, "utf8");
  const cliVersion = assertSemanticVersion(
    extractCliVersion(cliSource),
    "src/index.ts"
  );

  if (currentVersion !== cliVersion) {
    throw new Error(
      `Version mismatch: package.json=${currentVersion}, src/index.ts=${cliVersion}`
    );
  }

  const nextVersion =
    options.version === undefined
      ? bumpVersion(currentVersion, type)
      : normalizeExplicitVersion(options.version);
  const packageNext = {
    ...packageJson,
    version: nextVersion
  };
  const indexNextText = replaceCliVersion(cliSource, nextVersion);
  const packageLock = await readOptionalPackageLock(projectRoot);
  const packageLockPath = resolveInside(projectRoot, "package-lock.json");
  let packageLockNext: PackageLockJson | undefined;
  if (packageLock !== undefined) {
    const lockVersion = assertVersion(packageLock.version, "package-lock.json");
    const rootVersion = assertVersion(
      packageLock.packages?.[""]?.version,
      "package-lock.json packages['']"
    );
    if (lockVersion !== currentVersion || rootVersion !== currentVersion) {
      throw new Error(
        `Version mismatch: package.json=${currentVersion}, package-lock.json=${lockVersion}, package-lock root=${rootVersion}`
      );
    }
    packageLockNext = {
      ...packageLock,
      version: nextVersion,
      packages: {
        ...packageLock.packages,
        "": {
          ...packageLock.packages?.[""],
          version: nextVersion
        }
      }
    };
  }
  let backupArtifact: string | undefined;

  if (write) {
    await assertCleanTrackedTree(projectRoot, commandRunner);
    const backupFiles = [
      {
        relativePath: "package.json",
        content: await readFile(packagePath, "utf8")
      },
      {
        relativePath: "src/index.ts",
        content: cliSource
      }
    ];
    if (packageLockNext !== undefined) {
      backupFiles.push({
        relativePath: "package-lock.json",
        content: await readFile(packageLockPath, "utf8")
      });
    }
    backupArtifact = await writeReleaseBackup(
      projectRoot,
      backupFiles,
      options.now?.() ?? new Date()
    );
    await writeJsonFileAtomic(packagePath, packageNext);
    await writeFile(indexPath, indexNextText, "utf8");
    if (packageLockNext !== undefined) {
      await writeJsonFileAtomic(packageLockPath, packageLockNext);
    }
  }

  const action = currentVersion === nextVersion
    ? "unchanged"
    : write
      ? "updated"
      : "would_update";

  return {
    schema_version: "0.1",
    type,
    current_version: currentVersion,
    next_version: nextVersion,
    dry_run: dryRun,
    write,
    backup_artifact: backupArtifact,
    diff_preview: [
      `package.json: ${currentVersion} -> ${nextVersion}`,
      `src/index.ts: ${cliVersion} -> ${nextVersion}`,
      ...(packageLockNext === undefined
        ? []
        : [`package-lock.json: ${currentVersion} -> ${nextVersion}`])
    ],
    files: [
      {
        path: "package.json",
        current: currentVersion,
        next: nextVersion,
        action
      },
      {
        path: "src/index.ts",
        current: cliVersion,
        next: nextVersion,
        action
      },
      ...(packageLockNext === undefined
        ? []
        : [{
            path: "package-lock.json",
            current: currentVersion,
            next: nextVersion,
            action
          } as const])
    ]
  };
}

export function formatReleaseCheck(result: ReleaseCheckResult): string {
  return [
    "Kairon release check:",
    `version.package=${result.package_version}`,
    `version.cli=${result.cli_version}`,
    `version.sync=${result.version_sync}`,
    `docs.release_checklist=${formatPresence(result.docs.release_checklist)}`,
    `docs.release_notes=${formatPresence(result.docs.release_notes)}`,
    "recommended.commands:",
    ...result.recommended_commands.map((command) => `- ${command}`),
    "manual.checks:",
    ...result.manual_checks.map((check) => `- ${check}`)
  ].join("\n");
}

export function formatReleaseValidation(result: ReleaseValidationResult): string {
  const passed = result.checks.filter((check) => check.status === "pass").length;
  const failed = result.checks.length - passed;

  return [
    "Kairon release validation:",
    `validation.ok=${result.ok}`,
    `version.target=${result.target_version}`,
    `version.package=${result.package_version}`,
    `version.cli=${result.cli_version}`,
    `summary.pass=${passed}`,
    `summary.fail=${failed}`,
    ...result.checks.map(
      (check) => `${check.status.toUpperCase()} ${check.id} ${check.details}`
    )
  ].join("\n");
}

export function formatReleaseNotes(result: ReleaseNotesResult): string {
  const summaryLines =
    result.commits.length === 0
      ? ["- No commits found for the selected range."]
      : result.commits.map((commit) => `- ${commit}`);

  return [
    "Kairon release notes draft:",
    `since=${result.since}`,
    `commit_count=${result.commit_count}`,
    `dry_run=${result.dry_run}`,
    `write=${result.write}`,
    `target=${result.target_path}`,
    `action=${result.action}`,
    ...(result.backup_artifact === undefined
      ? []
      : [`backup_artifact=${result.backup_artifact}`]),
    "",
    "## Release Notes Draft",
    "",
    "### Summary",
    "",
    ...summaryLines,
    "",
    "### Tests",
    "",
    "- `npm run build`",
    "- `npm test`",
    "",
    "### Manual / Operation Test Evidence",
    "",
    "-",
    "",
    "### Known Limitations",
    "",
    "-",
    "",
    "### Append Preview",
    "",
    result.append_preview
  ].join("\n");
}

export function formatReleaseBump(result: ReleaseBumpResult): string {
  return [
    result.write
      ? "Kairon release bump applied."
      : "Kairon release bump dry run.",
    `type=${result.type}`,
    `current_version=${result.current_version}`,
    `next_version=${result.next_version}`,
    `dry_run=${result.dry_run}`,
    `write=${result.write}`,
    ...(result.backup_artifact === undefined
      ? []
      : [`backup_artifact=${result.backup_artifact}`]),
    "diff.preview:",
    ...result.diff_preview.map((line) => `- ${line}`),
    ...result.files.map(
      (file) =>
        `file=${file.path} current=${file.current} next=${file.next} action=${file.action}`
    )
  ].join("\n");
}

function parseBumpType(options: ReleaseBumpCommandOptions): ReleaseBumpType {
  if (options.version !== undefined && options.type !== undefined) {
    throw new Error("Use either --version or --type, not both.");
  }
  if (options.version !== undefined) {
    return "explicit";
  }
  if (options.type === "major" || options.type === "minor" || options.type === "patch") {
    return options.type;
  }

  throw new Error("Specify --version <semver> or --type major, minor, or patch.");
}

function bumpVersion(version: string, type: ReleaseBumpType): string {
  if (type === "explicit") {
    throw new Error("Explicit release bump requires --version.");
  }
  const parsed = parseCoreSemanticVersion(version);

  const major = Number(parsed[1]);
  const minor = Number(parsed[2]);
  const patch = Number(parsed[3]);

  if (type === "major") {
    return `${major + 1}.0.0`;
  }

  if (type === "minor") {
    return `${major}.${minor + 1}.0`;
  }

  return `${major}.${minor}.${patch + 1}`;
}

function normalizeExplicitVersion(value: string): string {
  const version = value.trim();
  return assertSemanticVersion(version, "--version");
}

async function readPackageVersion(projectRoot: string): Promise<string> {
  const packageJson = await readJsonFile<PackageJson>(
    resolveInside(projectRoot, "package.json")
  );
  return assertVersion(packageJson.version, "package.json");
}

async function readOptionalPackageLock(
  projectRoot: string
): Promise<PackageLockJson | undefined> {
  try {
    return await readJsonFile<PackageLockJson>(
      resolveInside(projectRoot, "package-lock.json")
    );
  } catch (error) {
    if ((error as Error).message.includes("ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function readPackageLockVersions(projectRoot: string): Promise<{
  version: string;
  rootVersion: string;
} | null> {
  const packageLock = await readOptionalPackageLock(projectRoot);
  if (packageLock === undefined) {
    return null;
  }
  return {
    version: assertVersion(packageLock.version, "package-lock.json"),
    rootVersion: assertVersion(
      packageLock.packages?.[""]?.version,
      "package-lock.json packages['']"
    )
  };
}

async function readCliVersion(projectRoot: string): Promise<string> {
  return extractCliVersion(
    await readFile(resolveInside(projectRoot, "src", "index.ts"), "utf8")
  );
}

function assertVersion(value: unknown, source: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${source} does not contain a valid version string.`);
  }

  return value;
}

function assertSemanticVersion(value: string, source: string): string {
  if (!isCoreSemanticVersion(value)) {
    throw new Error(`${source} contains unsupported version format: ${value}`);
  }
  return value;
}

function isCoreSemanticVersion(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

function parseCoreSemanticVersion(value: string): RegExpExecArray {
  const parsed = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (parsed === null) {
    throw new Error(`Unsupported version format: ${value}`);
  }
  return parsed;
}

function extractCliVersion(source: string): string {
  const match = /KAIRON_VERSION\s*=\s*"([^"]+)"/.exec(source);
  if (match === null) {
    throw new Error("src/index.ts does not contain KAIRON_VERSION.");
  }

  return match[1];
}

function replaceCliVersion(source: string, nextVersion: string): string {
  return source.replace(
    /(KAIRON_VERSION\s*=\s*")([^"]+)(")/,
    (_match, prefix: string, _current: string, suffix: string) =>
      `${prefix}${nextVersion}${suffix}`
  );
}

async function assertCleanTrackedTree(
  projectRoot: string,
  commandRunner: CommandRunner
): Promise<void> {
  const result = await commandRunner({
    command: "git",
    args: ["status", "--porcelain", "--untracked-files=no"],
    cwd: projectRoot
  });

  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`Failed to check tracked worktree cleanliness: ${result.stderr || result.stdout}`);
  }

  const dirty = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (dirty.length > 0) {
    throw new Error(
      `Release write requires a clean tracked worktree. Dirty tracked entries: ${dirty.join(", ")}`
    );
  }
}

async function writeReleaseBackup(
  projectRoot: string,
  files: Array<{ relativePath: string; content: string }>,
  now: Date
): Promise<string> {
  const backupRoot = `.kairon/release/backups/${safeTimestamp(now)}`;
  for (const file of files) {
    const backupPath = resolveInside(projectRoot, backupRoot, file.relativePath);
    await mkdir(resolveInside(projectRoot, pathDirectory(`${backupRoot}/${file.relativePath}`)), {
      recursive: true
    });
    await writeFile(backupPath, file.content, "utf8");
  }
  return backupRoot;
}

function pathDirectory(relativePath: string): string {
  const normalized = relativePath.split("\\").join("/");
  const directory = normalized.split("/").slice(0, -1).join("/");
  return directory.length === 0 ? "." : directory;
}

function safeTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function formatReleaseNotesAppendBlock(input: {
  since: string;
  commits: string[];
  now: Date;
}): string {
  const summaryLines =
    input.commits.length === 0
      ? ["- No commits found for the selected range."]
      : input.commits.map((commit) => `- ${commit}`);

  return [
    "",
    `### Release Notes Draft ${input.now.toISOString()}`,
    "",
    `since: \`${input.since}\``,
    "",
    "#### Summary",
    "",
    ...summaryLines,
    "",
    "#### Tests",
    "",
    "- `npm run build`",
    "- `npm test`",
    "",
    "#### Manual / Operation Test Evidence",
    "",
    "-",
    "",
    "#### Known Limitations",
    "",
    "-"
  ].join("\n");
}

function appendReleaseNotesBlock(current: string, block: string): string {
  const marker = "<!-- kairon:release-notes-unreleased -->";
  const markerIndex = current.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Release notes marker not found: ${marker}`);
  }

  const insertAt = markerIndex + marker.length;
  return `${current.slice(0, insertAt)}\n${block}\n${current.slice(insertAt).replace(/^\r?\n/, "")}`;
}

function redactReleaseText(value: string): string {
  return value
    .replace(
      /"([^"]*(?:api[_-]?key|token|secret|password|authorization)[^"]*)"\s*:\s*"[^"]*"/giu,
      (_match, key: string) => `"${key}":"[redacted]"`
    )
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*[^\s"',}]+/giu,
      "$1=[redacted]"
    );
}

async function fileExists(
  projectRoot: string,
  relativePath: string
): Promise<boolean> {
  try {
    await readFile(resolveInside(projectRoot, relativePath), "utf8");
    return true;
  } catch {
    return false;
  }
}

async function readOptionalText(
  projectRoot: string,
  relativePath: string
): Promise<string | undefined> {
  try {
    return await readFile(resolveInside(projectRoot, relativePath), "utf8");
  } catch {
    return undefined;
  }
}

function validationCheck(
  id: ReleaseValidationCheck["id"],
  passed: boolean,
  details: string
): ReleaseValidationCheck {
  return {
    id,
    status: passed ? "pass" : "fail",
    details
  };
}

function hasAllMarkers(
  content: string | undefined,
  markers: string[]
): boolean {
  return content !== undefined && markers.every((marker) => content.includes(marker));
}

function releaseNotesContainVersion(notes: string, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^##\\s+${escaped}(?:\\s|$)`, "mu").test(notes);
}

function formatPresence(value: boolean): "present" | "missing" {
  return value ? "present" : "missing";
}
