import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { resolveInside } from "../core/fs/paths.js";
import type { GitHubReleaseRecord } from "../github/release-client.js";

export type UpdateChannel = "stable" | "beta" | "pinned";

export type UpdateChannelConfig = {
  schema_version: "0.1";
  channel: UpdateChannel;
  repository: string;
  base_branch: string;
  pinned_version?: string;
  automatic_updates: false;
  updated_at: string;
};

export type UpdateChannelView = {
  schema_version: "0.1";
  status: "configured" | "unconfigured";
  config_path: string;
  config: UpdateChannelConfig | null;
};

export type SetUpdateChannelOptions = {
  channel: string;
  repository?: string;
  baseBranch?: string;
  version?: string;
  write?: boolean;
  dryRun?: boolean;
  confirm?: string;
  now?: () => Date;
};

export type UpdateChannelSetResult = {
  schema_version: "0.1";
  status: "would_update" | "updated" | "unchanged";
  dry_run: boolean;
  confirmation: string;
  previous: UpdateChannelConfig | null;
  next: UpdateChannelConfig;
  config_path: string;
};

export async function showUpdateChannel(
  projectRoot: string
): Promise<UpdateChannelView> {
  const configPath = updateChannelConfigPath(projectRoot);
  const config = await readOptionalUpdateChannel(configPath);
  return {
    schema_version: "0.1",
    status: config === null ? "unconfigured" : "configured",
    config_path: configPath,
    config
  };
}

export async function setUpdateChannel(
  projectRoot: string,
  options: SetUpdateChannelOptions
): Promise<UpdateChannelSetResult> {
  const channel = parseUpdateChannel(options.channel);
  const configPath = updateChannelConfigPath(projectRoot);
  const previous = await readOptionalUpdateChannel(configPath);
  const repository = normalizeRepository(options.repository ?? previous?.repository);
  const baseBranch = normalizeBranch(options.baseBranch ?? previous?.base_branch ?? "main");
  const pinnedVersion = channel === "pinned"
    ? normalizeVersion(options.version ?? previous?.pinned_version)
    : undefined;
  if (channel !== "pinned" && options.version !== undefined) {
    throw new Error("--version is only valid for the pinned update channel.");
  }

  const next: UpdateChannelConfig = {
    schema_version: "0.1",
    channel,
    repository,
    base_branch: baseBranch,
    ...(pinnedVersion === undefined ? {} : { pinned_version: pinnedVersion }),
    automatic_updates: false,
    updated_at: (options.now?.() ?? new Date()).toISOString()
  };
  const write = options.write === true;
  if (write && options.dryRun === true) {
    throw new Error("Use either --write or --dry-run, not both.");
  }
  const confirmation = updateChannelConfirmation(channel, pinnedVersion);
  const unchanged = previous !== null && sameChannelConfig(previous, next);
  if (write && !unchanged && options.confirm !== confirmation) {
    throw new Error(`Update channel change requires --confirm ${confirmation}.`);
  }
  if (write && !unchanged) {
    await writeJsonFileAtomic(configPath, next);
  }

  return {
    schema_version: "0.1",
    status: unchanged ? "unchanged" : write ? "updated" : "would_update",
    dry_run: !write,
    confirmation,
    previous,
    next: unchanged && previous !== null ? previous : next,
    config_path: configPath
  };
}

export async function requireUpdateChannel(
  projectRoot: string
): Promise<UpdateChannelConfig> {
  const view = await showUpdateChannel(projectRoot);
  if (view.config === null) {
    throw new Error(
      "Update channel is not configured. Use kairon update channel set before checking releases."
    );
  }
  return view.config;
}

export function isVersionAllowedByChannel(
  config: UpdateChannelConfig,
  version: string,
  prerelease: boolean
): boolean {
  normalizeVersion(version);
  if (config.channel === "stable") {
    return !prerelease;
  }
  if (config.channel === "beta") {
    return true;
  }
  return version === config.pinned_version;
}

export function selectReleaseForChannel(
  config: UpdateChannelConfig,
  releases: GitHubReleaseRecord[],
  requestedVersion?: string
): { release: GitHubReleaseRecord; version: string } | undefined {
  const requested = requestedVersion === undefined
    ? undefined
    : normalizeVersion(requestedVersion);
  return releases
    .filter((release) => !release.draft)
    .map((release) => ({
      release,
      version: versionFromTag(release.tag_name)
    }))
    .filter((entry): entry is { release: GitHubReleaseRecord; version: string } =>
      entry.version !== undefined &&
      isVersionAllowedByChannel(config, entry.version, entry.release.prerelease) &&
      (requested === undefined || entry.version === requested)
    )
    .sort((left, right) => compareCoreVersions(right.version, left.version))[0];
}

export function updateChannelConfirmation(
  channel: UpdateChannel,
  pinnedVersion?: string
): string {
  return channel === "pinned" ? `pinned@${pinnedVersion ?? ""}` : channel;
}

export function parseCoreVersion(value: string): [number, number, number] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value.trim());
  if (match === null) {
    throw new Error(`Unsupported update version: ${value}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareCoreVersions(left: string, right: string): number {
  const leftParts = parseCoreVersion(left);
  const rightParts = parseCoreVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function formatUpdateChannelView(result: UpdateChannelView): string {
  return [
    "Kairon update channel:",
    `status=${result.status}`,
    `config_path=${result.config_path}`,
    `channel=${result.config?.channel ?? "none"}`,
    `repository=${result.config?.repository ?? "none"}`,
    `base_branch=${result.config?.base_branch ?? "none"}`,
    `pinned_version=${result.config?.pinned_version ?? "none"}`,
    "automatic_updates=false"
  ].join("\n");
}

export function formatUpdateChannelSet(result: UpdateChannelSetResult): string {
  return [
    result.dry_run
      ? "Kairon update channel dry run."
      : "Kairon update channel updated.",
    `status=${result.status}`,
    `dry_run=${result.dry_run}`,
    `channel=${result.next.channel}`,
    `repository=${result.next.repository}`,
    `base_branch=${result.next.base_branch}`,
    `pinned_version=${result.next.pinned_version ?? "none"}`,
    `confirm=${result.confirmation}`,
    "automatic_updates=false"
  ].join("\n");
}

function updateChannelConfigPath(projectRoot: string): string {
  return resolveInside(projectRoot, ".kairon", "update", "channel.json");
}

async function readOptionalUpdateChannel(
  configPath: string
): Promise<UpdateChannelConfig | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new Error(`Failed to read update channel config ${configPath}.`);
  }
  if (!isUpdateChannelConfig(value)) {
    throw new Error(`Update channel config is invalid: ${configPath}`);
  }
  return value;
}

function isUpdateChannelConfig(value: unknown): value is UpdateChannelConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<UpdateChannelConfig>;
  return candidate.schema_version === "0.1" &&
    (candidate.channel === "stable" || candidate.channel === "beta" || candidate.channel === "pinned") &&
    typeof candidate.repository === "string" &&
    /^[^/\s]+\/[^/\s]+$/u.test(candidate.repository) &&
    typeof candidate.base_branch === "string" &&
    candidate.base_branch.length > 0 &&
    candidate.automatic_updates === false &&
    typeof candidate.updated_at === "string" &&
    !Number.isNaN(Date.parse(candidate.updated_at)) &&
    (candidate.channel !== "pinned" || (
      typeof candidate.pinned_version === "string" &&
      isCoreVersion(candidate.pinned_version)
    ));
}

function sameChannelConfig(
  previous: UpdateChannelConfig,
  next: UpdateChannelConfig
): boolean {
  return previous.channel === next.channel &&
    previous.repository === next.repository &&
    previous.base_branch === next.base_branch &&
    previous.pinned_version === next.pinned_version &&
    previous.automatic_updates === false;
}

function parseUpdateChannel(value: string): UpdateChannel {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "stable" && normalized !== "beta" && normalized !== "pinned") {
    throw new Error(`Unsupported update channel: ${value}`);
  }
  return normalized;
}

function normalizeRepository(value: string | undefined): string {
  const repository = value?.trim();
  if (repository === undefined || !/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
    throw new Error("Update channel requires --repository <owner/repo>.");
  }
  return repository;
}

function normalizeBranch(value: string): string {
  const branch = value.trim();
  if (branch.length === 0 || branch.includes("..") || path.isAbsolute(branch)) {
    throw new Error(`Invalid update base branch: ${value}`);
  }
  return branch;
}

function normalizeVersion(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("Pinned update channel requires --version <semver>.");
  }
  const version = value.trim();
  parseCoreVersion(version);
  return version;
}

function isCoreVersion(value: string): boolean {
  try {
    parseCoreVersion(value);
    return true;
  } catch {
    return false;
  }
}

function versionFromTag(tag: string): string | undefined {
  const match = /^v(.+)$/u.exec(tag.trim());
  if (match === null || !isCoreVersion(match[1])) {
    return undefined;
  }
  return match[1];
}
