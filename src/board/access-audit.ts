import path from "node:path";
import { appendJsonLine } from "../core/fs/jsonl-file.js";
import { getKaironPaths } from "../core/fs/paths.js";

export type BoardAccessAuditRoute = "index" | "projection" | "unknown";

export type BoardAccessAuditAuthStatus =
  | "not_required"
  | "not_evaluated"
  | "accepted"
  | "missing_token"
  | "invalid_token"
  | "expired_token"
  | "scope_mismatch";

export type BoardAccessAuditRecord = {
  schema_version: "0.1";
  outcome: "allowed" | "denied" | "error";
  method: string;
  route: BoardAccessAuditRoute;
  http_status: number;
  auth_status: BoardAccessAuditAuthStatus;
  client: "loopback";
  user_agent_present: boolean;
  recorded_at: string;
};

export async function auditBoardAccess(
  projectRoot: string,
  input: Omit<BoardAccessAuditRecord, "schema_version" | "client">
): Promise<void> {
  await appendJsonLine(boardAccessAuditPath(projectRoot), {
    schema_version: "0.1",
    client: "loopback",
    ...input
  } satisfies BoardAccessAuditRecord);
}

export function boardAccessAuditPath(projectRoot: string): string {
  return path.join(getKaironPaths(projectRoot).runtimeDir, "board", "access.jsonl");
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
