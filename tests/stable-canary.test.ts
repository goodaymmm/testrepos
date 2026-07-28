import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  finalizeStableCanary,
  prepareStableCanary,
  type StableCanaryCheck,
  type StableCanarySandboxResult
} from "../src/operation-test/stable-canary.js";

const now = new Date("2026-07-29T00:00:00.000Z");
const sourceCommit = "a".repeat(40);

describe("Stable clean Windows canary", () => {
  it("prepares a source-free Windows Sandbox profile bound to T194 evidence", async () => {
    const fixture = await createFixture();
    const prepared = await prepareStableCanary(
      fixture.root,
      fixture.input,
      { now: () => now }
    );

    expect(prepared.manifest).toMatchObject({
      artifact_kind: "stable_canary_input",
      source_verification: {
        verification_id: "STV-20260729000000-aaaaaaaaaaaa",
        repository: "goodaymmm/Kairon",
        version: "0.3.0",
        release_id: 501
      },
      download: {
        base_url:
          "https://github.com/goodaymmm/Kairon/releases/download/v0.3.0",
        authentication: "public_release",
        credential_provider: "windows_credential"
      },
      runtime: {
        strategy: "mapped_read_only"
      },
      fixture: {
        profile: "generated"
      },
      sandbox: {
        timeout_seconds: 900,
        keep_on_failure: false,
        auto_close: true
      }
    });
    expect(prepared.manifest.source_verification.assets).toHaveLength(5);
    expect(prepared.manifest.state_digest).toMatch(/^[a-f0-9]{64}$/u);

    const sandboxConfig = await readFile(
      prepared.sandbox_config_path,
      "utf8"
    );
    expect(sandboxConfig).toContain("<ReadOnly>true</ReadOnly>");
    expect(sandboxConfig).toContain(
      "C:\\KaironCanary\\shared\\bootstrap.ps1"
    );
    expect(sandboxConfig).not.toContain(
      `<HostFolder>${fixture.root}</HostFolder>`
    );
    expect(sandboxConfig.match(/<MappedFolder>/gu)).toHaveLength(3);
    expect(sandboxConfig).not.toContain("github_pat_");

    const bootstrap = await readFile(prepared.bootstrap_path, "utf8");
    expect(bootstrap).toContain("--verification-context\", \"consumer");
    expect(bootstrap).toContain("package_global_uninstall");
    expect(bootstrap).toContain("project_state_retained_after_uninstall");
    expect(bootstrap).toContain("credential_persisted = $false");
    expect(bootstrap).not.toContain("npm link");
    expect(bootstrap).not.toContain("git clone");
  });

  it("finalizes a complete Sandbox result and preserves cleanup guarantees", async () => {
    const fixture = await createFixture();
    const prepared = await prepareStableCanary(
      fixture.root,
      fixture.input,
      { now: () => now }
    );
    const sandboxResult = passingSandboxResult(prepared.manifest);
    await writeFile(
      prepared.sandbox_result_path,
      `${JSON.stringify(sandboxResult, null, 2)}\n`,
      "utf8"
    );

    const finalized = await finalizeStableCanary(
      fixture.root,
      prepared.manifest_path,
      { now: () => new Date("2026-07-29T00:10:00.000Z") }
    );

    expect(finalized.result).toMatchObject({
      status: "PASS",
      sandbox_result_status: "PASS",
      source_release_id: 501,
      version: "0.3.0",
      cleanup: {
        unknown_sandbox_terminated: false,
        host_cache_created: false,
        host_credential_persisted: false,
        sandbox_work_directory_removed: true,
        package_removed: true
      },
      reasons: [],
      remediation: []
    });
    expect(finalized.result.checks).toHaveLength(12);
    expect(finalized.result.sandbox_result_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("classifies a missing Sandbox result as setup required without terminating it", async () => {
    const fixture = await createFixture();
    const prepared = await prepareStableCanary(
      fixture.root,
      fixture.input,
      { now: () => now }
    );

    const finalized = await finalizeStableCanary(
      fixture.root,
      prepared.manifest_path,
      { now: () => new Date("2026-07-29T00:31:00.000Z") }
    );

    expect(finalized.result).toMatchObject({
      status: "SETUP_REQUIRED",
      sandbox_result_status: "missing",
      reasons: ["sandbox_result_missing"],
      cleanup: {
        unknown_sandbox_terminated: false
      }
    });
  });

  it("classifies a completed result beyond the declared timeout as setup required", async () => {
    const fixture = await createFixture();
    const prepared = await prepareStableCanary(
      fixture.root,
      fixture.input,
      { now: () => now }
    );
    const sandboxResult = passingSandboxResult(prepared.manifest);
    sandboxResult.sandbox.finished_at = "2026-07-29T00:20:00.000Z";
    sandboxResult.sandbox.duration_ms = 19 * 60_000;
    await writeFile(
      prepared.sandbox_result_path,
      JSON.stringify(sandboxResult),
      "utf8"
    );

    const finalized = await finalizeStableCanary(
      fixture.root,
      prepared.manifest_path,
      { now: () => new Date("2026-07-29T00:21:00.000Z") }
    );

    expect(finalized.result.status).toBe("SETUP_REQUIRED");
    expect(finalized.result.reasons).toContain("sandbox_execution_timeout");
    expect(finalized.result.cleanup.unknown_sandbox_terminated).toBe(false);
  });

  it("rejects stale verification evidence and result source drift", async () => {
    const fixture = await createFixture();
    const stalePath = path.join(fixture.root, "stale-verification.json");
    const stale = {
      ...stableVerification(),
      expires_at: "2026-07-28T23:59:59.000Z"
    };
    await writeFile(stalePath, JSON.stringify(stale), "utf8");

    await expect(
      prepareStableCanary(
        fixture.root,
        { ...fixture.input, verificationPath: stalePath },
        { now: () => now }
      )
    ).rejects.toThrow("fresh PASS verification");

    const prepared = await prepareStableCanary(
      fixture.root,
      fixture.input,
      { now: () => now }
    );
    const drifted = passingSandboxResult(prepared.manifest);
    drifted.source_release.release_id = 999;
    await writeFile(
      prepared.sandbox_result_path,
      JSON.stringify(drifted),
      "utf8"
    );

    const finalized = await finalizeStableCanary(
      fixture.root,
      prepared.manifest_path,
      { now: () => new Date("2026-07-29T00:10:00.000Z") }
    );
    expect(finalized.result.status).toBe("FAIL");
    expect(finalized.result.reasons).toContain(
      "sandbox_result_source_binding_mismatch"
    );
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kairon-canary-"));
  const nodeRuntimeRoot = path.join(root, "runtime", "node");
  const gitRuntimeRoot = path.join(root, "runtime", "git");
  await mkdir(path.join(gitRuntimeRoot, "cmd"), { recursive: true });
  await mkdir(nodeRuntimeRoot, { recursive: true });
  await writeFile(path.join(nodeRuntimeRoot, "node.exe"), "", "utf8");
  await writeFile(path.join(nodeRuntimeRoot, "npm.cmd"), "", "utf8");
  await writeFile(path.join(gitRuntimeRoot, "cmd", "git.exe"), "", "utf8");
  const verificationPath = path.join(root, "stable-verification.json");
  await writeFile(
    verificationPath,
    `${JSON.stringify(stableVerification(), null, 2)}\n`,
    "utf8"
  );
  return {
    root,
    input: {
      verificationPath,
      nodeRuntimeRoot,
      gitRuntimeRoot,
      timeoutSeconds: 900,
      credentialProvider: "windows_credential"
    }
  };
}

function stableVerification() {
  const assetNames = [
    "kairon-0.3.0.tgz",
    "kairon-0.3.0.tgz.sha256.json",
    "release-manifest.json",
    "sbom.cdx.json",
    "provenance.json"
  ];
  return {
    schema_version: "0.1",
    artifact_kind: "stable_release_verification",
    verification_id: "STV-20260729000000-aaaaaaaaaaaa",
    status: "PASS",
    integrity_status: "PASS",
    currentness_status: "PASS",
    repository: "goodaymmm/Kairon",
    base_branch: "main",
    version: "0.3.0",
    tag: "v0.3.0",
    release_id: 501,
    release_name: "Kairon 0.3.0",
    target_commit_sha: sourceCommit,
    tag_commit_sha: sourceCommit,
    draft: false,
    prerelease: false,
    assets: assetNames.map((name, index) => ({
      id: 700 + index,
      name,
      size_bytes: 100 + index,
      sha256: String(index + 1).repeat(64),
      state: "uploaded"
    })),
    manifest: {
      status: "verified",
      package_version: "0.3.0",
      source_commit: sourceCommit,
      sha256: "f".repeat(64),
      verification_context: "consumer",
      failed_checks: []
    },
    channel_selection: {
      channel: "stable",
      selected_release_id: 501,
      selected_version: "0.3.0",
      matches_requested_release: true
    },
    credential_provider: "windows_credential",
    checks: [],
    reasons: [],
    remediation: [],
    state_digest: "a".repeat(64),
    checked_at: "2026-07-29T00:00:00.000Z",
    expires_at: "2026-07-30T00:00:00.000Z",
    execution_performed: false
  };
}

function passingSandboxResult(
  manifest: {
    canary_id: string;
    state_digest: string;
    source_verification: {
      verification_id: string;
      repository: string;
      version: string;
      tag: string;
      release_id: number;
      target_commit_sha: string;
    };
  }
): StableCanarySandboxResult {
  return {
    schema_version: "0.1",
    artifact_kind: "stable_canary_sandbox_result",
    canary_id: manifest.canary_id,
    input_state_digest: manifest.state_digest,
    status: "PASS",
    source_release: {
      ...manifest.source_verification
    },
    sandbox: {
      started_at: "2026-07-29T00:01:00.000Z",
      finished_at: "2026-07-29T00:05:00.000Z",
      duration_ms: 240_000
    },
    checks: passingChecks(),
    installed_version: "0.3.0",
    doctor_ok: false,
    state_status: "ok",
    project_state_retained: true,
    cleanup: {
      package_removed: true,
      work_directory_removed: true,
      credential_persisted: false,
      process_spawned: false
    },
    sanitized_command_ids: [
      "runtime_node_version",
      "download_release_asset",
      "consumer_release_verify",
      "package_global_install",
      "project_doctor",
      "state_integrity",
      "read_only_status",
      "package_global_uninstall"
    ],
    reasons: [],
    remediation: []
  };
}

function passingChecks(): StableCanaryCheck[] {
  return [
    check("runtime_prerequisites"),
    check("stable_artifact_download"),
    check("consumer_verification"),
    check("package_install"),
    check("installed_version"),
    check("project_initialize"),
    check("doctor"),
    check("state_integrity"),
    check("read_only_command"),
    check("package_uninstall"),
    check("project_state_retained"),
    check("sandbox_cleanup")
  ];
}

function check(id: StableCanaryCheck["id"]): StableCanaryCheck {
  return { id, status: "pass", reason: `${id}_passed` };
}
