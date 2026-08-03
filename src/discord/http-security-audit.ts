import { createHash } from "node:crypto";
import path from "node:path";
import { appendJsonLine } from "../core/fs/jsonl-file.js";
import { getKaironPaths } from "../core/fs/paths.js";

export type DiscordHttpSecurityRejectReason =
  | "method_not_allowed"
  | "missing_signature_headers"
  | "invalid_signature_timestamp"
  | "signature_timestamp_out_of_range"
  | "invalid_request_signature"
  | "replayed_request"
  | "invalid_json_body";

export type DiscordHttpSecurityAuditRecord = {
  schema_version: "0.1";
  status: "rejected";
  reason: DiscordHttpSecurityRejectReason;
  method: string;
  request_hash: string;
  recorded_at: string;
};

export async function auditDiscordHttpSecurityRejection(
  projectRoot: string,
  input: {
    reason: DiscordHttpSecurityRejectReason;
    method: string;
    timestamp?: string;
    body: string | Buffer;
    recordedAt: Date;
  }
): Promise<void> {
  await appendJsonLine(discordHttpSecurityAuditPath(projectRoot), {
    schema_version: "0.1",
    status: "rejected",
    reason: input.reason,
    method: input.method,
    request_hash: createRequestHash(input.timestamp, input.body),
    recorded_at: input.recordedAt.toISOString()
  } satisfies DiscordHttpSecurityAuditRecord);
}

export function discordHttpSecurityAuditPath(projectRoot: string): string {
  return path.join(
    getKaironPaths(projectRoot).runtimeDir,
    "discord",
    "http-security.jsonl"
  );
}

function createRequestHash(
  timestamp: string | undefined,
  body: string | Buffer
): string {
  return createHash("sha256")
    .update(timestamp ?? "")
    .update("\0")
    .update(Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8"))
    .digest("hex")
    .slice(0, 16);
}
