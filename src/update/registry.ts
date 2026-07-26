import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { resolveInside } from "../core/fs/paths.js";
import { parseCoreVersion } from "./channel.js";

export type VerifiedUpdateDownload = {
  schema_version: "0.1";
  artifact_kind: "verified_update_download";
  download_id: string;
  repository: string;
  release_id: number;
  release_channel: "stable" | "beta";
  version: string;
  tag: string;
  source_commit: string;
  package_sha256: string;
  package_size_bytes: number;
  cache_directory: string;
  package_path: string;
  checksum_manifest_path: string;
  release_manifest_path: string;
  sbom_path?: string;
  provenance_path?: string;
  downloaded_at: string;
};

export type InstalledUpdateVersion = {
  version: string;
  source: "current_runtime" | "verified_download";
  download_id?: string;
  package_path?: string;
  checksum_manifest_path?: string;
  release_manifest_path?: string;
  source_commit?: string;
  installed_at: string;
};

export type UpdateRegistryHistoryEntry = {
  action: "apply" | "rollback";
  from_version: string;
  to_version: string;
  download_id: string;
  status: "completed";
  completed_at: string;
};

export type UpdateRegistry = {
  schema_version: "0.1";
  installed: InstalledUpdateVersion;
  previous: InstalledUpdateVersion | null;
  last_successful_version: string;
  automatic_updates: false;
  history: UpdateRegistryHistoryEntry[];
  updated_at: string;
};

export type StableReleasePointer = {
  schema_version: "0.1";
  artifact_kind: "stable_release_pointer";
  repository: string;
  base_branch: string;
  version: string;
  tag: string;
  source_commit: string;
  release_id: number;
  promotion_plan_id: string;
  promotion_plan_digest: string;
  sbom_sha256: string;
  provenance_sha256: string;
  promoted_at: string;
};

export async function loadUpdateRegistry(
  projectRoot: string,
  currentVersion: string,
  now: () => Date = () => new Date()
): Promise<UpdateRegistry> {
  parseCoreVersion(currentVersion);
  const registryPath = updateRegistryPath(projectRoot);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(registryPath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const timestamp = now().toISOString();
      return {
        schema_version: "0.1",
        installed: {
          version: currentVersion,
          source: "current_runtime",
          installed_at: timestamp
        },
        previous: null,
        last_successful_version: currentVersion,
        automatic_updates: false,
        history: [],
        updated_at: timestamp
      };
    }
    throw new Error(`Failed to read update registry ${registryPath}.`);
  }
  if (!isUpdateRegistry(value)) {
    throw new Error(`Update registry is invalid: ${registryPath}`);
  }
  return value;
}

export async function recordSuccessfulUpdate(
  projectRoot: string,
  input: {
    action: "apply" | "rollback";
    currentVersion: string;
    download: VerifiedUpdateDownload;
    now?: () => Date;
  }
): Promise<UpdateRegistry> {
  const now = input.now ?? (() => new Date());
  const current = await loadUpdateRegistry(projectRoot, input.currentVersion, now);
  const timestamp = now().toISOString();
  const previous = current.installed.version === input.currentVersion
    ? current.installed
    : {
        version: input.currentVersion,
        source: "current_runtime" as const,
        installed_at: timestamp
      };
  const installed: InstalledUpdateVersion = {
    version: input.download.version,
    source: "verified_download",
    download_id: input.download.download_id,
    package_path: input.download.package_path,
    checksum_manifest_path: input.download.checksum_manifest_path,
    release_manifest_path: input.download.release_manifest_path,
    source_commit: input.download.source_commit,
    installed_at: timestamp
  };
  const next: UpdateRegistry = {
    schema_version: "0.1",
    installed,
    previous,
    last_successful_version: input.download.version,
    automatic_updates: false,
    history: [
      ...current.history,
      {
        action: input.action,
        from_version: input.currentVersion,
        to_version: input.download.version,
        download_id: input.download.download_id,
        status: "completed" as const,
        completed_at: timestamp
      }
    ].slice(-100),
    updated_at: timestamp
  };
  await writeJsonFileAtomic(updateRegistryPath(projectRoot), next);
  return next;
}

export async function readVerifiedUpdateDownload(
  projectRoot: string,
  downloadId: string
): Promise<VerifiedUpdateDownload> {
  if (!/^UPD-\d{4,}$/u.test(downloadId)) {
    throw new Error(`Invalid update download id: ${downloadId}`);
  }
  const filePath = updateDownloadMetadataPath(projectRoot, downloadId);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    throw new Error(`Verified update download was not found: ${downloadId}`);
  }
  if (!isVerifiedUpdateDownload(value) || value.download_id !== downloadId) {
    throw new Error(`Verified update download metadata is invalid: ${downloadId}`);
  }
  return value;
}

export async function findVerifiedUpdateDownloadByVersion(
  projectRoot: string,
  version: string
): Promise<VerifiedUpdateDownload> {
  parseCoreVersion(version);
  const directory = resolveInside(projectRoot, ".kairon", "update", "downloads");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`No verified update download is available for version ${version}.`);
    }
    throw error;
  }
  const downloads: VerifiedUpdateDownload[] = [];
  for (const name of names.filter((entry) => /^UPD-\d{4,}\.json$/u.test(entry))) {
    const downloadId = path.basename(name, ".json");
    try {
      const download = await readVerifiedUpdateDownload(projectRoot, downloadId);
      if (download.version === version) {
        downloads.push(download);
      }
    } catch {
      // Invalid unrelated metadata must not be selected as a rollback source.
    }
  }
  downloads.sort((left, right) => right.downloaded_at.localeCompare(left.downloaded_at));
  const selected = downloads[0];
  if (selected === undefined) {
    throw new Error(`No verified update download is available for version ${version}.`);
  }
  return selected;
}

export async function writeVerifiedUpdateDownload(
  projectRoot: string,
  download: VerifiedUpdateDownload
): Promise<string> {
  if (!isVerifiedUpdateDownload(download)) {
    throw new Error("Verified update download metadata is invalid.");
  }
  const filePath = updateDownloadMetadataPath(projectRoot, download.download_id);
  await writeJsonFileAtomic(filePath, download);
  return filePath;
}

export async function recordStableReleasePromotion(
  projectRoot: string,
  pointer: StableReleasePointer
): Promise<string> {
  if (!isStableReleasePointer(pointer)) {
    throw new Error("Stable release pointer is invalid.");
  }
  const filePath = stableReleasePointerPath(projectRoot);
  await writeJsonFileAtomic(filePath, pointer);
  return filePath;
}

export async function readStableReleasePromotion(
  projectRoot: string
): Promise<StableReleasePointer | null> {
  const filePath = stableReleasePointerPath(projectRoot);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new Error(`Failed to read stable release pointer ${filePath}.`);
  }
  if (!isStableReleasePointer(value)) {
    throw new Error(`Stable release pointer is invalid: ${filePath}`);
  }
  return value;
}

export function stableReleasePointerPath(projectRoot: string): string {
  return resolveInside(projectRoot, ".kairon", "update", "stable-release.json");
}

export function updateRegistryPath(projectRoot: string): string {
  return resolveInside(projectRoot, ".kairon", "update", "registry.json");
}

export function updateDownloadMetadataPath(
  projectRoot: string,
  downloadId: string
): string {
  return resolveInside(
    projectRoot,
    ".kairon",
    "update",
    "downloads",
    `${downloadId}.json`
  );
}

function isVerifiedUpdateDownload(value: unknown): value is VerifiedUpdateDownload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<VerifiedUpdateDownload>;
  return candidate.schema_version === "0.1" &&
    candidate.artifact_kind === "verified_update_download" &&
    typeof candidate.download_id === "string" &&
    /^UPD-\d{4,}$/u.test(candidate.download_id) &&
    typeof candidate.repository === "string" &&
    typeof candidate.release_id === "number" &&
    Number.isInteger(candidate.release_id) &&
    candidate.release_id > 0 &&
    (candidate.release_channel === "stable" || candidate.release_channel === "beta") &&
    typeof candidate.version === "string" &&
    isCoreVersion(candidate.version) &&
    candidate.tag === `v${candidate.version}` &&
    typeof candidate.source_commit === "string" &&
    /^[a-f0-9]{40,64}$/u.test(candidate.source_commit) &&
    typeof candidate.package_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.package_sha256) &&
    typeof candidate.package_size_bytes === "number" &&
    Number.isInteger(candidate.package_size_bytes) &&
    candidate.package_size_bytes >= 0 &&
    isAbsolutePath(candidate.cache_directory) &&
    isAbsolutePath(candidate.package_path) &&
    isAbsolutePath(candidate.checksum_manifest_path) &&
    isAbsolutePath(candidate.release_manifest_path) &&
    (candidate.sbom_path === undefined || isAbsolutePath(candidate.sbom_path)) &&
    (candidate.provenance_path === undefined || isAbsolutePath(candidate.provenance_path)) &&
    ((candidate.sbom_path === undefined) === (candidate.provenance_path === undefined)) &&
    typeof candidate.downloaded_at === "string" &&
    !Number.isNaN(Date.parse(candidate.downloaded_at));
}

function isStableReleasePointer(value: unknown): value is StableReleasePointer {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<StableReleasePointer>;
  return candidate.schema_version === "0.1" &&
    candidate.artifact_kind === "stable_release_pointer" &&
    typeof candidate.repository === "string" &&
    /^[^/\s]+\/[^/\s]+$/u.test(candidate.repository) &&
    typeof candidate.base_branch === "string" &&
    candidate.base_branch.length > 0 &&
    typeof candidate.version === "string" &&
    isCoreVersion(candidate.version) &&
    candidate.tag === `v${candidate.version}` &&
    typeof candidate.source_commit === "string" &&
    /^[a-f0-9]{40,64}$/u.test(candidate.source_commit) &&
    typeof candidate.release_id === "number" &&
    Number.isInteger(candidate.release_id) &&
    candidate.release_id > 0 &&
    typeof candidate.promotion_plan_id === "string" &&
    /^REL-\d{4,}$/u.test(candidate.promotion_plan_id) &&
    typeof candidate.promotion_plan_digest === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(candidate.promotion_plan_digest) &&
    typeof candidate.sbom_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.sbom_sha256) &&
    typeof candidate.provenance_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.provenance_sha256) &&
    typeof candidate.promoted_at === "string" &&
    !Number.isNaN(Date.parse(candidate.promoted_at));
}

function isUpdateRegistry(value: unknown): value is UpdateRegistry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<UpdateRegistry>;
  return candidate.schema_version === "0.1" &&
    isInstalledVersion(candidate.installed) &&
    (candidate.previous === null || isInstalledVersion(candidate.previous)) &&
    typeof candidate.last_successful_version === "string" &&
    isCoreVersion(candidate.last_successful_version) &&
    candidate.automatic_updates === false &&
    Array.isArray(candidate.history) &&
    candidate.history.every(isHistoryEntry) &&
    typeof candidate.updated_at === "string" &&
    !Number.isNaN(Date.parse(candidate.updated_at));
}

function isInstalledVersion(value: unknown): value is InstalledUpdateVersion {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<InstalledUpdateVersion>;
  return typeof candidate.version === "string" &&
    isCoreVersion(candidate.version) &&
    (candidate.source === "current_runtime" || candidate.source === "verified_download") &&
    typeof candidate.installed_at === "string" &&
    !Number.isNaN(Date.parse(candidate.installed_at));
}

function isHistoryEntry(value: unknown): value is UpdateRegistryHistoryEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<UpdateRegistryHistoryEntry>;
  return (candidate.action === "apply" || candidate.action === "rollback") &&
    typeof candidate.from_version === "string" &&
    isCoreVersion(candidate.from_version) &&
    typeof candidate.to_version === "string" &&
    isCoreVersion(candidate.to_version) &&
    typeof candidate.download_id === "string" &&
    candidate.status === "completed" &&
    typeof candidate.completed_at === "string" &&
    !Number.isNaN(Date.parse(candidate.completed_at));
}

function isCoreVersion(value: string): boolean {
  try {
    parseCoreVersion(value);
    return true;
  } catch {
    return false;
  }
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value);
}
