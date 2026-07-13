import { randomBytes } from "node:crypto";
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

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}
