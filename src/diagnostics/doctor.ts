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
    };
  };
};

type PoliciesConfig = {
  git?: {
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
  checks.push(await checkDiscordConfig(options.projectRoot, env));
  checks.push(await checkGitPolicy(options.projectRoot));
  checks.push(await checkGitHubBranchProtection(options.projectRoot, env));
  checks.push(await checkConfigBackups(options.projectRoot));

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
  env: NodeJS.ProcessEnv
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
  const present = envNames.filter((name) => hasEnvValue(env, name));
  const missing = envNames.filter((name) => !hasEnvValue(env, name));
  const gatewayMissing = gatewayEnvNames.filter((name) => !hasEnvValue(env, name));
  const liveReady = discord.enabled === true && missing.length === 0;
  const details = [
    `enabled=${discord.enabled === true}`,
    `mode=${discord.mode ?? "unknown"}`,
    `gateway_status=${gatewayMissing.length === 0 ? "ready" : "setup_required"}`,
    `live_status=${liveReady ? "ready" : "setup_required"}`,
    `live_missing_env=${missing.length === 0 ? "none" : missing.join(",")}`,
    ...envNames.map((name) => `${name}=${hasEnvValue(env, name) ? "present" : "missing"}`)
  ];

  if (discord.enabled === true && gatewayMissing.length > 0) {
    return error(
      "discord.config",
      "Discord notification config",
      details,
      `Set missing Discord gateway env vars: ${gatewayMissing.join(", ")}.`
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
  env: NodeJS.ProcessEnv
): Promise<DoctorCheck> {
  const remote = await readGitHubRemote(projectRoot);

  if (remote === undefined) {
    return pass("git.branch_protection", "GitHub branch protection", [
      "skipped: no GitHub remote configured"
    ]);
  }

  const authPresent = env.GITHUB_TOKEN !== undefined || env.GH_TOKEN !== undefined;
  const details = [
    `remote=${remote.name}`,
    `url=${remote.url}`,
    `auth=${authPresent ? "present" : "missing"}`,
    "network_check=skipped"
  ];

  if (!authPresent) {
    return warning(
      "git.branch_protection",
      "GitHub branch protection",
      details,
      "Set GH_TOKEN or GITHUB_TOKEN, then verify branch protection with GitHub before unattended protected branch operations."
    );
  }

  return warning(
    "git.branch_protection",
    "GitHub branch protection",
    details,
    "Branch protection API verification is not available in local doctor yet; verify GitHub settings before protected branch operations."
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

async function readGitHubRemote(
  projectRoot: string
): Promise<{ name: string; url: string } | undefined> {
  try {
    const config = await readFile(resolveInside(projectRoot, ".git", "config"), "utf8");
    const remotes = parseGitRemotes(config);
    return remotes.find((remote) => /github\.com[:/]/i.test(remote.url));
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
