import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { defaultAgentAdapters } from "../agents/adapters/index.js";
import { agentDisplayName } from "../agents/display.js";
import { listProviderPolicyHealth } from "../agents/provider-policy.js";
import {
  isCommandAvailable,
  type CommandAvailabilityChecker
} from "../agents/session-host.js";
import { agentIds } from "../agents/types.js";
import { loadConfigFile, validateAllConfigs } from "../core/config/load-config.js";
import { readJsonFile } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside } from "../core/fs/paths.js";
import {
  resolveSecret,
  type ResolvedSecret,
  type SecretReference,
  type SecretResolver
} from "../core/secrets/secret-resolver.js";
import { validateDiscordEnvValues } from "../discord/env-validation.js";
import { prepareDiscordHttpProfile } from "../discord/http-profile.js";
import { inspectRuntimeRecoveryTargets } from "../recovery/runtime-recovery.js";
import { getRuntimeStatus } from "../runtime/status.js";
import {
  inspectBoardProjectionSecrets,
  type BoardSecretScanSummary
} from "../board/secret-scan.js";
import { listBoardAccessRecords } from "../board/access-token.js";
import { prepareBoardProfile, type BoardProfileConfig } from "../board/profile.js";
import { inspectCorrelationIntegrity } from "../correlation/store.js";
import { getRagStats, verifyRagIndex } from "../rag/integrity.js";
import {
  evaluateBetaReadiness,
  readinessManifestExists
} from "../readiness/beta-readiness.js";

export type DoctorStatus = "pass" | "warning" | "error";

export type DoctorCheck = {
  id: string;
  title: string;
  status: DoctorStatus;
  details: string[];
  next_action?: string;
};

export type DoctorResult = {
  ok: boolean;
  checks: DoctorCheck[];
  summary: Record<DoctorStatus, number>;
};

export type DoctorOptions = {
  projectRoot: string;
  commandAvailability?: CommandAvailabilityChecker;
  env?: NodeJS.ProcessEnv;
  githubBranchProtectionClient?: GitHubBranchProtectionClient;
  secretResolver?: SecretResolver;
};

type AgentsConfig = {
  agents: Record<
    string,
    {
      enabled?: boolean;
      adapter?: string;
      command?: string;
    }
  >;
};

type NotificationsConfig = {
  primary_provider?: string;
  http?: {
    profile?: "loopback" | "reverse-proxy";
    external_base_url?: string | null;
    trusted_proxies?: string[];
  };
  board?: {
    enabled?: boolean;
  } & BoardProfileConfig;
  providers?: {
    discord?: {
      enabled?: boolean;
      mode?: string;
      bot_token_env?: string;
      public_key_env?: string;
      application_id_env?: string;
      guild_id_env?: string;
      approval_channel_id_env?: string;
      owner_user_id_env?: string;
      allowed_user_ids_env?: string;
      secrets?: Partial<Record<DiscordSecretKey, SecretReferenceConfig>>;
    };
  };
};

type RagConfig = {
  enabled?: boolean;
  storage?: {
    base_dir?: string;
  };
  integrity?: {
    max_duplicate_ratio?: number;
  };
};

type DiscordSecretKey =
  | "bot_token"
  | "public_key"
  | "application_id"
  | "guild_id"
  | "approval_channel_id"
  | "owner_user_id"
  | "allowed_user_ids";

type SecretReferenceConfig = {
  provider: "windows_credential";
  target: string;
};

type PoliciesConfig = {
  git?: {
    default_base_branch?: string;
    remote?: string;
    allow_auto_push?: boolean;
    require_approval_for?: string[];
    protected_branches?: string[];
    branch_protection?: {
      expected_status_checks?: string[];
    };
  };
  review?: {
    required_for_code?: boolean;
  };
};

const apiKeyEnvNames = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY"
];

const requiredGitApprovalActions = [
  "merge",
  "deploy",
  "protected_branch_push"
];

export type GitHubBranchProtectionRequest = {
  owner: string;
  repo: string;
  branch: string;
  token: string;
};

export type GitHubBranchProtectionResult =
  | {
      kind: "protected";
      requiredPullRequestReviews: boolean;
      requiredStatusChecks: boolean;
      requiredStatusCheckContexts?: string[];
      enforceAdmins: boolean | "unknown";
    }
  | {
      kind: "not_found";
      httpStatus: number;
    }
  | {
      kind: "auth_error";
      httpStatus: number;
    }
  | {
      kind: "plan_or_permission_error";
      httpStatus: number;
    }
  | {
      kind: "api_error";
      httpStatus: number;
    }
  | {
      kind: "network_error";
    };

export type GitHubBranchProtectionClient = (
  request: GitHubBranchProtectionRequest
) => Promise<GitHubBranchProtectionResult>;

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const env = options.env ?? process.env;
  const commandAvailability = options.commandAvailability ?? isCommandAvailable;
  const checks: DoctorCheck[] = [];

  checks.push(await checkGitRepository(options.projectRoot));
  checks.push(await checkGitignore(options.projectRoot));
  checks.push(await checkConfigValidation(options.projectRoot));
  checks.push(await checkAgentConfig(options.projectRoot));
  checks.push(await checkProviderPolicyHealth(options.projectRoot));
  checks.push(await checkAgentCliAvailability(options.projectRoot, commandAvailability));
  checks.push(checkApiKeyContamination(env));
  checks.push(await checkDiscordConfig(options.projectRoot, env, options.secretResolver));
  checks.push(await checkGitPolicy(options.projectRoot));
  checks.push(
    await checkGitHubBranchProtection(
      options.projectRoot,
      env,
      options.secretResolver,
      options.githubBranchProtectionClient ?? fetchGitHubBranchProtection
    )
  );
  checks.push(await checkBoardSecretScan(options.projectRoot));
  checks.push(await checkBoardRemoteProfile(options.projectRoot));
  checks.push(await checkCorrelationIntegrity(options.projectRoot));
  checks.push(await checkConfigBackups(options.projectRoot));
  checks.push(await checkRuntimeRecovery(options.projectRoot));
  checks.push(await checkDaemonHealth(options.projectRoot));
  checks.push(await checkWatchdogAlerts(options.projectRoot));
  checks.push(await checkRagStatus(options.projectRoot));
  if (await readinessManifestExists(options.projectRoot)) {
    checks.push(await checkBetaReadiness(options.projectRoot));
  }

  const sanitizedChecks = checks.map(sanitizeDoctorCheck);
  const summary = countStatuses(sanitizedChecks);

  return {
    ok: summary.error === 0,
    checks: sanitizedChecks,
    summary
  };
}

export function formatDoctorResult(
  result: DoctorResult,
  options: { format?: "text" | "json" } = {}
): string {
  const safeResult = {
    ...result,
    checks: result.checks.map(sanitizeDoctorCheck)
  };
  if (options.format === "json") {
    return `${JSON.stringify(safeResult, null, 2)}\n`;
  }

  const lines = [
    `doctor.ok=${safeResult.ok}`,
    `summary.pass=${safeResult.summary.pass}`,
    `summary.warning=${safeResult.summary.warning}`,
    `summary.error=${safeResult.summary.error}`
  ];

  for (const check of safeResult.checks) {
    lines.push(`${check.status.toUpperCase()} ${check.id} ${check.title}`);
    for (const detail of check.details) {
      lines.push(`  - ${detail}`);
    }
    if (check.next_action !== undefined) {
      lines.push(`  next_action=${check.next_action}`);
    }
  }

  return lines.join("\n");
}

async function checkGitRepository(projectRoot: string): Promise<DoctorCheck> {
  const gitPath = resolveInside(projectRoot, ".git");

  if (await pathExists(gitPath)) {
    return pass("git.repository", "Git repository", [".git exists"]);
  }

  return warning(
    "git.repository",
    "Git repository",
    [".git was not found"],
    "Initialize Git or run Kairon against a Git repository before agent writes."
  );
}

async function checkGitignore(projectRoot: string): Promise<DoctorCheck> {
  const gitignorePath = resolveInside(projectRoot, ".gitignore");

  try {
    const content = await readFile(gitignorePath, "utf8");
    const hasKaironIgnore = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => line === ".kairon/" || line === ".kairon");

    if (hasKaironIgnore) {
      return pass("git.gitignore", ".gitignore", [".kairon/ is ignored"]);
    }

    return warning(
      "git.gitignore",
      ".gitignore",
      [".gitignore exists but does not include .kairon/"],
      "Add .kairon/ to .gitignore."
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    return warning(
      "git.gitignore",
      ".gitignore",
      [".gitignore was not found"],
      "Create .gitignore and add .kairon/."
    );
  }
}

async function checkConfigValidation(projectRoot: string): Promise<DoctorCheck> {
  try {
    const validation = await validateAllConfigs(projectRoot);
    const details = [
      ...validation.errors.map((error) => `error=${error}`),
      ...validation.warnings.map((warning) => `warning=${warning}`)
    ];

    if (!validation.ok) {
      return error(
        "config.validation",
        "Config validation",
        details,
        "Fix invalid .kairon/config/*.json files."
      );
    }

    if (validation.warnings.length > 0) {
      return warning(
        "config.validation",
        "Config validation",
        details,
        "Review config warnings before unattended operation."
      );
    }

    return pass("config.validation", "Config validation", ["all config files are valid"]);
  } catch (validationError) {
    return error(
      "config.validation",
      "Config validation",
      [String(validationError)],
      "Run kairon init or restore missing config files."
    );
  }
}

async function checkAgentConfig(projectRoot: string): Promise<DoctorCheck> {
  const config = await loadConfigFile<AgentsConfig>(projectRoot, "agents.json");
  const details: string[] = [];
  const migrationNeeded: string[] = [];

  for (const agent of agentIds) {
    const adapter = defaultAgentAdapters[agent];
    const configured = config.agents[agent];
    if (configured?.enabled !== true) {
      details.push(`${agentDisplayName(agent)}.enabled is not true`);
      continue;
    }

    details.push(
      `${agentDisplayName(agent)}: adapter=${configured.adapter ?? adapter.adapter}, command=${configured.command ?? adapter.command}`
    );
  }

  if (config.agents.gemini?.adapter === "gemini_cli") {
    migrationNeeded.push("agents.gemini.adapter is gemini_cli");
  }

  if (config.agents.gemini?.command === "gemini") {
    migrationNeeded.push("agents.gemini.command is gemini");
  }

  if (migrationNeeded.length > 0) {
    return warning(
      "config.agents",
      "Agent config",
      [...details, ...migrationNeeded],
      "Run kairon migrate."
    );
  }

  return pass("config.agents", "Agent config", details);
}

async function checkProviderPolicyHealth(projectRoot: string): Promise<DoctorCheck> {
  const health = await listProviderPolicyHealth(projectRoot, { persist: false });
  const details = health.map((entry) =>
    [
      `${agentDisplayName(entry.agent)}: status=${entry.status}`,
      `available=${entry.available}`,
      `category=${entry.failure_category ?? "none"}`,
      `daily_runs=${entry.daily_run_count}/${entry.policy.daily_run_limit}`,
      `active_runs=${entry.active_run_ids.length}/${entry.policy.max_concurrent}`,
      `unattended_allowed=${entry.policy.unattended_allowed}`,
      `next_retry_at=${entry.next_retry_at ?? "none"}`
    ].join(", ")
  );
  const blocked = health.filter((entry) => entry.status !== "ready");

  if (blocked.length > 0) {
    return warning(
      "agent.provider_policy",
      "Agent provider policy",
      details,
      "Resolve provider quota, authentication, setup, or compliance issues, then use kairon agent resume --agent <agent> --reason <reason> when manual verification is complete."
    );
  }

  return pass("agent.provider_policy", "Agent provider policy", details);
}

async function checkAgentCliAvailability(
  projectRoot: string,
  commandAvailability: CommandAvailabilityChecker
): Promise<DoctorCheck> {
  const config = await loadConfigFile<AgentsConfig>(projectRoot, "agents.json");
  const details: string[] = [];
  const missing: string[] = [];

  for (const agent of agentIds) {
    const command = config.agents[agent]?.command ?? defaultAgentAdapters[agent].command;
    const available = await commandAvailability(command);
    details.push(`${agentDisplayName(agent)}: ${command} available=${available}`);
    if (!available) {
      missing.push(`${agentDisplayName(agent)}:${command}`);
    }
  }

  if (missing.length > 0) {
    return error(
      "cli.availability",
      "Official CLI availability",
      details,
      `Install or login to missing official CLIs: ${missing.join(", ")}.`
    );
  }

  return pass("cli.availability", "Official CLI availability", details);
}

function checkApiKeyContamination(env: NodeJS.ProcessEnv): DoctorCheck {
  const present = apiKeyEnvNames.filter((name) => env[name] !== undefined);

  if (present.length === 0) {
    return pass("env.api_keys", "API key contamination", ["no API key env vars detected"]);
  }

  return warning(
    "env.api_keys",
    "API key contamination",
    present.map((name) => `${name}=present`),
    "Unset API key env vars when testing subscription-only CLI operation."
  );
}

async function checkDiscordConfig(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  secretResolver?: SecretResolver
): Promise<DoctorCheck> {
  const config = await loadConfigFile<NotificationsConfig>(projectRoot, "notifications.json");
  const discord = config.providers?.discord;

  if (config.primary_provider !== "discord" || discord === undefined) {
    return warning(
      "discord.config",
      "Discord notification config",
      ["Discord provider is not configured"],
      "Review .kairon/config/notifications.json, then run kairon doctor. Guide: docs/discord-approval-v0.md."
    );
  }

  const envNames = [
    discord.bot_token_env,
    discord.application_id_env,
    discord.guild_id_env,
    discord.approval_channel_id_env,
    discord.owner_user_id_env,
    discord.allowed_user_ids_env
  ].filter((value): value is string => value !== undefined && value.length > 0);
  const gatewayEnvNames = [
    discord.bot_token_env,
    discord.application_id_env,
    discord.guild_id_env,
    discord.approval_channel_id_env,
    discord.owner_user_id_env
  ].filter((value): value is string => value !== undefined && value.length > 0);
  const publicKeyEnv = discord.public_key_env ?? "KAIRON_DISCORD_PUBLIC_KEY";
  const secretResolutions = await resolveDiscordSecrets(discord, env, secretResolver);
  const resolvedEnv = { ...env };
  for (const [name, resolution] of secretResolutions.entries()) {
    if (resolution.status === "present") {
      resolvedEnv[name] = resolution.value;
    }
  }
  const isResolved = (name: string) =>
    secretResolutions.get(name)?.status === "present";
  const present = envNames.filter((name) => isResolved(name));
  const missing = envNames.filter((name) => !isResolved(name));
  const gatewayMissing = gatewayEnvNames.filter((name) => !isResolved(name));
  const envValidation = validateDiscordEnvValues({
    env: resolvedEnv,
    applicationIdEnv: discord.application_id_env,
    guildIdEnv: discord.guild_id_env,
    approvalChannelIdEnv: discord.approval_channel_id_env,
    ownerUserIdEnv: discord.owner_user_id_env,
    allowedUserIdsEnv: discord.allowed_user_ids_env
  });
  const gatewayInvalid = envValidation.gateway_invalid_env;
  const liveInvalid = envValidation.live_invalid_env;
  const httpProfile = prepareDiscordHttpProfile(config.http);
  const publicKeyResolution = secretResolutions.get(publicKeyEnv);
  const publicKeyPresent = publicKeyResolution?.status === "present";
  const publicKeyInvalid =
    publicKeyResolution?.status === "present" &&
    !/^[0-9a-f]{64}$/i.test(publicKeyResolution.value.trim());
  const httpMissing = [
    ...httpProfile.missingConfig,
    ...(httpProfile.profile === "reverse-proxy" && !publicKeyPresent
      ? [publicKeyEnv]
      : [])
  ];
  const httpInvalid = [
    ...httpProfile.invalidConfig,
    ...(httpProfile.profile === "reverse-proxy" && publicKeyInvalid
      ? [publicKeyEnv]
      : [])
  ];
  const httpStatus =
    discord.enabled !== true
      ? "not_configured"
      : httpProfile.profile === "loopback"
        ? publicKeyPresent && !publicKeyInvalid
          ? "ready"
          : "not_configured"
        : httpMissing.length === 0 && httpInvalid.length === 0
          ? "ready"
          : "setup_required";
  const gatewayReady = gatewayMissing.length === 0 && gatewayInvalid.length === 0;
  const liveReady =
    discord.enabled === true && missing.length === 0 && liveInvalid.length === 0;
  const gatewayStatus =
    discord.enabled !== true
      ? "not_configured"
      : gatewayReady
        ? "ready"
        : "setup_required";
  const liveStatus =
    discord.enabled !== true
      ? "not_configured"
      : liveReady
        ? "ready"
        : "setup_required";
  const details = [
    `enabled=${discord.enabled === true}`,
    `mode=${discord.mode ?? "unknown"}`,
    `gateway_status=${gatewayStatus}`,
    `live_status=${liveStatus}`,
    `http_profile=${httpProfile.profile}`,
    `http_status=${httpStatus}`,
    `http_missing=${httpMissing.length === 0 ? "none" : httpMissing.join(",")}`,
    `http_invalid=${httpInvalid.length === 0 ? "none" : httpInvalid.join(",")}`,
    `live_missing_env=${missing.length === 0 ? "none" : missing.join(",")}`,
    `gateway_invalid_env=${gatewayInvalid.length === 0 ? "none" : gatewayInvalid.join(",")}`,
    `live_invalid_env=${liveInvalid.length === 0 ? "none" : liveInvalid.join(",")}`,
    ...envNames.map((name) => `${name}=${isResolved(name) ? "present" : "missing"}`),
    ...envNames.map((name) => `${name}_provider=${providerName(secretResolutions.get(name))}`)
  ];

  if (discord.enabled === true && gatewayMissing.length > 0) {
    return error(
      "discord.config",
      "Discord notification config",
      details,
      `Set missing Discord gateway env vars: ${gatewayMissing.join(", ")}. Then run kairon doctor. Guide: docs/discord-approval-v0.md.`
    );
  }

  if (discord.enabled === true && gatewayInvalid.length > 0) {
    return error(
      "discord.config",
      "Discord notification config",
      details,
      `Fix invalid Discord gateway env vars: ${gatewayInvalid.join(", ")}. Then run kairon doctor. Guide: docs/discord-approval-v0.md.`
    );
  }

  if (discord.enabled === true && missing.length > 0) {
    return warning(
      "discord.config",
      "Discord notification config",
      details,
      `Set missing Discord live env vars: ${missing.join(", ")}. Then run kairon doctor. Guide: docs/discord-approval-v0.md.`
    );
  }

  if (discord.enabled === true && liveInvalid.length > 0) {
    return warning(
      "discord.config",
      "Discord notification config",
      details,
      `Fix invalid Discord live env vars: ${liveInvalid.join(", ")}. Then run kairon doctor. Guide: docs/discord-approval-v0.md.`
    );
  }

  if (
    discord.enabled === true &&
    httpProfile.profile === "reverse-proxy" &&
    (httpMissing.length > 0 || httpInvalid.length > 0)
  ) {
    return warning(
      "discord.config",
      "Discord notification config",
      details,
      "Configure an HTTPS external_base_url, trusted proxy CIDRs, and the Discord public key secret before starting the reverse-proxy HTTP profile."
    );
  }

  if (discord.enabled !== true && present.length > 0) {
    return warning(
      "discord.config",
      "Discord notification config",
      details,
      "Enable the Discord provider or unset the unused env vars, then run kairon doctor. Guide: docs/discord-approval-v0.md."
    );
  }

  return pass("discord.config", "Discord notification config", details);
}

function hasEnvValue(env: NodeJS.ProcessEnv, name: string): boolean {
  return (env[name] ?? "").trim().length > 0;
}

async function checkGitPolicy(projectRoot: string): Promise<DoctorCheck> {
  const config = await loadConfigFile<PoliciesConfig>(projectRoot, "policies.json");
  const approvalActions = config.git?.require_approval_for ?? [];
  const missingApprovalActions = requiredGitApprovalActions.filter(
    (action) => !approvalActions.includes(action)
  );
  const details = [
    `allow_auto_push=${config.git?.allow_auto_push === true}`,
    `protected_branches=${(config.git?.protected_branches ?? []).join(",")}`,
    `require_approval_for=${approvalActions.join(",")}`,
    `review.required_for_code=${config.review?.required_for_code === true}`
  ];

  if (missingApprovalActions.length > 0 || config.review?.required_for_code !== true) {
    return error(
      "policy.safety",
      "Safety policy",
      details,
      `Require approval for ${missingApprovalActions.join(", ")} and keep review.required_for_code=true.`
    );
  }

  if (config.git?.allow_auto_push === true) {
    return warning(
      "policy.safety",
      "Safety policy",
      details,
      "allow_auto_push=true should remain disabled until review and rollback paths are proven."
    );
  }

  return pass("policy.safety", "Safety policy", details);
}

async function checkGitHubBranchProtection(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  secretResolver: SecretResolver | undefined,
  client: GitHubBranchProtectionClient
): Promise<DoctorCheck> {
  const config = await loadConfigFile<PoliciesConfig>(projectRoot, "policies.json");
  const branch = config.git?.default_base_branch ?? "main";
  const configuredRemote = config.git?.remote;
  const expectedStatusChecks = resolveExpectedStatusChecks(config, env);
  const remote = await readGitHubRemote(projectRoot, configuredRemote);

  if (remote === undefined) {
    return pass("git.branch_protection", "GitHub branch protection", [
      "skipped: no GitHub remote configured"
    ]);
  }

  const repository = parseGitHubRepository(remote.url);

  if (repository === undefined) {
    return warning(
      "git.branch_protection",
      "GitHub branch protection",
      [
        `remote=${remote.name}`,
        `branch=${branch}`,
        "repository=unresolved",
        "verification_status=setup_required",
        "network_check=skipped"
      ],
      "Use a supported GitHub remote URL format, then run kairon doctor. Guide: docs/github-branch-protection-sandbox-v0.md."
    );
  }

  const token = await resolveGitHubToken(env, secretResolver);
  const details = [
    `remote=${remote.name}`,
    `repository=${repository.owner}/${repository.repo}`,
    `branch=${branch}`,
    `auth=${token.status === "present" ? "present" : "missing"}`,
    `auth_provider=${token.status === "present" ? token.provider : "none"}`,
    `auth_source=${token.status === "present" ? token.source : "none"}`
  ];

  if (token.status === "missing") {
    return warning(
      "git.branch_protection",
      "GitHub branch protection",
      [...details, "verification_status=setup_required", "network_check=skipped"],
      "Set GH_TOKEN or GITHUB_TOKEN, or configure KAIRON_GH_TOKEN_CREDENTIAL_TARGET / KAIRON_GITHUB_TOKEN_CREDENTIAL_TARGET, then run kairon doctor. Guide: docs/github-branch-protection-sandbox-v0.md."
    );
  }

  const apiResult = await client({
    owner: repository.owner,
    repo: repository.repo,
    branch,
    token: token.value
  });
  const missingExpectedStatusChecks =
    apiResult.kind === "protected"
      ? findMissingExpectedStatusChecks(
          expectedStatusChecks,
          apiResult.requiredStatusCheckContexts ?? []
        )
      : [];
  const apiDetails = [
    ...details,
    "network_check=completed",
    ...formatGitHubApiDetails(
      apiResult,
      expectedStatusChecks,
      missingExpectedStatusChecks
    )
  ];

  if (apiResult.kind === "protected") {
    const missingProtections = [
      apiResult.requiredPullRequestReviews ? undefined : "required_pull_request_reviews",
      apiResult.requiredStatusChecks ? undefined : "required_status_checks"
    ].filter((value): value is string => value !== undefined);

    if (missingProtections.length === 0 && missingExpectedStatusChecks.length === 0) {
      return pass("git.branch_protection", "GitHub branch protection", apiDetails);
    }

    const nextActions: string[] = [];
    if (missingProtections.length > 0) {
      nextActions.push(
        `Enable GitHub branch protection gates: ${missingProtections.join(", ")}.`
      );
    }
    if (missingExpectedStatusChecks.length > 0) {
      nextActions.push(
        `Add expected required status checks: ${missingExpectedStatusChecks.join(", ")}.`
      );
    }
    nextActions.push(
      "Then run kairon doctor. Guide: docs/github-branch-protection-sandbox-v0.md."
    );

    return warning(
      "git.branch_protection",
      "GitHub branch protection",
      apiDetails,
      nextActions.join(" ")
    );
  }

  if (apiResult.kind === "auth_error") {
    return warning(
      "git.branch_protection",
      "GitHub branch protection",
      apiDetails,
      "Check GH_TOKEN or GITHUB_TOKEN authentication, then run kairon doctor. Guide: docs/github-branch-protection-sandbox-v0.md."
    );
  }

  if (apiResult.kind === "plan_or_permission_error") {
    return warning(
      "git.branch_protection",
      "GitHub branch protection",
      apiDetails,
      "GitHub returned 403. Check token repository access and Administration read permission; for private repositories on plans that do not expose branch protection enforcement, run the public sandbox check in docs/github-branch-protection-sandbox-v0.md."
    );
  }

  if (apiResult.kind === "not_found") {
    return warning(
      "git.branch_protection",
      "GitHub branch protection",
      apiDetails,
      "Enable branch protection for the default branch, verify repository/branch access, or run the public sandbox check in docs/github-branch-protection-sandbox-v0.md."
    );
  }

  return warning(
    "git.branch_protection",
    "GitHub branch protection",
    apiDetails,
    "Retry kairon doctor after network or GitHub API access is healthy. Guide: docs/github-branch-protection-sandbox-v0.md."
  );
}

async function checkConfigBackups(projectRoot: string): Promise<DoctorCheck> {
  const backups = await listConfigBackups(projectRoot);

  if (backups.length === 0) {
    return pass("config.backups", "Config backups", ["no config backups found"]);
  }

  return warning(
    "config.backups",
    "Config backups",
    [`count=${backups.length}`, ...backups.slice(0, 5).map((backup) => `backup=${backup}`)],
    "Run kairon maintenance run and review the cleanup proposal before moving old config backups."
  );
}

async function checkBoardSecretScan(projectRoot: string): Promise<DoctorCheck> {
  const notifications = await loadConfigFile<NotificationsConfig>(
    projectRoot,
    "notifications.json"
  );
  const boardEnabled = notifications.board?.enabled === true;
  const projectionPath = resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "board",
    "projection.json"
  );

  let projection: unknown;
  try {
    projection = await readJsonFile(projectionPath);
  } catch (readError) {
    if ((readError as NodeJS.ErrnoException).code === "ENOENT" || String(readError).includes("ENOENT")) {
      const details = [
        `enabled=${boardEnabled}`,
        "projection=missing",
        `status=${boardEnabled ? "setup_required" : "not_configured"}`,
        "scan_status=not_run"
      ];
      return boardEnabled
        ? warning(
            "board.secret_scan",
            "Board secret scan",
            details,
            "Run kairon board export, then run kairon doctor. Guide: docs/board-public-safety-v0.md."
          )
        : pass("board.secret_scan", "Board secret scan", details);
    }

    return warning(
      "board.secret_scan",
      "Board secret scan",
      [
        `enabled=${boardEnabled}`,
        "projection=unreadable",
        "status=setup_required",
        "scan_status=warning"
      ],
      "Run kairon board export to regenerate a valid sanitized projection, then run kairon doctor. Guide: docs/board-public-safety-v0.md."
    );
  }

  const inspection = inspectBoardProjectionSecrets(projection);
  const embedded = readBoardSecretScanSummary(projection);
  const details = [
    `enabled=${boardEnabled}`,
    "projection=.kairon/board/projection.json",
    `scan_status=${inspection.status}`,
    `exposed_findings=${inspection.exposed_findings}`,
    `embedded_status=${embedded?.status ?? "missing"}`,
    `embedded_redactions=${
      embedded === undefined
        ? 0
        : embedded.redacted_fields + embedded.redacted_values
    }`
  ];

  if (
    inspection.exposed_findings > 0 ||
    embedded === undefined ||
    embedded.status !== "passed" ||
    embedded.unresolved_findings > 0
  ) {
    return warning(
      "board.secret_scan",
      "Board secret scan",
      [...details, "status=setup_required"],
      "Run kairon board export, then review the secret scan summary and run kairon doctor before serving Board. Guide: docs/board-public-safety-v0.md."
    );
  }

  return pass("board.secret_scan", "Board secret scan", details);
}

async function checkBoardRemoteProfile(projectRoot: string): Promise<DoctorCheck> {
  const notifications = await loadConfigFile<NotificationsConfig>(
    projectRoot,
    "notifications.json"
  );
  const prepared = prepareBoardProfile(notifications.board);
  if (prepared.profile !== "remote-readonly") {
    return pass("board.remote_profile", "Board remote read-only profile", [
      `profile=${prepared.profile}`,
      "status=not_configured"
    ]);
  }

  const records = await listBoardAccessRecords(projectRoot);
  const now = Date.now();
  const activeAccess = records.filter(
    (record) =>
      record.status === "active" &&
      Number.isFinite(Date.parse(record.expires_at)) &&
      Date.parse(record.expires_at) > now
  ).length;
  const details = [
    `profile=${prepared.profile}`,
    `external_base_url=${prepared.externalBaseUrl === undefined ? "missing" : "configured"}`,
    `trusted_proxies=${prepared.trustedProxies.length}`,
    `allowed_origins=${prepared.allowedOrigins.length}`,
    `identity_header=${prepared.identityHeader}`,
    `rate_limit_per_minute=${prepared.rateLimitPerMinute}`,
    `active_access=${activeAccess}`
  ];
  const issues = [...prepared.invalidConfig, ...prepared.missingConfig];
  if (issues.length > 0) {
    return warning(
      "board.remote_profile",
      "Board remote read-only profile",
      [...details, `setup_issues=${issues.join(",")}`, "status=setup_required"],
      "Complete notifications.board remote-readonly settings, then run kairon doctor."
    );
  }
  if (activeAccess === 0) {
    return warning(
      "board.remote_profile",
      "Board remote read-only profile",
      [...details, "status=setup_required"],
      "Run kairon board access issue --ttl-minutes 15 before remote access."
    );
  }
  return pass("board.remote_profile", "Board remote read-only profile", [
    ...details,
    "status=ready"
  ]);
}

async function checkCorrelationIntegrity(projectRoot: string): Promise<DoctorCheck> {
  const integrity = await inspectCorrelationIntegrity(projectRoot);
  const details = [
    `total=${integrity.total}`,
    `healthy=${integrity.healthy}`,
    `missing_artifacts=${integrity.missing_artifacts}`,
    `stale_messages=${integrity.stale_messages}`,
    `orphan_follow_ups=${integrity.orphan_follow_ups}`,
    `duplicate_members=${integrity.duplicate_members}`
  ];
  if (integrity.issues.length === 0) {
    return pass("correlation.integrity", "Correlation integrity", details);
  }
  return warning(
    "correlation.integrity",
    "Correlation integrity",
    [
      ...details,
      ...integrity.issues.slice(0, 5).map(
        (issue) =>
          `issue=${issue.kind}:${issue.correlation_id}:${issue.member_kind}:${issue.member_id}`
      )
    ],
    "Inspect .kairon/correlations and repair or regenerate the missing correlation links."
  );
}

async function checkRuntimeRecovery(projectRoot: string): Promise<DoctorCheck> {
  const recovery = await inspectRuntimeRecoveryTargets(projectRoot);
  const details = [
    `targets=${recovery.summary.targets}`,
    `stale_locks=${recovery.summary.stale_locks}`,
    `expired_claims=${recovery.summary.expired_claims}`,
    `run_issues=${recovery.summary.run_issues}`,
    `gateway_issues=${recovery.summary.gateway_issues}`,
    `git_transaction_issues=${recovery.summary.git_transaction_issues}`,
    `resolved_targets=${recovery.summary.resolved_targets}`
  ];

  if (recovery.summary.targets === 0) {
    return pass("runtime.recovery", "Runtime recovery", details);
  }

  return warning(
    "runtime.recovery",
    "Runtime recovery",
    details,
    "Run kairon recovery run and review any generated approval requests."
  );
}

async function checkDaemonHealth(projectRoot: string): Promise<DoctorCheck> {
  try {
    const status = await getRuntimeStatus(projectRoot);
    const daemon = status.daemonHealth;

    if (daemon === undefined) {
      return pass("daemon.health", "Daemon health", [
        "status=not_observed",
        "daemon_log=missing"
      ]);
    }

    const details = [
      `status=${daemon.status}`,
      `daemon_log=${daemon.latest_log ?? "missing"}`,
      `fatal_errors=${daemon.fatal_errors ?? 0}`,
      `stale_lock_suspected=${daemon.stale_lock_suspected === true}`,
      `last_error_code=${daemon.last_error?.code ?? "none"}`
    ];

    if (daemon.status === "running" || daemon.status === "stopped") {
      return pass("daemon.health", "Daemon health", details);
    }

    if (daemon.status === "stale_lock") {
      return warning(
        "daemon.health",
        "Daemon health",
        [...details, "remediation_status=setup_required"],
        "Run kairon recovery run, then kairon daemon report and kairon doctor. Guide: docs/windows-daemon-ops-v0.md."
      );
    }

    return warning(
      "daemon.health",
      "Daemon health",
      [...details, "remediation_status=setup_required"],
      "Run kairon daemon report, review the last error, then run kairon recovery run and kairon doctor. Guide: docs/windows-daemon-ops-v0.md."
    );
  } catch {
    return warning(
      "daemon.health",
      "Daemon health",
      ["status=unavailable", "remediation_status=setup_required"],
      "Run kairon status and kairon recovery run, then retry kairon doctor. Guide: docs/windows-daemon-ops-v0.md."
    );
  }
}

async function checkWatchdogAlerts(projectRoot: string): Promise<DoctorCheck> {
  try {
    const watchdog = (await getRuntimeStatus(projectRoot)).watchdog;
    const details = [
      `open=${watchdog.open}`,
      `acknowledged=${watchdog.acknowledged}`,
      `resolved=${watchdog.resolved}`,
      `highest_severity=${watchdog.highest_severity}`,
      `notifications_pending=${watchdog.notifications_pending}`,
      `last_checked_at=${watchdog.last_checked_at ?? "never"}`
    ];
    if (watchdog.open === 0 && watchdog.acknowledged === 0) {
      return pass("watchdog.alerts", "Runtime watchdog alerts", details);
    }
    return warning(
      "watchdog.alerts",
      "Runtime watchdog alerts",
      details,
      "Run kairon watchdog list, inspect each alert, and resolve only after remediation."
    );
  } catch {
    return warning(
      "watchdog.alerts",
      "Runtime watchdog alerts",
      ["status=unavailable"],
      "Run kairon watchdog check, then retry kairon doctor."
    );
  }
}

async function checkRagStatus(projectRoot: string): Promise<DoctorCheck> {
  const config = await loadConfigFile<RagConfig>(projectRoot, "rag.json");
  const baseDir = config.storage?.base_dir ?? ".kairon/rag";
  const relativeIndexPath = `${baseDir.replaceAll("\\", "/").replace(/\/$/, "")}/index.json`;
  const enabled = config.enabled === true;

  if (!enabled) {
    return pass("rag.status", "RAG index", [
      "enabled=false",
      "status=not_configured",
      `index=${relativeIndexPath}`
    ]);
  }

  const [integrity, stats] = await Promise.all([
    verifyRagIndex(projectRoot, { writeArtifact: false }),
    getRagStats(projectRoot)
  ]);
  const duplicateThreshold = config.integrity?.max_duplicate_ratio ?? 0.25;
  const details = [
    "enabled=true",
    `status=${integrity.status === "PASS" ? "ready" : integrity.status.toLowerCase()}`,
    `index=${relativeIndexPath}`,
    `index_validation=${integrity.status === "SETUP_REQUIRED" ? "missing" : integrity.status.toLowerCase()}`,
    `source_count=${integrity.source_count}`,
    `chunk_count=${integrity.chunk_count}`,
    `integrity_issues=${integrity.issue_count}`,
    `duplicate_ratio=${stats.duplicate_ratio.toFixed(4)}`,
    `context_budget_tokens=${stats.context_budget_tokens}`,
    `chunks_exceeding_context_budget=${stats.chunks_exceeding_context_budget}`,
    `rebuild_due=${stats.rebuild_due}`,
    ...integrity.issues.slice(0, 5).map(
      (issue) => `issue=${issue.code}:${issue.member_id ?? "none"}:${issue.path ?? "none"}`
    )
  ];
  if (integrity.status === "PASS" && stats.duplicate_ratio <= duplicateThreshold) {
    return pass("rag.status", "RAG index", details);
  }
  return warning(
    "rag.status",
    "RAG index",
    details,
    integrity.status === "SETUP_REQUIRED"
      ? "Run kairon rag refresh, then run kairon rag verify. Guide: docs/rag-memory-v0.md."
      : "Run kairon rag verify and kairon rag rebuild --dry-run --compare. Guide: docs/rag-memory-v0.md."
  );
}

function sanitizeDoctorCheck(check: DoctorCheck): DoctorCheck {
  return {
    ...check,
    details: check.details.map(sanitizeDoctorText),
    next_action:
      check.next_action === undefined
        ? undefined
        : sanitizeDoctorText(check.next_action)
  };
}

function sanitizeDoctorText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/giu, "Bearer [redacted]")
    .replace(
      /\b(?:github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,})\b/gu,
      "[redacted]"
    )
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*[^\s,;]+/giu,
      "$1=[redacted]"
    );
}

async function readGitHubRemote(
  projectRoot: string,
  preferredRemote?: string
): Promise<{ name: string; url: string } | undefined> {
  try {
    const config = await readFile(resolveInside(projectRoot, ".git", "config"), "utf8");
    const remotes = parseGitRemotes(config);
    const githubRemotes = remotes.filter((remote) => isGitHubRemoteUrl(remote.url));
    return (
      githubRemotes.find((remote) => remote.name === preferredRemote) ?? githubRemotes[0]
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

function parseGitRemotes(config: string): Array<{ name: string; url: string }> {
  const remotes: Array<{ name: string; url: string }> = [];
  let currentRemote: string | undefined;

  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[remote\s+"([^"]+)"\]\s*$/.exec(line);
    if (section !== null) {
      currentRemote = section[1];
      continue;
    }

    if (/^\s*\[/.test(line)) {
      currentRemote = undefined;
      continue;
    }

    const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (currentRemote !== undefined && url !== null) {
      remotes.push({ name: currentRemote, url: url[1] ?? "" });
    }
  }

  return remotes.filter((remote) => remote.url.length > 0);
}

function isGitHubRemoteUrl(remoteUrl: string): boolean {
  return /github\.com(?::|\/)/i.test(remoteUrl);
}

function parseGitHubRepository(
  remoteUrl: string
): { owner: string; repo: string } | undefined {
  const trimmed = remoteUrl.trim();

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.toLowerCase() !== "github.com") {
      return undefined;
    }

    return parseGitHubPath(parsed.pathname);
  } catch {
    // Fall through to SCP-like SSH URL parsing.
  }

  const scpLike = /^git@github\.com:([^/]+)\/(.+)$/i.exec(trimmed);
  if (scpLike !== null) {
    return normalizeGitHubRepository(scpLike[1] ?? "", scpLike[2] ?? "");
  }

  return undefined;
}

function parseGitHubPath(pathname: string): { owner: string; repo: string } | undefined {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return undefined;
  }

  return normalizeGitHubRepository(segments[0] ?? "", segments[1] ?? "");
}

function normalizeGitHubRepository(
  owner: string,
  repo: string
): { owner: string; repo: string } | undefined {
  const normalizedOwner = owner.trim();
  const normalizedRepo = repo.trim().replace(/\.git$/i, "");

  if (normalizedOwner.length === 0 || normalizedRepo.length === 0) {
    return undefined;
  }

  if (normalizedOwner.includes("/") || normalizedRepo.includes("/")) {
    return undefined;
  }

  return { owner: normalizedOwner, repo: normalizedRepo };
}

async function resolveDiscordSecrets(
  discord: NonNullable<NonNullable<NotificationsConfig["providers"]>["discord"]>,
  env: NodeJS.ProcessEnv,
  resolver?: SecretResolver
): Promise<Map<string, ResolvedSecret>> {
  const fields: Array<{ key: DiscordSecretKey; envName?: string }> = [
    { key: "bot_token", envName: discord.bot_token_env },
    {
      key: "public_key",
      envName: discord.public_key_env ?? "KAIRON_DISCORD_PUBLIC_KEY"
    },
    { key: "application_id", envName: discord.application_id_env },
    { key: "guild_id", envName: discord.guild_id_env },
    { key: "approval_channel_id", envName: discord.approval_channel_id_env },
    { key: "owner_user_id", envName: discord.owner_user_id_env },
    { key: "allowed_user_ids", envName: discord.allowed_user_ids_env }
  ];
  const results = new Map<string, ResolvedSecret>();

  for (const field of fields) {
    if (field.envName === undefined || field.envName.length === 0) {
      continue;
    }

    results.set(
      field.envName,
      await resolveSecret({
        env,
        envName: field.envName,
        references: discordSecretReferences(discord, field.key),
        resolver
      })
    );
  }

  return results;
}

async function resolveGitHubToken(
  env: NodeJS.ProcessEnv,
  resolver?: SecretResolver
): Promise<ResolvedSecret> {
  const ghToken = await resolveSecret({
    env,
    envName: "GH_TOKEN",
    references: githubCredentialReferences(env, "KAIRON_GH_TOKEN_CREDENTIAL_TARGET"),
    resolver
  });
  if (ghToken.status === "present") {
    return ghToken;
  }

  return resolveSecret({
    env,
    envName: "GITHUB_TOKEN",
    references: githubCredentialReferences(
      env,
      "KAIRON_GITHUB_TOKEN_CREDENTIAL_TARGET"
    ),
    resolver
  });
}

function discordSecretReferences(
  discord: NonNullable<NonNullable<NotificationsConfig["providers"]>["discord"]>,
  key: DiscordSecretKey
): SecretReference[] {
  const reference = discord.secrets?.[key];
  if (reference === undefined) {
    return [];
  }

  return [
    {
      provider: "windows_credential",
      target: reference.target
    }
  ];
}

function githubCredentialReferences(
  env: NodeJS.ProcessEnv,
  targetEnvName: string
): SecretReference[] {
  const target = env[targetEnvName]?.trim();
  if (target === undefined || target.length === 0) {
    return [];
  }

  return [
    {
      provider: "windows_credential",
      target
    }
  ];
}

function providerName(resolution: ResolvedSecret | undefined): string {
  return resolution?.status === "present" ? resolution.provider : "none";
}

function readBoardSecretScanSummary(
  value: unknown
): BoardSecretScanSummary | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const meta = (value as Record<string, unknown>).meta;
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const scan = (meta as Record<string, unknown>).secret_scan;
  if (scan === null || typeof scan !== "object" || Array.isArray(scan)) {
    return undefined;
  }

  const record = scan as Record<string, unknown>;
  if (
    (record.status !== "passed" && record.status !== "warning") ||
    !isFiniteNumber(record.scanned_fields) ||
    !isFiniteNumber(record.scanned_strings) ||
    !isFiniteNumber(record.redacted_fields) ||
    !isFiniteNumber(record.redacted_values) ||
    !isFiniteNumber(record.unresolved_findings)
  ) {
    return undefined;
  }

  return {
    status: record.status,
    scanned_fields: record.scanned_fields,
    scanned_strings: record.scanned_strings,
    redacted_fields: record.redacted_fields,
    redacted_values: record.redacted_values,
    unresolved_findings: record.unresolved_findings
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function formatGitHubApiDetails(
  result: GitHubBranchProtectionResult,
  expectedStatusChecks: string[] = [],
  missingExpectedStatusChecks: string[] = []
): string[] {
  if (result.kind === "protected") {
    const actualContexts = result.requiredStatusCheckContexts ?? [];
    const verificationReady =
      result.requiredPullRequestReviews &&
      result.requiredStatusChecks &&
      missingExpectedStatusChecks.length === 0;
    const details = [
      `verification_status=${verificationReady ? "ready" : "setup_required"}`,
      "api_status=ok",
      "branch_protection=enabled",
      `required_pull_request_reviews=${result.requiredPullRequestReviews ? "present" : "missing"}`,
      `required_status_checks=${result.requiredStatusChecks ? "present" : "missing"}`,
      `required_status_check_contexts=${formatCsvDetail(actualContexts)}`,
      `enforce_admins=${String(result.enforceAdmins)}`
    ];

    if (expectedStatusChecks.length > 0) {
      details.push(
        `expected_status_checks=${formatCsvDetail(expectedStatusChecks)}`,
        `missing_expected_status_checks=${formatCsvDetail(missingExpectedStatusChecks)}`
      );
    }

    return details;
  }

  if (result.kind === "not_found") {
    return [
      "verification_status=setup_required",
      "api_status=not_found_or_unprotected",
      `http_status=${result.httpStatus}`
    ];
  }

  if (result.kind === "auth_error") {
    return [
      "verification_status=setup_required",
      "api_status=auth_error",
      `http_status=${result.httpStatus}`
    ];
  }

  if (result.kind === "plan_or_permission_error") {
    return [
      "verification_status=setup_required",
      "api_status=plan_or_permission_error",
      `http_status=${result.httpStatus}`
    ];
  }

  if (result.kind === "api_error") {
    return [
      "verification_status=setup_required",
      "api_status=api_error",
      `http_status=${result.httpStatus}`
    ];
  }

  return ["verification_status=setup_required", "api_status=network_error"];
}

async function fetchGitHubBranchProtection(
  request: GitHubBranchProtectionRequest
): Promise<GitHubBranchProtectionResult> {
  if (typeof globalThis.fetch !== "function") {
    return { kind: "network_error" };
  }

  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(request.owner)}/${encodeURIComponent(request.repo)}/branches/${encodeURIComponent(request.branch)}/protection`
  );

  try {
    const response = await globalThis.fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${request.token}`,
        "User-Agent": "kairon-doctor",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });

    if (response.status === 200) {
      const payload = (await response.json()) as GitHubBranchProtectionPayload;
      return {
        kind: "protected",
        requiredPullRequestReviews: payload.required_pull_request_reviews != null,
        requiredStatusChecks: payload.required_status_checks != null,
        requiredStatusCheckContexts: extractRequiredStatusCheckContexts(
          payload.required_status_checks
        ),
        enforceAdmins:
          typeof payload.enforce_admins?.enabled === "boolean"
            ? payload.enforce_admins.enabled
            : "unknown"
      };
    }

    if (response.status === 401) {
      return { kind: "auth_error", httpStatus: response.status };
    }

    if (response.status === 403) {
      return { kind: "plan_or_permission_error", httpStatus: response.status };
    }

    if (response.status === 404) {
      return { kind: "not_found", httpStatus: response.status };
    }

    return { kind: "api_error", httpStatus: response.status };
  } catch {
    return { kind: "network_error" };
  }
}

type GitHubBranchProtectionPayload = {
  required_pull_request_reviews?: unknown | null;
  required_status_checks?: {
    contexts?: unknown;
    checks?: unknown;
  } | null;
  enforce_admins?: {
    enabled?: boolean;
  } | null;
};

function resolveExpectedStatusChecks(
  config: PoliciesConfig,
  env: NodeJS.ProcessEnv
): string[] {
  const envChecks = parseCommaSeparatedList(env.KAIRON_GITHUB_EXPECTED_STATUS_CHECKS);
  if (envChecks.length > 0) {
    return envChecks;
  }

  return normalizeStringList(config.git?.branch_protection?.expected_status_checks ?? []);
}

function parseCommaSeparatedList(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  return normalizeStringList(value.split(","));
}

function normalizeStringList(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function findMissingExpectedStatusChecks(
  expected: string[],
  actual: string[]
): string[] {
  const actualSet = new Set(actual);
  return expected.filter((check) => !actualSet.has(check));
}

function formatCsvDetail(values: string[]): string {
  return values.length === 0 ? "none" : values.join(",");
}

function extractRequiredStatusCheckContexts(
  requiredStatusChecks: GitHubBranchProtectionPayload["required_status_checks"]
): string[] {
  if (requiredStatusChecks == null || typeof requiredStatusChecks !== "object") {
    return [];
  }

  const contexts: string[] = [];
  if (Array.isArray(requiredStatusChecks.contexts)) {
    contexts.push(
      ...requiredStatusChecks.contexts.filter(
        (context): context is string => typeof context === "string"
      )
    );
  }

  if (Array.isArray(requiredStatusChecks.checks)) {
    for (const check of requiredStatusChecks.checks) {
      if (check != null && typeof check === "object") {
        const context = (check as { context?: unknown }).context;
        if (typeof context === "string") {
          contexts.push(context);
        }
      }
    }
  }

  return normalizeStringList(contexts);
}

async function listConfigBackups(projectRoot: string): Promise<string[]> {
  const configDir = getKaironPaths(projectRoot).configDir;

  try {
    const entries = await readdir(configDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.json\.bak-\d{14}$/.test(entry.name))
      .map((entry) => `.kairon/config/${entry.name}`)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

function countStatuses(checks: DoctorCheck[]): Record<DoctorStatus, number> {
  return checks.reduce<Record<DoctorStatus, number>>(
    (counts, check) => {
      counts[check.status] += 1;
      return counts;
    },
    { pass: 0, warning: 0, error: 0 }
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function checkBetaReadiness(projectRoot: string): Promise<DoctorCheck> {
  const id = "readiness.status";
  const title = "Beta readiness gate";
  try {
    const report = await evaluateBetaReadiness(projectRoot);
    const details = [
      `status=${report.status}`,
      `ready=${report.ready}`,
      `manifest_status=${report.manifest.status}`,
      `pass=${report.counts.PASS}`,
      `unpassed=${report.counts.UNPASSED}`,
      `setup_required=${report.counts.SETUP_REQUIRED}`,
      `unknown=${report.counts.UNKNOWN}`
    ];
    return report.ready
      ? pass(id, title, details)
      : warning(
          id,
          title,
          details,
          "Refresh readiness evidence and run kairon readiness check."
        );
  } catch {
    return warning(
      id,
      title,
      ["status=UNKNOWN", "ready=false"],
      "Repair the readiness manifest and run kairon readiness check."
    );
  }
}

function pass(id: string, title: string, details: string[]): DoctorCheck {
  return { id, title, status: "pass", details };
}

function warning(
  id: string,
  title: string,
  details: string[],
  nextAction: string
): DoctorCheck {
  return { id, title, status: "warning", details, next_action: nextAction };
}

function error(
  id: string,
  title: string,
  details: string[],
  nextAction: string
): DoctorCheck {
  return { id, title, status: "error", details, next_action: nextAction };
}
