import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProviderPolicyBlockedError,
  beginProviderRun,
  finishProviderRun,
  getProviderPolicyHealth,
  providerFailureCategory,
  providerPolicyAuditPath,
  resumeProvider,
  suspendProvider
} from "../src/agents/provider-policy.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { readJsonLines } from "../src/core/fs/jsonl-file.js";
import { createTempProject } from "./test-utils.js";

describe("provider policy", () => {
  it("enforces per-provider concurrency without blocking another provider", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const now = new Date("2026-07-16T00:00:00.000Z");

    await beginProviderRun(root, {
      agent: "codex",
      date: "2026-07-16",
      runId: "RUN-0001",
      unattended: true,
      now
    });
    await expect(
      beginProviderRun(root, {
        agent: "codex",
        date: "2026-07-16",
        runId: "RUN-0002",
        unattended: true,
        now
      })
    ).rejects.toMatchObject({
      status: "ready",
      reason: "max_concurrent_reached"
    });
    await expect(
      beginProviderRun(root, {
        agent: "claude",
        date: "2026-07-16",
        runId: "RUN-0003",
        unattended: true,
        now
      })
    ).resolves.toMatchObject({ agent: "claude", daily_run_count: 1 });
  });

  it("applies quota and rate-limit cooldown only to the affected provider", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const now = new Date("2026-07-16T01:00:00.000Z");
    await beginProviderRun(root, {
      agent: "codex",
      date: "2026-07-16",
      runId: "RUN-0010",
      unattended: true,
      now
    });

    const limited = await finishProviderRun(root, {
      agent: "codex",
      date: "2026-07-16",
      runId: "RUN-0010",
      status: "rate_limited",
      reason: "cli_rate_limited",
      retryAfter: "120",
      now
    });

    expect(limited).toMatchObject({
      status: "cooldown",
      failure_category: "rate_limit",
      next_retry_at: "2026-07-16T01:02:00.000Z",
      available: false
    });
    await expect(
      getProviderPolicyHealth(root, "claude", {
        date: "2026-07-16",
        now
      })
    ).resolves.toMatchObject({ status: "ready", available: true });
    await expect(
      getProviderPolicyHealth(root, "codex", {
        date: "2026-07-16",
        now: new Date("2026-07-16T01:02:00.000Z")
      })
    ).resolves.toMatchObject({ status: "ready", available: true });

    await beginProviderRun(root, {
      agent: "codex",
      date: "2026-07-16",
      runId: "RUN-0011",
      unattended: true,
      now: new Date("2026-07-16T01:02:00.000Z")
    });
    await expect(
      finishProviderRun(root, {
        agent: "codex",
        date: "2026-07-16",
        runId: "RUN-0011",
        status: "usage_limited",
        reason: "cli_usage_limited",
        now: new Date("2026-07-16T01:02:01.000Z")
      })
    ).resolves.toMatchObject({
      status: "cooldown",
      failure_category: "quota",
      available: false
    });
  });

  it("suspends auth, setup, compliance, and unknown failures until audited resume", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const now = new Date("2026-07-16T02:00:00.000Z");

    await beginProviderRun(root, {
      agent: "claude",
      date: "2026-07-16",
      runId: "RUN-0020",
      unattended: true,
      now
    });
    const suspended = await finishProviderRun(root, {
      agent: "claude",
      date: "2026-07-16",
      runId: "RUN-0020",
      status: "setup_required",
      reason: "cli_terms_acceptance_required",
      now
    });
    expect(suspended).toMatchObject({
      status: "suspended",
      failure_category: "compliance",
      suspended: true,
      suspended_by: "kairon-runner"
    });
    await expect(
      beginProviderRun(root, {
        agent: "claude",
        date: "2026-07-16",
        runId: "RUN-0021",
        unattended: true,
        now
      })
    ).rejects.toBeInstanceOf(ProviderPolicyBlockedError);

    const resumed = await resumeProvider(root, {
      agent: "claude",
      reason: "terms reviewed by operator",
      actor: "local-cli",
      now: new Date("2026-07-16T02:05:00.000Z")
    });
    expect(resumed).toMatchObject({ status: "ready", suspended: false });
    await expect(readJsonLines(providerPolicyAuditPath(root))).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "provider.resumed",
          agent: "claude",
          actor: "local-cli",
          reason: "terms reviewed by operator"
        })
      ])
    );
    expect(providerFailureCategory("setup_required", "cli_login_required")).toBe("auth");
    expect(providerFailureCategory("permission_required", "approval required")).toBe(
      "compliance"
    );
    expect(providerFailureCategory("failed", "unrecognized failure")).toBe("unknown");

    await beginProviderRun(root, {
      agent: "claude",
      date: "2026-07-16",
      runId: "RUN-0022",
      unattended: true,
      now: new Date("2026-07-16T02:06:00.000Z")
    });
    await expect(
      finishProviderRun(root, {
        agent: "claude",
        date: "2026-07-16",
        runId: "RUN-0022",
        status: "failed",
        reason: "unrecognized provider failure",
        now: new Date("2026-07-16T02:06:01.000Z")
      })
    ).resolves.toMatchObject({
      status: "suspended",
      failure_category: "unknown",
      suspended: true
    });
  });

  it("enforces the daily cap and resets the counter on the next date", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const configPath = path.join(root, ".kairon", "config", "agents.json");
    const config = await readJsonFile<Record<string, unknown>>(configPath);
    const policies = config.provider_policies as Record<string, Record<string, unknown>>;
    policies.codex.daily_run_limit = 1;
    await writeJsonFileAtomic(configPath, config);
    const now = new Date("2026-07-16T03:00:00.000Z");

    await beginProviderRun(root, {
      agent: "codex",
      date: "2026-07-16",
      runId: "RUN-0030",
      unattended: true,
      now
    });
    await finishProviderRun(root, {
      agent: "codex",
      date: "2026-07-16",
      runId: "RUN-0030",
      status: "completed",
      now
    });
    await expect(
      getProviderPolicyHealth(root, "codex", { date: "2026-07-16", now })
    ).resolves.toMatchObject({
      status: "daily_limit_reached",
      daily_run_count: 1,
      available: false
    });
    await expect(
      getProviderPolicyHealth(root, "codex", {
        date: "2026-07-17",
        now: new Date("2026-07-17T00:00:00.000Z")
      })
    ).resolves.toMatchObject({
      status: "ready",
      daily_run_count: 0,
      available: true
    });
  });

  it("supports an explicit operator suspension", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await beginProviderRun(root, {
      agent: "gemini",
      date: "2026-07-16",
      runId: "RUN-0040",
      unattended: true,
      now: new Date("2026-07-16T03:59:00.000Z")
    });
    const health = await suspendProvider(root, {
      agent: "gemini",
      reason: "provider maintenance window",
      actor: "local-cli",
      now: new Date("2026-07-16T04:00:00.000Z")
    });

    expect(health).toMatchObject({
      status: "suspended",
      suspended_reason: "provider maintenance window",
      suspended_by: "local-cli"
    });
    const finished = await finishProviderRun(root, {
      agent: "gemini",
      date: "2026-07-16",
      runId: "RUN-0040",
      status: "completed",
      now: new Date("2026-07-16T04:01:00.000Z")
    });
    expect(finished).toMatchObject({
      status: "suspended",
      suspended_reason: "provider maintenance window",
      active_run_ids: []
    });
  });

  it("allows attended runs while respecting the unattended allowlist", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const configPath = path.join(root, ".kairon", "config", "agents.json");
    const config = await readJsonFile<Record<string, unknown>>(configPath);
    const policies = config.provider_policies as Record<string, Record<string, unknown>>;
    policies.gemini.unattended_allowed = false;
    await writeJsonFileAtomic(configPath, config);
    const now = new Date("2026-07-16T05:00:00.000Z");

    await expect(
      beginProviderRun(root, {
        agent: "gemini",
        date: "2026-07-16",
        runId: "RUN-0050",
        unattended: true,
        now
      })
    ).rejects.toMatchObject({ reason: "unattended_not_allowed" });
    await expect(
      beginProviderRun(root, {
        agent: "gemini",
        date: "2026-07-16",
        runId: "RUN-0051",
        unattended: false,
        now
      })
    ).resolves.toMatchObject({ daily_run_count: 1 });
  });
});
