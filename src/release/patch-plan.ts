import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  spawnCommandRunner,
  type CommandRunner
} from "../agents/command-runner.js";
import {
  readJsonFile,
  writeJsonFileAtomic
} from "../core/fs/json-file.js";
import { resolveInside, toPosixPath } from "../core/fs/paths.js";
import type { StableCanaryFinalResult } from "../operation-test/stable-canary.js";
import {
  isPatchVersionTransition,
  parseCoreVersion
} from "../update/channel.js";
import {
  verifyPatchCompatibilityTransactions,
  type UpdateTransactionArtifact
} from "../update/transaction.js";
import type { PostReleaseHealthResult } from "./post-release-health.js";
import {
  parseReleaseManifestContent,
  type ReleaseManifest
} from "./release-manifest.js";
import type { StablePromotionResult } from "./stable-promotion.js";

export type PatchReleaseMode = "rehearsal" | "release";

export type PatchReleasePlanFile = {
  path: string;
  role: "package" | "lockfile" | "cli" | "release_notes";
  sha256: string;
};

export type PatchReleaseRequiredCheck = {
  id: string;
  command: string;
};

export type PatchReleasePlan = {
  schema_version: "0.1";
  artifact_kind: "patch_release_plan";
  plan_id: string;
  status: "planned";
  mode: PatchReleaseMode;
  base_version: string;
  target_version: string;
  base_source_commit: string;
  expected_changed_files: PatchReleasePlanFile[];
  release_notes: {
    path: "docs/release-notes-v0.md";
    marker: "<!-- kairon:release-notes-unreleased -->";
    target_heading: string;
  };
  required_checks: PatchReleaseRequiredCheck[];
  previous_stable_compatibility: {
    from_version: string;
    to_version: string;
    sequence: ["update", "rollback", "reapply"];
  };
  write_confirmation: string;
  input_digest: string;
  plan_digest: string;
  created_at: string;
  expires_at: string;
  source_write_performed: false;
  external_publish_performed: false;
  automatic_promotion: false;
  automatic_update: false;
};

export type PatchReleasePrepareResult = {
  schema_version: "0.1";
  artifact_kind: "patch_release_prepare_result";
  plan_id: string;
  status: "prepared";
  base_version: string;
  target_version: string;
  base_source_commit: string;
  backup_artifact: string;
  changed_files: Array<{
    path: string;
    before_sha256: string;
    after_sha256: string;
  }>;
  release_notes_heading: string;
  commit_required: true;
  external_publish_performed: false;
  automatic_promotion: false;
  automatic_update: false;
  prepared_at: string;
  result_digest: string;
};

export type PatchReleaseVerificationCheck = {
  id:
    | "plan_integrity"
    | "prepare_result"
    | "source_commit"
    | "target_version"
    | "release_manifest"
    | "canary"
    | "post_release_health"
    | "update_rollback_reapply"
    | "stable_promotion"
    | "resource_cleanup"
    | "read_only_execution";
  status: "pass" | "fail";
  details: string;
};

export type PatchReleaseVerificationResult = {
  schema_version: "0.1";
  artifact_kind: "patch_release_verification_result";
  verification_id: string;
  plan_id: string;
  status: "PASS" | "FAIL";
  mode: PatchReleaseMode;
  base_version: string;
  target_version: string;
  target_source_commit: string | null;
  tag: string | null;
  release_id: number | null;
  asset_names: string[];
  canary_id: string | null;
  health_id: string | null;
  transaction_ids: string[];
  cleanup_status: string | null;
  checks: PatchReleaseVerificationCheck[];
  evidence: Array<{
    kind: string;
    path: string;
    sha256: string;
  }>;
  verified_at: string;
  result_digest: string;
  external_publish_performed: false;
  automatic_promotion: false;
  automatic_update: false;
};

export type PatchReleaseCleanupEvidence = {
  schema_version: "0.1";
  artifact_kind: "patch_release_cleanup_result";
  plan_id: string;
  status: "completed" | "not_required";
  production_release_retained: boolean;
  resources: Array<{
    kind: "release" | "tag" | "branch";
    exact_id: string;
    status: "deleted" | "verified_absent" | "retained";
  }>;
  completed_at: string;
};

export type CreatePatchReleasePlanOptions = {
  version: string;
  mode?: string;
  expiresInMinutes?: number;
  commandRunner?: CommandRunner;
  now?: () => Date;
};

export type PreparePatchReleasePlanOptions = {
  confirm?: string;
  commandRunner?: CommandRunner;
  now?: () => Date;
};

export type VerifyPatchReleasePlanOptions = {
  releaseManifest: string;
  canary: string;
  health: string;
  updateTransaction: string;
  rollbackTransaction: string;
  reapplyTransaction: string;
  promotion: string;
  cleanup: string;
  commandRunner?: CommandRunner;
  now?: () => Date;
};

type PackageJson = {
  version?: unknown;
  [key: string]: unknown;
};

type PackageLockJson = {
  version?: unknown;
  packages?: Record<string, { version?: unknown; [key: string]: unknown }>;
  [key: string]: unknown;
};

const releaseNotesPath = "docs/release-notes-v0.md" as const;
const releaseNotesMarker = "<!-- kairon:release-notes-unreleased -->" as const;
const defaultLifetimeMinutes = 24 * 60;
const requiredChecks: PatchReleaseRequiredCheck[] = [
  { id: "release_validate", command: "kairon release validate" },
  { id: "build", command: "npm run build" },
  { id: "full_test", command: "npm test" },
  {
    id: "security_baseline",
    command: "npx vitest run tests\\security-baseline.test.ts"
  },
  { id: "release_pack", command: "kairon release pack" },
  { id: "release_sbom", command: "kairon release sbom --manifest <path>" },
  {
    id: "release_provenance",
    command:
      "kairon release provenance --package <path> --manifest <path> --sbom <path>"
  },
  {
    id: "release_manifest",
    command:
      "kairon release manifest --package <path> --manifest <path> --sbom <path> --provenance <path> --patch-plan <plan-id>"
  },
  { id: "stable_canary", command: "kairon test stable-canary finalize" },
  { id: "post_release_health", command: "kairon release health check" }
];

export async function createPatchReleasePlan(
  projectRoot: string,
  options: CreatePatchReleasePlanOptions
): Promise<{ plan: PatchReleasePlan; plan_path: string; latest_path: string }> {
  const root = path.resolve(projectRoot);
  const runner = options.commandRunner ?? spawnCommandRunner;
  const now = options.now ?? (() => new Date());
  const createdAt = now();
  const mode = parsePatchReleaseMode(options.mode);
  const expiresInMinutes =
    options.expiresInMinutes ?? defaultLifetimeMinutes;
  if (!Number.isInteger(expiresInMinutes) || expiresInMinutes <= 0) {
    throw new Error("--expires-in-minutes must be a positive integer.");
  }

  const source = await collectCleanSourceState(root, runner);
  const versions = await readSynchronizedVersions(root);
  const targetVersion = options.version.trim();
  parseCoreVersion(targetVersion);
  if (!isPatchVersionTransition(versions.packageVersion, targetVersion)) {
    throw new Error(
      `Patch release requires the next patch version in the same major/minor line: ${versions.packageVersion} -> ${targetVersion}.`
    );
  }

  const notes = await readFile(resolveInside(root, releaseNotesPath), "utf8");
  assertReleaseNotesPreflight(
    notes,
    versions.packageVersion,
    targetVersion
  );
  const files = await collectExpectedFiles(root);
  const inputDigest = digest({
    mode,
    base_version: versions.packageVersion,
    target_version: targetVersion,
    base_source_commit: source.commit,
    expected_changed_files: files
  });
  const createdAtIso = createdAt.toISOString();
  const planId =
    `PRP-${createdAtIso.replace(/\D/gu, "").slice(0, 14)}-${inputDigest.slice(7, 19)}`;
  const unsigned = {
    schema_version: "0.1" as const,
    artifact_kind: "patch_release_plan" as const,
    plan_id: planId,
    status: "planned" as const,
    mode,
    base_version: versions.packageVersion,
    target_version: targetVersion,
    base_source_commit: source.commit,
    expected_changed_files: files,
    release_notes: {
      path: releaseNotesPath,
      marker: releaseNotesMarker,
      target_heading: `## ${targetVersion} - YYYY-MM-DD`
    },
    required_checks: requiredChecks,
    previous_stable_compatibility: {
      from_version: versions.packageVersion,
      to_version: targetVersion,
      sequence: ["update", "rollback", "reapply"] as [
        "update",
        "rollback",
        "reapply"
      ]
    },
    write_confirmation: planId,
    input_digest: inputDigest,
    created_at: createdAtIso,
    expires_at: new Date(
      createdAt.getTime() + expiresInMinutes * 60_000
    ).toISOString(),
    source_write_performed: false as const,
    external_publish_performed: false as const,
    automatic_promotion: false as const,
    automatic_update: false as const
  };
  const plan: PatchReleasePlan = {
    ...unsigned,
    plan_digest: digest(unsigned)
  };
  const paths = patchReleasePlanPaths(root, planId);
  await writeJsonFileAtomic(paths.planPath, plan);
  await writeJsonFileAtomic(paths.latestPath, plan);
  return {
    plan,
    plan_path: paths.planPath,
    latest_path: paths.latestPath
  };
}

export async function preparePatchReleasePlan(
  projectRoot: string,
  planId: string,
  options: PreparePatchReleasePlanOptions = {}
): Promise<{ result: PatchReleasePrepareResult; result_path: string }> {
  const root = path.resolve(projectRoot);
  const runner = options.commandRunner ?? spawnCommandRunner;
  const now = options.now ?? (() => new Date());
  const preparedAt = now();
  const plan = await loadPatchReleasePlan(root, planId);
  if (options.confirm !== plan.write_confirmation) {
    throw new Error(
      `Patch release prepare requires --confirm ${plan.write_confirmation}.`
    );
  }
  if (Date.parse(plan.expires_at) <= preparedAt.getTime()) {
    throw new Error(`Patch release plan is expired: ${plan.plan_id}`);
  }
  const source = await collectCleanSourceState(root, runner);
  if (source.commit !== plan.base_source_commit) {
    throw new Error(
      `Patch release plan source drift: expected=${plan.base_source_commit} observed=${source.commit}`
    );
  }
  await assertExpectedFilesCurrent(root, plan.expected_changed_files);
  const versions = await readSynchronizedVersions(root);
  if (versions.packageVersion !== plan.base_version) {
    throw new Error(
      `Patch release plan version drift: expected=${plan.base_version} observed=${versions.packageVersion}`
    );
  }

  const paths = patchReleasePlanPaths(root, plan.plan_id);
  const backupPath = path.join(paths.planRoot, "backup");
  await mkdir(backupPath, { recursive: false });
  const originals = new Map<string, string>();
  for (const file of plan.expected_changed_files) {
    const content = await readFile(resolveInside(root, file.path), "utf8");
    originals.set(file.path, content);
    const destination = resolveInside(backupPath, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }

  const packageJson = JSON.parse(
    originals.get("package.json") ?? "{}"
  ) as PackageJson;
  const indexSource = originals.get("src/index.ts");
  const notesSource = originals.get(releaseNotesPath);
  if (indexSource === undefined || notesSource === undefined) {
    throw new Error("Patch release plan source files are incomplete.");
  }
  packageJson.version = plan.target_version;
  const nextFiles = new Map<string, string>([
    ["package.json", `${JSON.stringify(packageJson, null, 2)}\n`],
    [
      "src/index.ts",
      replaceCliVersion(indexSource, plan.target_version)
    ],
    [
      releaseNotesPath,
      appendPatchReleaseEntry(
        notesSource,
        plan,
        preparedAt
      )
    ]
  ]);
  const lockSource = originals.get("package-lock.json");
  if (lockSource !== undefined) {
    const packageLock = JSON.parse(lockSource) as PackageLockJson;
    packageLock.version = plan.target_version;
    if (packageLock.packages?.[""] === undefined) {
      throw new Error("package-lock.json root package entry is missing.");
    }
    packageLock.packages[""].version = plan.target_version;
    nextFiles.set(
      "package-lock.json",
      `${JSON.stringify(packageLock, null, 2)}\n`
    );
  }

  try {
    for (const [relativePath, content] of nextFiles) {
      await writeFile(resolveInside(root, relativePath), content, "utf8");
    }
  } catch (error) {
    for (const [relativePath, content] of originals) {
      await writeFile(resolveInside(root, relativePath), content, "utf8");
    }
    throw error;
  }

  try {
    const changedFiles = await Promise.all(
      plan.expected_changed_files.map(async (file) => ({
        path: file.path,
        before_sha256: file.sha256,
        after_sha256: await fileDigest(resolveInside(root, file.path))
      }))
    );
    const unsigned = {
      schema_version: "0.1" as const,
      artifact_kind: "patch_release_prepare_result" as const,
      plan_id: plan.plan_id,
      status: "prepared" as const,
      base_version: plan.base_version,
      target_version: plan.target_version,
      base_source_commit: plan.base_source_commit,
      backup_artifact: toPosixPath(path.relative(root, backupPath)),
      changed_files: changedFiles,
      release_notes_heading: `## ${plan.target_version} - ${preparedAt
        .toISOString()
        .slice(0, 10)}`,
      commit_required: true as const,
      external_publish_performed: false as const,
      automatic_promotion: false as const,
      automatic_update: false as const,
      prepared_at: preparedAt.toISOString()
    };
    const result: PatchReleasePrepareResult = {
      ...unsigned,
      result_digest: digest(unsigned)
    };
    await writeJsonFileAtomic(paths.prepareResultPath, result);
    return {
      result,
      result_path: paths.prepareResultPath
    };
  } catch (error) {
    for (const [relativePath, content] of originals) {
      await writeFile(resolveInside(root, relativePath), content, "utf8");
    }
    throw error;
  }
}

export async function verifyPatchReleasePlan(
  projectRoot: string,
  planId: string,
  options: VerifyPatchReleasePlanOptions
): Promise<{ result: PatchReleaseVerificationResult; result_path: string }> {
  const root = path.resolve(projectRoot);
  const runner = options.commandRunner ?? spawnCommandRunner;
  const now = options.now ?? (() => new Date());
  const verifiedAt = now();
  const plan = await loadPatchReleasePlan(root, planId);
  const paths = patchReleasePlanPaths(root, plan.plan_id);
  const checks: PatchReleaseVerificationCheck[] = [
    check("plan_integrity", true, `Plan digest is valid: ${plan.plan_id}.`)
  ];
  const evidence: PatchReleaseVerificationResult["evidence"] = [];
  let targetCommit: string | null = null;
  let releaseManifest: ReleaseManifest | null = null;
  let canary: StableCanaryFinalResult | null = null;
  let health: PostReleaseHealthResult | null = null;
  let promotion: StablePromotionResult | null = null;
  let cleanup: PatchReleaseCleanupEvidence | null = null;
  let transactions: UpdateTransactionArtifact[] = [];

  const prepare = await readPrepareResult(paths.prepareResultPath, plan);
  checks.push(
    check(
      "prepare_result",
      prepare !== null,
      prepare === null
        ? "Patch prepare result is missing or invalid."
        : `Patch prepare result is bound to ${plan.plan_id}.`
    )
  );

  try {
    const source = await collectCleanSourceState(root, runner);
    targetCommit = source.commit;
    checks.push(
      check(
        "source_commit",
        source.commit !== plan.base_source_commit,
        source.commit === plan.base_source_commit
          ? "Prepared patch changes must be committed before verification."
          : `Target source commit is ${source.commit}.`
      )
    );
  } catch (error) {
    checks.push(
      check("source_commit", false, (error as Error).message)
    );
  }

  try {
    const versions = await readSynchronizedVersions(root);
    checks.push(
      check(
        "target_version",
        versions.packageVersion === plan.target_version,
        versions.packageVersion === plan.target_version
          ? `Package, lockfile, and CLI use ${plan.target_version}.`
          : `Expected ${plan.target_version}; observed ${versions.packageVersion}.`
      )
    );
  } catch (error) {
    checks.push(check("target_version", false, (error as Error).message));
  }

  const loaded = await Promise.all([
    loadEvidence<ReleaseManifest>(
      root,
      options.releaseManifest,
      "release_manifest",
      (value) => parseReleaseManifestContent(JSON.stringify(value))
    ),
    loadEvidence<StableCanaryFinalResult>(
      root,
      options.canary,
      "stable_canary_final_result",
      parseStableCanary
    ),
    loadEvidence<PostReleaseHealthResult>(
      root,
      options.health,
      "post_release_health_result",
      parsePostReleaseHealth
    ),
    loadEvidence<UpdateTransactionArtifact>(
      root,
      options.updateTransaction,
      "update_transaction",
      parseUpdateTransaction
    ),
    loadEvidence<UpdateTransactionArtifact>(
      root,
      options.rollbackTransaction,
      "rollback_transaction",
      parseUpdateTransaction
    ),
    loadEvidence<UpdateTransactionArtifact>(
      root,
      options.reapplyTransaction,
      "reapply_transaction",
      parseUpdateTransaction
    ),
    loadEvidence<StablePromotionResult>(
      root,
      options.promotion,
      "stable_release_promotion_result",
      parseStablePromotion
    ),
    loadEvidence<PatchReleaseCleanupEvidence>(
      root,
      options.cleanup,
      "patch_release_cleanup_result",
      parsePatchCleanup
    )
  ]);
  for (const item of loaded) {
    evidence.push(item.evidence);
  }
  releaseManifest = loaded[0].value;
  canary = loaded[1].value;
  health = loaded[2].value;
  transactions = [
    loaded[3].value,
    loaded[4].value,
    loaded[5].value
  ];
  promotion = loaded[6].value;
  cleanup = loaded[7].value;

  const manifestPassed =
    releaseManifest.package_version === plan.target_version &&
    releaseManifest.source.commit_sha === targetCommit &&
    releaseManifest.maintenance?.release_type === "patch" &&
    releaseManifest.maintenance.plan_id === plan.plan_id &&
    releaseManifest.maintenance.base_version === plan.base_version &&
    releaseManifest.maintenance.target_version === plan.target_version;
  checks.push(
    check(
      "release_manifest",
      manifestPassed,
      manifestPassed
        ? "Release manifest is bound to the patch plan, target version, and target source commit."
        : "Release manifest patch, version, or source binding is invalid."
    )
  );

  const canaryPassed =
    canary.status === "PASS" &&
    canary.version === plan.target_version &&
    canary.cleanup.unknown_sandbox_terminated === false &&
    canary.cleanup.host_cache_created === false &&
    canary.cleanup.host_credential_persisted === false;
  checks.push(
    check(
      "canary",
      canaryPassed,
      canaryPassed
        ? `Stable canary ${canary.canary_id} passed for ${canary.version}.`
        : "Stable canary did not pass or does not match the target version."
    )
  );

  const healthPassed =
    health.decision === "continue" &&
    health.release.version === plan.target_version &&
    health.release.source_commit === targetCommit &&
    health.read_only_guard.mutation_detected === false;
  checks.push(
    check(
      "post_release_health",
      healthPassed,
      healthPassed
        ? `Post-release health ${health.health_id} returned continue.`
        : "Post-release health is not continue or release binding is invalid."
    )
  );

  const compatibility = verifyPatchCompatibilityTransactions(
    plan.base_version,
    plan.target_version,
    {
      update: transactions[0],
      rollback: transactions[1],
      reapply: transactions[2]
    }
  );
  checks.push(
    check(
      "update_rollback_reapply",
      compatibility.ok,
      compatibility.ok
        ? "Previous Stable update, rollback, and reapply transactions completed in order."
        : compatibility.reasons.join(", ")
    )
  );

  const promotionPassed =
    (promotion.status === "promoted" ||
      promotion.status === "already_promoted") &&
    promotion.version === plan.target_version &&
    promotion.tag === `v${plan.target_version}` &&
    promotion.source_commit === targetCommit &&
    promotion.assets.length > 0 &&
    promotion.assets.every(
      (asset) =>
        Number.isInteger(asset.id) &&
        asset.id > 0 &&
        /^[a-f0-9]{64}$/u.test(asset.sha256)
    );
  checks.push(
    check(
      "stable_promotion",
      promotionPassed,
      promotionPassed
        ? `Stable tag ${promotion.tag} and ${promotion.assets.length} assets are bound.`
        : "Stable promotion tag, source, version, or asset binding is invalid."
    )
  );

  const cleanupPassed = verifyCleanup(plan, cleanup);
  checks.push(
    check(
      "resource_cleanup",
      cleanupPassed,
      cleanupPassed
        ? `Cleanup status ${cleanup.status} matches ${plan.mode} mode.`
        : `Cleanup evidence does not satisfy ${plan.mode} mode.`
    )
  );
  checks.push(
    check(
      "read_only_execution",
      true,
      "Verification only read evidence and wrote its local result artifact."
    )
  );

  const unsigned = {
    schema_version: "0.1" as const,
    artifact_kind: "patch_release_verification_result" as const,
    verification_id:
      `PRV-${verifiedAt
        .toISOString()
        .replace(/\D/gu, "")
        .slice(0, 14)}-${plan.plan_digest.slice(7, 19)}`,
    plan_id: plan.plan_id,
    status: checks.every((entry) => entry.status === "pass")
      ? "PASS" as const
      : "FAIL" as const,
    mode: plan.mode,
    base_version: plan.base_version,
    target_version: plan.target_version,
    target_source_commit: targetCommit,
    tag: promotion?.tag ?? null,
    release_id: promotion?.release_id ?? null,
    asset_names: promotion?.assets.map((asset) => asset.name).sort() ?? [],
    canary_id: canary?.canary_id ?? null,
    health_id: health?.health_id ?? null,
    transaction_ids: transactions.map(
      (transaction) => transaction.transaction_id
    ),
    cleanup_status: cleanup?.status ?? null,
    checks,
    evidence,
    verified_at: verifiedAt.toISOString(),
    external_publish_performed: false as const,
    automatic_promotion: false as const,
    automatic_update: false as const
  };
  const result: PatchReleaseVerificationResult = {
    ...unsigned,
    result_digest: digest(unsigned)
  };
  await writeJsonFileAtomic(paths.verificationResultPath, result);
  return {
    result,
    result_path: paths.verificationResultPath
  };
}

export async function loadPatchReleasePlan(
  projectRoot: string,
  planId: string
): Promise<PatchReleasePlan> {
  if (!/^PRP-\d{14}-[a-f0-9]{12}$/u.test(planId)) {
    throw new Error(`Invalid patch release plan id: ${planId}`);
  }
  const planPath = patchReleasePlanPaths(
    path.resolve(projectRoot),
    planId
  ).planPath;
  let value: unknown;
  try {
    value = await readJsonFile<unknown>(planPath);
  } catch {
    throw new Error(`Patch release plan was not found: ${planId}`);
  }
  if (!isPatchReleasePlan(value) || value.plan_id !== planId) {
    throw new Error(`Patch release plan is invalid: ${planId}`);
  }
  const { plan_digest: observedDigest, ...unsigned } = value;
  if (digest(unsigned) !== observedDigest) {
    throw new Error(`Patch release plan digest mismatch: ${planId}`);
  }
  const expectedInputDigest = digest({
    mode: value.mode,
    base_version: value.base_version,
    target_version: value.target_version,
    base_source_commit: value.base_source_commit,
    expected_changed_files: value.expected_changed_files
  });
  if (
    value.input_digest !== expectedInputDigest ||
    !value.plan_id.endsWith(expectedInputDigest.slice(7, 19))
  ) {
    throw new Error(`Patch release plan input digest mismatch: ${planId}`);
  }
  return value;
}

export async function loadPreparedPatchReleasePlan(
  projectRoot: string,
  planId: string
): Promise<{
  plan: PatchReleasePlan;
  prepare: PatchReleasePrepareResult;
}> {
  const root = path.resolve(projectRoot);
  const plan = await loadPatchReleasePlan(root, planId);
  const prepare = await readPrepareResult(
    patchReleasePlanPaths(root, plan.plan_id).prepareResultPath,
    plan
  );
  if (prepare === null) {
    throw new Error(
      `Patch release plan has not been prepared successfully: ${plan.plan_id}`
    );
  }
  return { plan, prepare };
}

export function formatPatchReleasePlan(input: {
  plan: PatchReleasePlan;
  plan_path: string;
}): string {
  return [
    "Kairon patch release plan created.",
    `plan_id=${input.plan.plan_id}`,
    `status=${input.plan.status}`,
    `mode=${input.plan.mode}`,
    `base_version=${input.plan.base_version}`,
    `target_version=${input.plan.target_version}`,
    `base_source_commit=${input.plan.base_source_commit}`,
    `expires_at=${input.plan.expires_at}`,
    `write_confirmation=${input.plan.write_confirmation}`,
    `plan_path=${input.plan_path}`,
    `required_checks=${input.plan.required_checks.length}`,
    "source_write_performed=false",
    "external_publish_performed=false",
    "automatic_promotion=false",
    "automatic_update=false",
    `next_command=kairon release patch prepare ${input.plan.plan_id} --confirm ${input.plan.plan_id}`
  ].join("\n");
}

export function formatPatchReleasePrepare(input: {
  result: PatchReleasePrepareResult;
  result_path: string;
}): string {
  return [
    "Kairon patch release source prepared.",
    `plan_id=${input.result.plan_id}`,
    `status=${input.result.status}`,
    `base_version=${input.result.base_version}`,
    `target_version=${input.result.target_version}`,
    `backup_artifact=${input.result.backup_artifact}`,
    `result_path=${input.result_path}`,
    "commit_required=true",
    "external_publish_performed=false",
    "automatic_promotion=false",
    "automatic_update=false",
    ...input.result.changed_files.map(
      (file) => `file=${file.path} after_sha256=${file.after_sha256}`
    )
  ].join("\n");
}

export function formatPatchReleaseVerification(input: {
  result: PatchReleaseVerificationResult;
  result_path: string;
}): string {
  return [
    "Kairon patch release verification:",
    `verification_id=${input.result.verification_id}`,
    `plan_id=${input.result.plan_id}`,
    `status=${input.result.status}`,
    `mode=${input.result.mode}`,
    `base_version=${input.result.base_version}`,
    `target_version=${input.result.target_version}`,
    `target_source_commit=${input.result.target_source_commit ?? "unknown"}`,
    `tag=${input.result.tag ?? "unknown"}`,
    `release_id=${input.result.release_id ?? "unknown"}`,
    `assets=${input.result.asset_names.length}`,
    `result_path=${input.result_path}`,
    ...input.result.checks.map(
      (entry) =>
        `${entry.status.toUpperCase()} ${entry.id} ${entry.details}`
    ),
    "external_publish_performed=false",
    "automatic_promotion=false",
    "automatic_update=false"
  ].join("\n");
}

function patchReleasePlanPaths(projectRoot: string, planId: string): {
  root: string;
  planRoot: string;
  planPath: string;
  latestPath: string;
  prepareResultPath: string;
  verificationResultPath: string;
} {
  const root = resolveInside(
    projectRoot,
    ".kairon",
    "release",
    "patch-plans"
  );
  const planRoot = resolveInside(root, planId);
  return {
    root,
    planRoot,
    planPath: resolveInside(planRoot, "plan.json"),
    latestPath: resolveInside(root, "latest.json"),
    prepareResultPath: resolveInside(planRoot, "prepare-result.json"),
    verificationResultPath: resolveInside(
      planRoot,
      "verification-result.json"
    )
  };
}

async function collectExpectedFiles(
  projectRoot: string
): Promise<PatchReleasePlanFile[]> {
  const candidates: Array<Omit<PatchReleasePlanFile, "sha256">> = [
    { path: "package.json", role: "package" },
    { path: "src/index.ts", role: "cli" },
    { path: releaseNotesPath, role: "release_notes" }
  ];
  try {
    await readFile(resolveInside(projectRoot, "package-lock.json"));
    candidates.splice(1, 0, {
      path: "package-lock.json",
      role: "lockfile"
    });
  } catch {
    // package-lock.json is optional for fixture projects.
  }
  return Promise.all(
    candidates.map(async (file) => ({
      ...file,
      sha256: await fileDigest(resolveInside(projectRoot, file.path))
    }))
  );
}

async function assertExpectedFilesCurrent(
  projectRoot: string,
  files: PatchReleasePlanFile[]
): Promise<void> {
  const changed: string[] = [];
  for (const file of files) {
    if (await fileDigest(resolveInside(projectRoot, file.path)) !== file.sha256) {
      changed.push(file.path);
    }
  }
  if (changed.length > 0) {
    throw new Error(
      `Patch release plan input drift: ${changed.join(", ")}`
    );
  }
}

async function readSynchronizedVersions(projectRoot: string): Promise<{
  packageVersion: string;
}> {
  const packageJson = await readJsonFile<PackageJson>(
    resolveInside(projectRoot, "package.json")
  );
  const packageVersion = requireVersion(
    packageJson.version,
    "package.json"
  );
  parseCoreVersion(packageVersion);
  const indexSource = await readFile(
    resolveInside(projectRoot, "src", "index.ts"),
    "utf8"
  );
  const cliVersion = extractCliVersion(indexSource);
  if (cliVersion !== packageVersion) {
    throw new Error(
      `Version mismatch: package.json=${packageVersion}, src/index.ts=${cliVersion}`
    );
  }
  try {
    const lock = await readJsonFile<PackageLockJson>(
      resolveInside(projectRoot, "package-lock.json")
    );
    const lockVersion = requireVersion(lock.version, "package-lock.json");
    const rootVersion = requireVersion(
      lock.packages?.[""]?.version,
      "package-lock.json packages['']"
    );
    if (
      lockVersion !== packageVersion ||
      rootVersion !== packageVersion
    ) {
      throw new Error(
        `Version mismatch: package.json=${packageVersion}, package-lock.json=${lockVersion}, package-lock root=${rootVersion}`
      );
    }
  } catch (error) {
    if ((error as Error).message.includes("ENOENT")) {
      return { packageVersion };
    }
    throw error;
  }
  return { packageVersion };
}

async function collectCleanSourceState(
  projectRoot: string,
  commandRunner: CommandRunner
): Promise<{ commit: string }> {
  const status = await commandRunner({
    command: "git",
    args: ["status", "--porcelain", "--untracked-files=no"],
    cwd: projectRoot
  });
  if (status.exitCode !== 0 || status.timedOut) {
    throw new Error(
      `Failed to inspect tracked worktree: ${status.stderr || status.stdout}`
    );
  }
  const dirty = status.stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (dirty.length > 0) {
    throw new Error(
      `Patch release requires a clean tracked worktree. Dirty tracked entries: ${dirty.join(", ")}`
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
    throw new Error("Patch release requires a valid Git HEAD commit.");
  }
  return { commit };
}

function assertReleaseNotesPreflight(
  content: string,
  baseVersion: string,
  targetVersion: string
): void {
  if (!/^##\s+Unreleased\s*$/mu.test(content)) {
    throw new Error("Release notes must contain the Unreleased heading.");
  }
  if (!content.includes(releaseNotesMarker)) {
    throw new Error(
      `Release notes marker not found: ${releaseNotesMarker}`
    );
  }
  if (!hasReleaseHeading(content, baseVersion)) {
    throw new Error(
      `Release notes do not contain the current Stable version ${baseVersion}.`
    );
  }
  if (hasReleaseHeading(content, targetVersion)) {
    throw new Error(
      `Release notes already contain target version ${targetVersion}.`
    );
  }
}

function appendPatchReleaseEntry(
  current: string,
  plan: PatchReleasePlan,
  preparedAt: Date
): string {
  assertReleaseNotesPreflight(
    current,
    plan.base_version,
    plan.target_version
  );
  const markerIndex = current.indexOf(releaseNotesMarker);
  const nextHeading = current.indexOf("\n## ", markerIndex + releaseNotesMarker.length);
  if (nextHeading < 0) {
    throw new Error(
      "Release notes must contain a section after the Unreleased block."
    );
  }
  const block = [
    `## ${plan.target_version} - ${preparedAt.toISOString().slice(0, 10)}`,
    "",
    `<!-- kairon:patch-release-plan ${plan.plan_id} -->`,
    "",
    "### Summary",
    "",
    "- Review the Unreleased items above and move the approved patch scope here.",
    "",
    "### Tests",
    "",
    "- `npm run build`",
    "- `npm test`",
    "- `npx vitest run tests\\security-baseline.test.ts`",
    "",
    "### Compatibility / Canary",
    "",
    `- ${plan.base_version} -> ${plan.target_version} -> ${plan.base_version} -> ${plan.target_version}`,
    "- Clean Windows Stable canary: pending",
    "- Post-release health decision: pending",
    "",
    "### Manual / Operation Test Evidence",
    "",
    "- Patch release verification result: pending",
    "",
    "### Known Limitations",
    "",
    "-"
  ].join("\n");
  return `${current.slice(0, nextHeading).trimEnd()}\n\n${block}\n${current
    .slice(nextHeading)
    .replace(/^\r?\n/u, "\n")}`;
}

async function readPrepareResult(
  resultPath: string,
  plan: PatchReleasePlan
): Promise<PatchReleasePrepareResult | null> {
  try {
    const value = await readJsonFile<unknown>(resultPath);
    if (!isRecord(value)) {
      return null;
    }
    const candidate = value as Partial<PatchReleasePrepareResult>;
    if (
      candidate.schema_version !== "0.1" ||
      candidate.artifact_kind !== "patch_release_prepare_result" ||
      candidate.plan_id !== plan.plan_id ||
      candidate.status !== "prepared" ||
      candidate.base_version !== plan.base_version ||
      candidate.target_version !== plan.target_version ||
      typeof candidate.result_digest !== "string"
    ) {
      return null;
    }
    const { result_digest: observed, ...unsigned } = candidate;
    return digest(unsigned) === observed
      ? candidate as PatchReleasePrepareResult
      : null;
  } catch {
    return null;
  }
}

async function loadEvidence<T>(
  projectRoot: string,
  suppliedPath: string,
  kind: string,
  parser: (value: unknown) => T
): Promise<{
  value: T;
  evidence: PatchReleaseVerificationResult["evidence"][number];
}> {
  const absolute = path.isAbsolute(suppliedPath)
    ? path.resolve(suppliedPath)
    : resolveInside(projectRoot, suppliedPath);
  const bytes = await readFile(absolute);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`Patch release evidence is not valid JSON: ${kind}`);
  }
  return {
    value: parser(value),
    evidence: {
      kind,
      path: toPosixPath(path.relative(projectRoot, absolute)),
      sha256: digestBytes(bytes)
    }
  };
}

function parseStableCanary(value: unknown): StableCanaryFinalResult {
  if (
    !isRecord(value) ||
    value.schema_version !== "0.1" ||
    value.artifact_kind !== "stable_canary_final_result" ||
    typeof value.canary_id !== "string" ||
    typeof value.version !== "string" ||
    typeof value.status !== "string" ||
    !isRecord(value.cleanup)
  ) {
    throw new Error("Stable canary evidence is invalid.");
  }
  return value as StableCanaryFinalResult;
}

function parsePostReleaseHealth(value: unknown): PostReleaseHealthResult {
  if (
    !isRecord(value) ||
    value.schema_version !== "0.1" ||
    value.artifact_kind !== "post_release_health_result" ||
    typeof value.health_id !== "string" ||
    typeof value.decision !== "string" ||
    !isRecord(value.release) ||
    !isRecord(value.read_only_guard)
  ) {
    throw new Error("Post-release health evidence is invalid.");
  }
  return value as PostReleaseHealthResult;
}

function parseUpdateTransaction(value: unknown): UpdateTransactionArtifact {
  if (
    !isRecord(value) ||
    value.schema_version !== "0.1" ||
    value.artifact_kind !== "update_transaction" ||
    typeof value.transaction_id !== "string" ||
    typeof value.action !== "string" ||
    typeof value.status !== "string" ||
    typeof value.current_version !== "string" ||
    typeof value.target_version !== "string"
  ) {
    throw new Error("Update transaction evidence is invalid.");
  }
  return value as UpdateTransactionArtifact;
}

function parseStablePromotion(value: unknown): StablePromotionResult {
  if (
    !isRecord(value) ||
    value.schema_version !== "0.1" ||
    value.artifact_kind !== "stable_release_promotion_result" ||
    typeof value.plan_id !== "string" ||
    typeof value.status !== "string" ||
    typeof value.version !== "string" ||
    typeof value.tag !== "string" ||
    typeof value.source_commit !== "string" ||
    !Array.isArray(value.assets)
  ) {
    throw new Error("Stable promotion evidence is invalid.");
  }
  return value as StablePromotionResult;
}

function parsePatchCleanup(value: unknown): PatchReleaseCleanupEvidence {
  if (
    !isRecord(value) ||
    value.schema_version !== "0.1" ||
    value.artifact_kind !== "patch_release_cleanup_result" ||
    typeof value.plan_id !== "string" ||
    (value.status !== "completed" && value.status !== "not_required") ||
    typeof value.production_release_retained !== "boolean" ||
    !Array.isArray(value.resources) ||
    typeof value.completed_at !== "string"
  ) {
    throw new Error("Patch release cleanup evidence is invalid.");
  }
  return value as PatchReleaseCleanupEvidence;
}

function verifyCleanup(
  plan: PatchReleasePlan,
  cleanup: PatchReleaseCleanupEvidence
): boolean {
  if (cleanup.plan_id !== plan.plan_id) {
    return false;
  }
  if (plan.mode === "release") {
    return (
      cleanup.status === "not_required" &&
      cleanup.production_release_retained &&
      cleanup.resources.every((entry) => entry.status === "retained")
    );
  }
  const kinds = new Set(cleanup.resources.map((entry) => entry.kind));
  return (
    cleanup.status === "completed" &&
    cleanup.production_release_retained === false &&
    kinds.has("release") &&
    kinds.has("tag") &&
    kinds.has("branch") &&
    cleanup.resources.every(
      (entry) =>
        entry.exact_id.trim().length > 0 &&
        (entry.status === "deleted" ||
          entry.status === "verified_absent")
    )
  );
}

function isPatchReleasePlan(value: unknown): value is PatchReleasePlan {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.schema_version === "0.1" &&
    value.artifact_kind === "patch_release_plan" &&
    typeof value.plan_id === "string" &&
    /^PRP-\d{14}-[a-f0-9]{12}$/u.test(value.plan_id) &&
    value.status === "planned" &&
    (value.mode === "rehearsal" || value.mode === "release") &&
    typeof value.base_version === "string" &&
    typeof value.target_version === "string" &&
    typeof value.base_source_commit === "string" &&
    Array.isArray(value.expected_changed_files) &&
    value.expected_changed_files.every(isPatchReleasePlanFile) &&
    Array.isArray(value.required_checks) &&
    typeof value.write_confirmation === "string" &&
    typeof value.input_digest === "string" &&
    typeof value.plan_digest === "string" &&
    typeof value.created_at === "string" &&
    typeof value.expires_at === "string" &&
    value.source_write_performed === false &&
    value.external_publish_performed === false &&
    value.automatic_promotion === false &&
    value.automatic_update === false &&
    isRecord(value.release_notes) &&
    isRecord(value.previous_stable_compatibility)
  );
}

function isPatchReleasePlanFile(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    (
      value.role === "package" ||
      value.role === "lockfile" ||
      value.role === "cli" ||
      value.role === "release_notes"
    ) &&
    typeof value.sha256 === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(value.sha256)
  );
}

function check(
  id: PatchReleaseVerificationCheck["id"],
  passed: boolean,
  details: string
): PatchReleaseVerificationCheck {
  return {
    id,
    status: passed ? "pass" : "fail",
    details
  };
}

function parsePatchReleaseMode(value: string | undefined): PatchReleaseMode {
  const mode = value?.trim().toLowerCase() ?? "rehearsal";
  if (mode !== "rehearsal" && mode !== "release") {
    throw new Error("Patch release mode must be rehearsal or release.");
  }
  return mode;
}

function hasReleaseHeading(content: string, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^##\\s+${escaped}(?:\\s|$)`, "mu").test(content);
}

function extractCliVersion(source: string): string {
  const match = /KAIRON_VERSION\s*=\s*"([^"]+)"/u.exec(source);
  if (match === null) {
    throw new Error("src/index.ts does not contain KAIRON_VERSION.");
  }
  parseCoreVersion(match[1]);
  return match[1];
}

function replaceCliVersion(source: string, version: string): string {
  return source.replace(
    /(KAIRON_VERSION\s*=\s*")([^"]+)(")/u,
    `$1${version}$3`
  );
}

function requireVersion(value: unknown, source: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${source} does not contain a valid version string.`);
  }
  return value;
}

async function fileDigest(filePath: string): Promise<string> {
  return digestBytes(await readFile(filePath));
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digest(value: unknown): string {
  return digestBytes(Buffer.from(stableSerialize(value), "utf8"));
}

function stableSerialize(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
