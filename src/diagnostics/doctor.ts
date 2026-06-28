import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { defaultAgentAdapters } from "../agents/adapters/index.js";
import { agentDisplayName } from "../agents/display.js";
import {
  isCommandAvailable,
  type CommandAvailabilityChecker
} from "../agents/session-host.js";
import { agentIds } from "../agents/types.js";
import { loadConfigFile, validateAllConfigs } from "../core/config/load-config.js";
import { getKaironPaths, resolveInside } from "../core/fs/paths.js";
import {
  resolveSecret,
  type ResolvedSecret,
  type SecretReference,
  type SecretResolver
} from "../core/secrets/secret-resolver.js";
import { validateDiscordEnvValues } from "../discord/env-validation.js";
import { inspectRuntimeRecoveryTargets } from "../recovery/runtime-recovery.js";

export type DoctorStatus = "pass" | "warning" | "error";

export type DoctorCheck = {
  id: string;
  title: string;
  status: DoctorStatus;
  details: string[];
  nextAction?: string;
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
  providers?: {
    discord?: {
      enabled?: boolean;
      mode?: string;
      bot_token_env?: string;
      application_id_env?: string;
      guild_id_env?: string;
      approval_channel_id_env?: string;
      owner_user_id_env?: string;
      allowed_user_ids_env?: string;
      secrets?: Partial<Record<DiscordSecretKey, SecretReferenceConfig>>;
    };
  };
};

type DiscordSecretKey =
  | "bot_token"
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
  checks.push(await checkConfigBackups(options.projectRoot));
  checks.push(await checkRuntimeRecovery(options.projectRoot));

  const summary = countStatuses(checks);

  return {
    ok: summary.error === 0,
    checks,
    summary
  };
}

export function formatDoctorResult(result: DoctorResult): string {
  const lines = [
    `doctor.ok=${result.ok}`,
    `summary.pass=${result.summary.pass}`,
    `summary.warning=${result.summary.warning}`,
    `summary.error=${result.summary.error}`
  ];

  for (const check of result.checks) {
    lines.push(`${check.status.toUpperCase()} ${check.id} ${check.title}`);
    for (const detail of check.details) {
      lines.push(`  - ${detail}`);
    }
    if (check.nextAction !== undefined) {
      lines.push(`  next=${check.nextAction}`);
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
      "Review .kairon/config/notifications.json."
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
  const gatewayReady = gatewayMissing.length === 0 && gatewayInvalid.length === 0;
  const liveReady =
    discord.enabled === true && missing.length === 0 && liveInvalid.length === 0;
  const details = [
    `enabled=${discord.enabled === true}`,
    `mode=${discord.mode ?? "unknown"}`,
    `gateway_status=${gatewayReady ? "ready" : "setup_required"}`,
    `live_status=${liveReady ? "ready" : "setup_required"}`,
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
      `Set missing Discord gateway env vars: ${gatewayMissing.join(", ")}.`
    );
  }

  if (discord.enabled === true && gatewayInvalid.length > 0) {
    return error(
      "discord.config",
      "Discord notification config",
      details,
      `Fix invalid Discord gateway env vars: ${gatewayInvalid.join(", ")}.`
    );
  }

  if (discord.enabled === true && missing.length > 0) {
    return warning(
      "discord.config",
      "Discord notification config",
      details,
      `Set missing Discord live env vars: ${missing.join(", ")}.`
    );
  }

  if (discord.enabled === true && liveInvalid.length > 0) {
    return warning(
      "discord.config",
      "Discord notification config",
      details,
      `Fix invalid Discord live env vars: ${liveInvalid.join(", ")}.`
    );
  }

  if (discord.enabled !== true && present.length > 0) {
    return warning(
      "discord.config",
      "Discord notification config",
      details,
      "Discord env vars are present but provider is disabled."
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
        "network_check=skipped"
      ],
      "Use a supported GitHub remote URL format before relying on branch protection diagnostics."
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
      [...details, "network_check=skipped"],
      "Set GH_TOKEN or GITHUB_TOKEN, or configure KAIRON_GH_TOKEN_CREDENTIAL_TARGET / KAIRON_GITHUB_TOKEN_CREDENTIAL_TARGET, then verify branch protection with GitHub before unattended protected branch operations."
    );
  }

  const apiResult = await client({
    owner: repository.owner,
    repo: repository.repo,
    branch,
    token: token.value
  });
  const apiDetails = [...details, "network_check=completed", ...formatGitHubApiDetails(apiResult)];

  if (apiResult.kind === "protected") {
    const missingProtections = [
      apiResult.requiredPullRequestReviews ? undefined : "required_pull_request_reviews",
      apiResult.requiredStatusChecks ? undefined : "required_status_checks"
    ].filter((value): value is string => value !== undefined);

    if (missingProtections.length === 0) {
      return pass("git.branch_protection", "GitHub branch protection", apiDetails);
    }

    return warning(
      "git.branch_protection",
      "GitHub branch protection",
      apiDetails,
      `Enable GitHub branch protection gates: ${missingProtections.join(", ")}.`
    );
  }

  if (apiResult.kind === "auth_error") {
    return warning(
      "git.branch_protection",
      "GitHub branch protection",
      apiDetails,
      "Check GH_TOKEN or GITHUB_TOKEN authentication, then retry GitHub branch protection verification."
    );
  }

  if (apiResult.kind === "plan_or_permission_error") {
    return warning(
      "git.branch_protection",
      "GitHub branch protection",
      apiDetails,
      "GitHub returned 403. Check token repository access and Administration read permission; for private repositories on plans that do not expose branch protection enforcement, verify live access with a public sandbox repository."
    );
  }

  if (apiResult.kind === "not_found") {
    return warning(
      "git.branch_protection",
      "GitHub branch protection",
      apiDetails,
      "Enable branch protection for the default branch, verify repository/branch access, or run the public sandbox branch protection check."
    );
  }

  return warning(
    "git.branch_protection",
    "GitHub branch protection",
    apiDetails,
    "Retry GitHub branch protection verification after network or GitHub API access is healthy."
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

function formatGitHubApiDetails(result: GitHubBranchProtectionResult): string[] {
  if (result.kind === "protected") {
    return [
      "api_status=ok",
      "branch_protection=enabled",
      `required_pull_request_reviews=${result.requiredPullRequestReviews ? "present" : "missing"}`,
      `required_status_checks=${result.requiredStatusChecks ? "present" : "missing"}`,
      `enforce_admins=${String(result.enforceAdmins)}`
    ];
  }

  if (result.kind === "not_found") {
    return [
      "api_status=not_found_or_unprotected",
      `http_status=${result.httpStatus}`
    ];
  }

  if (result.kind === "auth_error") {
    return ["api_status=auth_error", `http_status=${result.httpStatus}`];
  }

  if (result.kind === "plan_or_permission_error") {
    return ["api_status=plan_or_permission_error", `http_status=${result.httpStatus}`];
  }

  if (result.kind === "api_error") {
    return ["api_status=api_error", `http_status=${result.httpStatus}`];
  }

  return ["api_status=network_error"];
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
  required_status_checks?: unknown | null;
  enforce_admins?: {
    enabled?: boolean;
  } | null;
};

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

function pass(id: string, title: string, details: string[]): DoctorCheck {
  return { id, title, status: "pass", details };
}

function warning(
  id: string,
  title: string,
  details: string[],
  nextAction: string
): DoctorCheck {
  return { id, title, status: "warning", details, nextAction };
}

function error(
  id: string,
  title: string,
  details: string[],
  nextAction: string
): DoctorCheck {
  return { id, title, status: "error", details, nextAction };
}
