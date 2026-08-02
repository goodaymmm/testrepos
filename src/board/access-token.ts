import { randomBytes, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, toPosixPath } from "../core/fs/paths.js";
import {
  hashSecretForArtifact,
  secretMatchesArtifactHash
} from "../core/secrets/secret-resolver.js";

export const boardReadScope = "board.read" as const;
export const defaultBoardAccessTokenTtlSeconds = 900;
const maxBoardAccessTokenTtlSeconds = 86_400;

export type BoardAccessTokenMetadata = {
  token_hash: string;
  expires_at: string;
  scope: string;
};

export type IssuedBoardAccessToken = {
  token: string;
  metadata: BoardAccessTokenMetadata;
};

export type BoardAccessTokenValidation =
  | { accepted: true }
  | {
      accepted: false;
      reason: "missing_token" | "invalid_token" | "expired_token" | "scope_mismatch";
    };

export type BoardAccessRecord = BoardAccessTokenMetadata & {
  schema_version: "0.1";
  access_id: string;
  status: "active" | "revoked";
  issued_at: string;
  revoked_at?: string;
};

export type IssuedPersistentBoardAccess = {
  access_id: string;
  access_token: string;
  expires_at: string;
  scope: typeof boardReadScope;
  artifact_path: string;
};

export type PersistentBoardAccessValidation = BoardAccessTokenValidation & {
  access_id?: string;
};

export function issueBoardAccessToken(input: {
  now: Date;
  ttlSeconds?: number;
  scope?: string;
  randomToken?: () => string;
}): IssuedBoardAccessToken {
  const ttlSeconds = input.ttlSeconds ?? defaultBoardAccessTokenTtlSeconds;
  assertPositiveInteger(ttlSeconds, "Board access token TTL");
  if (ttlSeconds > maxBoardAccessTokenTtlSeconds) {
    throw new Error("Board access token TTL must not exceed 86400 seconds.");
  }
  const token = input.randomToken?.() ?? randomBytes(32).toString("base64url");
  if (token.length < 32 || token.trim() !== token || /\s/.test(token)) {
    throw new Error("Board access token generator returned an unsafe token.");
  }

  return {
    token,
    metadata: {
      token_hash: hashSecretForArtifact(token),
      expires_at: new Date(input.now.getTime() + ttlSeconds * 1000).toISOString(),
      scope: input.scope ?? boardReadScope
    }
  };
}

export function validateBoardAccessToken(input: {
  token: string | undefined;
  metadata: BoardAccessTokenMetadata;
  now: Date;
  requiredScope?: string;
}): BoardAccessTokenValidation {
  if (input.token === undefined || input.token.length === 0) {
    return { accepted: false, reason: "missing_token" };
  }

  if (!secretMatchesArtifactHash(input.token, input.metadata.token_hash)) {
    return { accepted: false, reason: "invalid_token" };
  }

  const expiresAt = Date.parse(input.metadata.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= input.now.getTime()) {
    return { accepted: false, reason: "expired_token" };
  }

  if (input.metadata.scope !== (input.requiredScope ?? boardReadScope)) {
    return { accepted: false, reason: "scope_mismatch" };
  }

  return { accepted: true };
}

export async function issuePersistentBoardAccess(
  projectRoot: string,
  input: {
    now?: Date;
    ttlMinutes?: number;
    randomToken?: () => string;
    accessId?: string;
  } = {}
): Promise<IssuedPersistentBoardAccess> {
  const now = input.now ?? new Date();
  const ttlMinutes = input.ttlMinutes ?? 15;
  assertPositiveInteger(ttlMinutes, "Board access token TTL minutes");
  if (ttlMinutes > 1_440) {
    throw new Error("Board access token TTL must not exceed 1440 minutes.");
  }
  const accessId = input.accessId ?? `BOARD-ACCESS-${randomUUID()}`;
  assertSafeAccessId(accessId);
  const issued = issueBoardAccessToken({
    now,
    ttlSeconds: ttlMinutes * 60,
    scope: boardReadScope,
    randomToken: input.randomToken
  });
  const record: BoardAccessRecord = {
    schema_version: "0.1",
    access_id: accessId,
    status: "active",
    issued_at: now.toISOString(),
    ...issued.metadata
  };
  const artifactPath = boardAccessRecordPath(projectRoot, accessId);
  await writeJsonFileAtomic(artifactPath, record);
  return {
    access_id: accessId,
    access_token: issued.token,
    expires_at: issued.metadata.expires_at,
    scope: boardReadScope,
    artifact_path: toProjectPath(projectRoot, artifactPath)
  };
}

export async function revokePersistentBoardAccess(
  projectRoot: string,
  accessId: string,
  now: Date = new Date()
): Promise<BoardAccessRecord> {
  const artifactPath = boardAccessRecordPath(projectRoot, accessId);
  const record = await readJsonFile<BoardAccessRecord>(artifactPath);
  if (record.access_id !== accessId || record.scope !== boardReadScope) {
    throw new Error(`Invalid Board access record: ${accessId}`);
  }
  const revoked: BoardAccessRecord = {
    ...record,
    status: "revoked",
    revoked_at: record.revoked_at ?? now.toISOString()
  };
  await writeJsonFileAtomic(artifactPath, revoked);
  return revoked;
}

export async function validatePersistentBoardAccess(input: {
  projectRoot: string;
  token: string | undefined;
  now: Date;
}): Promise<PersistentBoardAccessValidation> {
  if (input.token === undefined || input.token.length === 0) {
    return { accepted: false, reason: "missing_token" };
  }
  const records = await listBoardAccessRecords(input.projectRoot);
  let expiredAccessId: string | undefined;
  for (const record of records) {
    if (!secretMatchesArtifactHash(input.token, record.token_hash)) {
      continue;
    }
    if (record.status !== "active") {
      return { accepted: false, reason: "invalid_token", access_id: record.access_id };
    }
    const validation = validateBoardAccessToken({
      token: input.token,
      metadata: record,
      now: input.now,
      requiredScope: boardReadScope
    });
    if (validation.accepted) {
      return { accepted: true, access_id: record.access_id };
    }
    if (validation.reason === "expired_token") {
      expiredAccessId = record.access_id;
    } else {
      return { ...validation, access_id: record.access_id };
    }
  }
  return expiredAccessId === undefined
    ? { accepted: false, reason: "invalid_token" }
    : { accepted: false, reason: "expired_token", access_id: expiredAccessId };
}

export async function listBoardAccessRecords(
  projectRoot: string
): Promise<BoardAccessRecord[]> {
  const directory = boardAccessDirectory(projectRoot);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const records: BoardAccessRecord[] = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    const record = await readJsonFile<BoardAccessRecord>(path.join(directory, name));
    records.push(record);
  }
  return records;
}

export function boardAccessRecordPath(projectRoot: string, accessId: string): string {
  assertSafeAccessId(accessId);
  return path.join(boardAccessDirectory(projectRoot), `${accessId}.json`);
}

function boardAccessDirectory(projectRoot: string): string {
  return path.join(getKaironPaths(projectRoot).runtimeDir, "board", "access");
}

function assertSafeAccessId(value: string): void {
  if (!/^BOARD-ACCESS-[A-Za-z0-9-]{8,80}$/.test(value)) {
    throw new Error(`Invalid Board access id: ${value}`);
  }
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}
