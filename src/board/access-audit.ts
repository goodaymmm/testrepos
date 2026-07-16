import path from "node:path";
import { createHash } from "node:crypto";
import { appendJsonLine } from "../core/fs/jsonl-file.js";
import { getKaironPaths } from "../core/fs/paths.js";
import type { BoardProfile } from "./profile.js";

export type BoardAccessAuditRoute = "index" | "projection" | "unknown";

export type BoardAccessAuditAuthStatus =
  | "not_required"
  | "not_evaluated"
  | "accepted"
  | "missing_token"
  | "invalid_token"
  | "expired_token"
  | "scope_mismatch"
  | "revoked_token";

export type BoardAccessAuditProxyStatus =
  | "not_required"
  | "not_evaluated"
  | "accepted"
  | "forwarded_headers_required"
  | "untrusted_proxy"
  | "invalid_forwarded_headers";

export type BoardAccessAuditOriginStatus =
  | "not_required"
  | "not_evaluated"
  | "accepted"
  | "missing_origin"
  | "origin_not_allowed";

export type BoardAccessAuditRecord = {
  schema_version: "0.1";
  outcome: "allowed" | "denied" | "error";
  method: string;
  route: BoardAccessAuditRoute;
  http_status: number;
  auth_status: BoardAccessAuditAuthStatus;
  profile: BoardProfile;
  client: "loopback" | "remote";
  access_id?: string;
  identity_hash?: string;
  proxy_status?: BoardAccessAuditProxyStatus;
  origin_status?: BoardAccessAuditOriginStatus;
  rate_limited?: boolean;
  user_agent_present: boolean;
  recorded_at: string;
};

export async function auditBoardAccess(
  projectRoot: string,
  input: Omit<BoardAccessAuditRecord, "schema_version" | "client" | "profile">,
  profile: BoardProfile = "loopback"
): Promise<void> {
  await appendJsonLine(boardAccessAuditPath(projectRoot, profile), {
    schema_version: "0.1",
    profile,
    client: profile === "remote-readonly" ? "remote" : "loopback",
    ...input
  } satisfies BoardAccessAuditRecord);
}

export function boardAccessAuditPath(
  projectRoot: string,
  profile: BoardProfile = "loopback"
): string {
  return profile === "remote-readonly"
    ? path.join(getKaironPaths(projectRoot).kaironDir, "audit", "board-access.jsonl")
    : path.join(getKaironPaths(projectRoot).runtimeDir, "board", "access.jsonl");
}

export function hashBoardIdentity(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

export function classifyBoardAccessRoute(pathname: string): BoardAccessAuditRoute {
  if (pathname === "/" || pathname === "/index.html") {
    return "index";
  }
  if (pathname === "/projection.json") {
    return "projection";
  }
  return "unknown";
}
