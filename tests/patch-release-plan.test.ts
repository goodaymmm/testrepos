import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CliInvocation,
  CommandRunResult
} from "../src/agents/command-runner.js";
import { writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  createPatchReleasePlan,
  preparePatchReleasePlan,
  verifyPatchReleasePlan,
  type PatchReleaseCleanupEvidence
} from "../src/release/patch-plan.js";
import type { ReleaseManifest } from "../src/release/release-manifest.js";
import type { StablePromotionResult } from "../src/release/stable-promotion.js";
import type { UpdateTransactionArtifact } from "../src/update/transaction.js";
import { createTempProject } from "./test-utils.js";

const baseCommit = "a".repeat(40);
const targetCommit = "b".repeat(40);
const sha256 = "c".repeat(64);

describe("patch release plan", () => {
  it("creates an immutable next-patch plan bound to clean source inputs", async () => {
    const root = await createPatchProject();

    const execution = await createPatchReleasePlan(root, {
      version: "0.3.1",
      commandRunner: gitRunner(baseCommit),
      now: () => new Date("2026-07-30T00:00:00.000Z")
    });

    expect(execution.plan).toMatchObject({
      artifact_kind: "patch_release_plan",
      status: "planned",
      mode: "rehearsal",
      base_version: "0.3.0",
      target_version: "0.3.1",
      base_source_commit: baseCommit,
      write_confirmation: execution.plan.plan_id,
      source_write_performed: false,
      external_publish_performed: false,
      automatic_promotion: false,
      automatic_update: false
    });
    expect(execution.plan.expected_changed_files.map((file) => file.path)).toEqual([
      "package.json",
      "package-lock.json",
      "src/index.ts",
      "docs/release-notes-v0.md"
    ]);
    expect(execution.plan.required_checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        "build",
        "full_test",
        "security_baseline",
        "release_manifest",
        "stable_canary",
        "post_release_health"
      ])
    );
    expect(execution.plan.previous_stable_compatibility.sequence).toEqual([
      "update",
      "rollback",
      "reapply"
    ]);
    await expect(readFile(execution.plan_path, "utf8")).resolves.toContain(
      execution.plan.plan_digest
    );
  });

  it("rejects minor transitions and dirty tracked source", async () => {
    const root = await createPatchProject();

    await expect(
      createPatchReleasePlan(root, {
        version: "0.4.0",
        commandRunner: gitRunner(baseCommit)
      })
    ).rejects.toThrow("next patch version");

    await expect(
      createPatchReleasePlan(root, {
        version: "0.3.1",
        commandRunner: gitRunner(baseCommit, " M package.json\n")
      })
    ).rejects.toThrow("clean tracked worktree");
  });

  it("requires exact confirmation and freshness before preparing source", async () => {
    const root = await createPatchProject();
    const execution = await createPatchReleasePlan(root, {
      version: "0.3.1",
      commandRunner: gitRunner(baseCommit),
      now: () => new Date("2026-07-30T00:00:00.000Z"),
      expiresInMinutes: 30
    });

    await expect(
      preparePatchReleasePlan(root, execution.plan.plan_id, {
        confirm: "wrong",
        commandRunner: gitRunner(baseCommit),
        now: () => new Date("2026-07-30T00:01:00.000Z")
      })
    ).rejects.toThrow(`--confirm ${execution.plan.plan_id}`);

    await expect(
      preparePatchReleasePlan(root, execution.plan.plan_id, {
        confirm: execution.plan.plan_id,
        commandRunner: gitRunner(baseCommit),
        now: () => new Date("2026-07-30T00:31:00.000Z")
      })
    ).rejects.toThrow("expired");

    const prepared = await preparePatchReleasePlan(
      root,
      execution.plan.plan_id,
      {
        confirm: execution.plan.plan_id,
        commandRunner: gitRunner(baseCommit),
        now: () => new Date("2026-07-30T00:10:00.000Z")
      }
    );

    expect(prepared.result).toMatchObject({
      artifact_kind: "patch_release_prepare_result",
      status: "prepared",
      base_version: "0.3.0",
      target_version: "0.3.1",
      commit_required: true,
      external_publish_performed: false
    });
    await expect(readVersion(root, "package.json")).resolves.toBe("0.3.1");
    await expect(readVersion(root, "package-lock.json")).resolves.toBe("0.3.1");
    await expect(
      readFile(path.join(root, "src", "index.ts"), "utf8")
    ).resolves.toContain('KAIRON_VERSION = "0.3.1"');
    await expect(
      readFile(path.join(root, "docs", "release-notes-v0.md"), "utf8")
    ).resolves.toContain("## 0.3.1 - 2026-07-30");
    await expect(
      readFile(
        path.join(root, prepared.result.backup_artifact, "package.json"),
        "utf8"
      )
    ).resolves.toContain('"version": "0.3.0"');
  });

  it("verifies patch artifacts, compatibility, promotion, and exact cleanup", async () => {
    const root = await createPatchProject();
    const execution = await createPatchReleasePlan(root, {
      version: "0.3.1",
      commandRunner: gitRunner(baseCommit),
      now: () => new Date("2026-07-30T00:00:00.000Z")
    });
    await preparePatchReleasePlan(root, execution.plan.plan_id, {
      confirm: execution.plan.plan_id,
      commandRunner: gitRunner(baseCommit),
      now: () => new Date("2026-07-30T00:10:00.000Z")
    });
    const evidence = await writeVerificationEvidence(
      root,
      execution.plan.plan_id
    );

    const verified = await verifyPatchReleasePlan(
      root,
      execution.plan.plan_id,
      {
        ...evidence,
        commandRunner: gitRunner(targetCommit),
        now: () => new Date("2026-07-30T01:00:00.000Z")
      }
    );

    expect(verified.result.status).toBe("PASS");
    expect(verified.result.checks.every((check) => check.status === "pass")).toBe(
      true
    );
    expect(verified.result).toMatchObject({
      target_source_commit: targetCommit,
      tag: "v0.3.1",
      release_id: 301,
      asset_names: ["kairon-0.3.1.tgz"],
      cleanup_status: "completed",
      external_publish_performed: false,
      automatic_promotion: false,
      automatic_update: false
    });
    expect(verified.result.transaction_ids).toEqual([
      "UTX-1001",
      "UTX-1002",
      "UTX-1003"
    ]);
  });
});

async function createPatchProject(): Promise<string> {
  const root = await createTempProject();
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeJsonFileAtomic(path.join(root, "package.json"), {
    name: "kairon",
    version: "0.3.0",
    private: true
  });
  await writeJsonFileAtomic(path.join(root, "package-lock.json"), {
    name: "kairon",
    version: "0.3.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "kairon",
        version: "0.3.0"
      }
    }
  });
  await writeFile(
    path.join(root, "src", "index.ts"),
    'export const KAIRON_VERSION = "0.3.0";\n',
    "utf8"
  );
  await writeFile(
    path.join(root, "docs", "release-notes-v0.md"),
    [
      "# Release Notes",
      "",
      "## Unreleased",
      "",
      "<!-- kairon:release-notes-unreleased -->",
      "",
      "- pending patch fix",
      "",
      "## Versioning",
      "",
      "Patch policy.",
      "",
      "## 0.3.0 - 2026-07-28",
      "",
      "Stable baseline.",
      ""
    ].join("\n"),
    "utf8"
  );
  return root;
}

async function writeVerificationEvidence(
  root: string,
  planId: string
): Promise<{
  releaseManifest: string;
  canary: string;
  health: string;
  updateTransaction: string;
  rollbackTransaction: string;
  reapplyTransaction: string;
  promotion: string;
  cleanup: string;
}> {
  const evidenceRoot = path.join(root, "evidence");
  await mkdir(evidenceRoot, { recursive: true });
  const manifest: ReleaseManifest = {
    schema_version: "0.1",
    artifact_kind: "kairon_release",
    release_channel: "local_beta",
    package_name: "kairon",
    package_version: "0.3.1",
    source: {
      commit_sha: targetCommit,
      dirty: false
    },
    runtime_support: {
      operating_systems: ["windows_10_11", "windows_server"],
      node: ">=22",
      npm: "required",
      powershell: ">=5.1",
      git: "required"
    },
    artifact: {
      package_file: "kairon-0.3.1.tgz",
      checksum_manifest_file: "kairon-0.3.1.tgz.sha256.json",
      sha256,
      size_bytes: 10,
      checksum_manifest_sha256: sha256
    },
    package_inventory: {
      sha256,
      files: []
    },
    maintenance: {
      release_type: "patch",
      plan_id: planId,
      base_version: "0.3.0",
      target_version: "0.3.1"
    },
    created_at: "2026-07-30T00:20:00.000Z"
  };
  const canary = {
    schema_version: "0.1",
    artifact_kind: "stable_canary_final_result",
    finalization_id: "SCF-0001",
    canary_id: "SCN-0001",
    status: "PASS",
    source_verification_id: "SVR-0001",
    source_state_digest: `sha256:${sha256}`,
    source_release_id: 301,
    version: "0.3.1",
    sandbox_result_status: "PASS",
    sandbox_result_sha256: sha256,
    checks: [],
    cleanup: {
      unknown_sandbox_terminated: false,
      host_cache_created: false,
      host_credential_persisted: false,
      sandbox_work_directory_removed: true,
      package_removed: true
    },
    reasons: [],
    remediation: [],
    finalized_at: "2026-07-30T00:30:00.000Z"
  };
  const health = {
    schema_version: "0.1",
    artifact_kind: "post_release_health_result",
    health_id: "HLT-0001",
    decision: "continue",
    release: {
      verification_id: "SVR-0001",
      release_id: 301,
      repository: "goodaymmm/Kairon",
      version: "0.3.1",
      tag: "v0.3.1",
      source_commit: targetCommit,
      artifact_digest: `sha256:${sha256}`
    },
    read_only_guard: {
      project_state_digest_before: `sha256:${sha256}`,
      project_state_digest_after: `sha256:${sha256}`,
      installed_state_digest_before: `sha256:${sha256}`,
      installed_state_digest_after: `sha256:${sha256}`,
      mutation_detected: false
    }
  };
  const transactions = [
    transaction("UTX-1001", "apply", "0.3.0", "0.3.1"),
    transaction("UTX-1002", "rollback", "0.3.1", "0.3.0"),
    transaction("UTX-1003", "apply", "0.3.0", "0.3.1")
  ];
  const promotion: StablePromotionResult = {
    schema_version: "0.1",
    artifact_kind: "stable_release_promotion_result",
    plan_id: "SPP-20260730003000-aaaaaaaaaaaa",
    status: "promoted",
    repository: "goodaymmm/Kairon",
    version: "0.3.1",
    tag: "v0.3.1",
    source_commit: targetCommit,
    release_id: 301,
    assets: [
      {
        id: 401,
        name: "kairon-0.3.1.tgz",
        size_bytes: 10,
        sha256
      }
    ],
    approval_id: "APR-0001",
    correlation_id: "COR-0001",
    attempts: 1,
    idempotent: false,
    created_at: "2026-07-30T00:30:00.000Z",
    updated_at: "2026-07-30T00:31:00.000Z"
  };
  const cleanup: PatchReleaseCleanupEvidence = {
    schema_version: "0.1",
    artifact_kind: "patch_release_cleanup_result",
    plan_id: planId,
    status: "completed",
    production_release_retained: false,
    resources: [
      {
        kind: "release",
        exact_id: "301",
        status: "deleted"
      },
      {
        kind: "tag",
        exact_id: "v0.3.1-t204-test",
        status: "verified_absent"
      },
      {
        kind: "branch",
        exact_id: "test/t204-patch",
        status: "verified_absent"
      }
    ],
    completed_at: "2026-07-30T00:40:00.000Z"
  };
  const entries = {
    releaseManifest: ["release-manifest.json", manifest],
    canary: ["canary.json", canary],
    health: ["health.json", health],
    updateTransaction: ["update.json", transactions[0]],
    rollbackTransaction: ["rollback.json", transactions[1]],
    reapplyTransaction: ["reapply.json", transactions[2]],
    promotion: ["promotion.json", promotion],
    cleanup: ["cleanup.json", cleanup]
  } as const;
  const result = {} as Record<keyof typeof entries, string>;
  for (const [key, [fileName, value]] of Object.entries(entries) as Array<
    [keyof typeof entries, readonly [string, unknown]]
  >) {
    const filePath = path.join(evidenceRoot, fileName);
    await writeJsonFileAtomic(filePath, value);
    result[key] = filePath;
  }
  return result;
}

function transaction(
  id: string,
  action: "apply" | "rollback",
  currentVersion: string,
  targetVersion: string
): UpdateTransactionArtifact {
  return {
    schema_version: "0.1",
    artifact_kind: "update_transaction",
    transaction_id: id,
    action,
    status: "completed",
    phase: "completed",
    current_version: currentVersion,
    target_version: targetVersion,
    download_id: `UPD-${id.slice(-4)}`,
    package_sha256: sha256,
    package_size_bytes: 10,
    staging_path: "C:\\Kairon\\staging",
    artifact_path: `.kairon/update/transactions/${id}.json`,
    timeline: [
      {
        phase: "post_check",
        status: "passed",
        code: "post_check_passed",
        recorded_at: "2026-07-30T00:30:00.000Z"
      },
      {
        phase: "completed",
        status: "passed",
        code: "transaction_completed",
        recorded_at: "2026-07-30T00:31:00.000Z"
      }
    ],
    created_at: "2026-07-30T00:30:00.000Z",
    updated_at: "2026-07-30T00:31:00.000Z"
  };
}

function gitRunner(
  commit: string,
  status = ""
): (invocation: CliInvocation) => Promise<CommandRunResult> {
  return async (invocation) =>
    commandResult(invocation, {
      stdout: invocation.args[0] === "status" ? status : `${commit}\n`
    });
}

function commandResult(
  invocation: CliInvocation,
  options: Partial<CommandRunResult> = {}
): CommandRunResult {
  return {
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    pid: 1234,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: "2026-07-30T00:00:00.000Z",
    finishedAt: "2026-07-30T00:00:01.000Z",
    timedOut: false,
    ...options
  };
}

async function readVersion(root: string, fileName: string): Promise<string> {
  const value = JSON.parse(
    await readFile(path.join(root, fileName), "utf8")
  ) as { version: string };
  return value.version;
}
