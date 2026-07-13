import {
  createHash,
  createPublicKey,
  verify as verifySignature
} from "node:crypto";
import {
  normalizeDiscordApprovalInteraction,
  normalizeDiscordLeaveCommand,
  normalizeDiscordStatusCommand,
  type DiscordInteractionInput,
  type NormalizedDiscordCommand
} from "./interactions.js";
import type { PreparedDiscordGateway } from "./gateway.js";
import {
  auditDiscordHttpSecurityRejection,
  type DiscordHttpSecurityRejectReason
} from "./http-security-audit.js";

export type DiscordHttpInteractionRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body: string | Buffer;
};

export type DiscordHttpInteractionResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type DiscordHttpInteractionHandlerOptions = {
  projectRoot: string;
  gateway: PreparedDiscordGateway;
  publicKey: string;
  now?: () => Date;
  timestampToleranceSeconds?: number;
  replayGuard?: DiscordHttpReplayGuard;
};

export class DiscordHttpReplayGuard {
  readonly #entries = new Map<string, number>();
  readonly #ttlMilliseconds: number;

  constructor(ttlSeconds = defaultDiscordReplayTtlSeconds) {
    assertPositiveInteger(ttlSeconds, "Discord replay TTL");
    this.#ttlMilliseconds = ttlSeconds * 1000;
  }

  claim(input: {
    signature: string;
    timestamp: string;
    body: string | Buffer;
    now: Date;
  }): boolean {
    const nowMilliseconds = input.now.getTime();
    this.#removeExpired(nowMilliseconds);
    const key = replayKey(input);
    const expiresAt = this.#entries.get(key);

    if (expiresAt !== undefined && expiresAt > nowMilliseconds) {
      return false;
    }

    this.#entries.set(key, nowMilliseconds + this.#ttlMilliseconds);
    return true;
  }

  #removeExpired(nowMilliseconds: number): void {
    for (const [key, expiresAt] of this.#entries) {
      if (expiresAt <= nowMilliseconds) {
        this.#entries.delete(key);
      }
    }
  }
}

type DiscordInteractionPayload = {
  id?: unknown;
  type?: unknown;
  guild_id?: unknown;
  channel_id?: unknown;
  user?: unknown;
  member?: unknown;
  message?: unknown;
  data?: unknown;
};

const discordEd25519SpkiPrefix = Buffer.from(
  "302a300506032b6570032100",
  "hex"
);

const jsonHeaders = {
  "content-type": "application/json"
};

const interactionCallback = {
  pong: 1,
  channelMessageWithSource: 4
} as const;

export const defaultDiscordTimestampToleranceSeconds = 300;
export const defaultDiscordReplayTtlSeconds = 300;

export function verifyDiscordHttpInteractionSignature(input: {
  publicKey: string;
  signature: string;
  timestamp: string;
  body: string | Buffer;
}): boolean {
  try {
    const publicKeyBytes = parseHex(input.publicKey, 32);
    const signatureBytes = parseHex(input.signature, 64);
    if (publicKeyBytes === null || signatureBytes === null) {
      return false;
    }

    const message = Buffer.concat([
      Buffer.from(input.timestamp, "utf8"),
      bodyBuffer(input.body)
    ]);
    const key = createPublicKey({
      key: Buffer.concat([discordEd25519SpkiPrefix, publicKeyBytes]),
      format: "der",
      type: "spki"
    });

    return verifySignature(null, message, key, signatureBytes);
  } catch {
    return false;
  }
}

export async function handleDiscordHttpInteraction(
  options: DiscordHttpInteractionHandlerOptions,
  request: DiscordHttpInteractionRequest
): Promise<DiscordHttpInteractionResponse> {
  const now = options.now?.() ?? new Date();
  const method = (request.method ?? "POST").toUpperCase();
  const reject = async (
    status: number,
    reason: DiscordHttpSecurityRejectReason,
    responseError = reason,
    timestamp?: string
  ): Promise<DiscordHttpInteractionResponse> => {
    await auditDiscordHttpSecurityRejection(options.projectRoot, {
      reason,
      method,
      timestamp,
      body: request.body,
      recordedAt: now
    });
    return jsonResponse(status, { error: responseError });
  };

  if (method !== "POST") {
    return reject(405, "method_not_allowed");
  }

  const signature = readHeader(request.headers, "x-signature-ed25519");
  const timestamp = readHeader(request.headers, "x-signature-timestamp");
  if (signature === undefined || timestamp === undefined) {
    return reject(
      401,
      "missing_signature_headers",
      "invalid_request_signature",
      timestamp
    );
  }

  const toleranceSeconds =
    options.timestampToleranceSeconds ?? defaultDiscordTimestampToleranceSeconds;
  assertPositiveInteger(toleranceSeconds, "Discord timestamp tolerance");
  const requestTime = parseDiscordSignatureTimestamp(timestamp);
  if (requestTime === null) {
    return reject(
      401,
      "invalid_signature_timestamp",
      "invalid_request_signature",
      timestamp
    );
  }

  if (Math.abs(now.getTime() - requestTime) > toleranceSeconds * 1000) {
    return reject(401, "signature_timestamp_out_of_range", undefined, timestamp);
  }

  if (
    !verifyDiscordHttpInteractionSignature({
      publicKey: options.publicKey,
      signature,
      timestamp,
      body: request.body
    })
  ) {
    return reject(401, "invalid_request_signature", undefined, timestamp);
  }

  if (
    options.replayGuard !== undefined &&
    !options.replayGuard.claim({ signature, timestamp, body: request.body, now })
  ) {
    return reject(409, "replayed_request", undefined, timestamp);
  }

  const payload = parseInteractionPayload(request.body);
  if (payload === null) {
    return reject(400, "invalid_json_body", undefined, timestamp);
  }

  if (payload.type === 1) {
    return jsonResponse(200, { type: interactionCallback.pong });
  }

  const result = await normalizeHttpInteraction(
    options.projectRoot,
    options.gateway,
    payload,
    now
  );

  return jsonResponse(200, {
    type: interactionCallback.channelMessageWithSource,
    data: {
      content: formatNormalizedResult(result),
      flags: 64
    }
  });
}

function parseDiscordSignatureTimestamp(value: string): number | null {
  if (!/^\d{1,16}$/.test(value)) {
    return null;
  }

  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) {
    return null;
  }

  const milliseconds = seconds * 1000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function replayKey(input: {
  signature: string;
  timestamp: string;
  body: string | Buffer;
}): string {
  return createHash("sha256")
    .update(input.signature)
    .update("\0")
    .update(input.timestamp)
    .update("\0")
    .update(bodyBuffer(input.body))
    .digest("hex");
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

async function normalizeHttpInteraction(
  projectRoot: string,
  gateway: PreparedDiscordGateway,
  payload: DiscordInteractionPayload,
  now: Date
): Promise<NormalizedDiscordCommand> {
  const input = toDiscordInteractionInput(payload, now);
  const commandName = input.command_name;

  if (payload.type === 2 && commandName === "kairon status") {
    return normalizeDiscordStatusCommand(projectRoot, gateway, input, now);
  }

  if (payload.type === 2 && commandName === "kairon leave") {
    return normalizeDiscordLeaveCommand(projectRoot, gateway, input, now);
  }

  if (
    (payload.type === 3 || payload.type === 5) &&
    input.custom_id?.startsWith("kr:v1:apr:") === true
  ) {
    return normalizeDiscordApprovalInteraction(projectRoot, gateway, input);
  }

  return {
    accepted: false,
    duplicate: false,
    reason: "unsupported discord interaction"
  };
}

function toDiscordInteractionInput(
  payload: DiscordInteractionPayload,
  now: Date
): DiscordInteractionInput {
  const data = objectValue(payload.data);
  const message = objectValue(payload.message);
  const subcommand = readFirstOptionName(data?.options);

  return {
    interaction_id: stringValue(payload.id) ?? `discord-http-${now.getTime()}`,
    user_id: readUserId(payload),
    guild_id: stringValue(payload.guild_id),
    channel_id: stringValue(payload.channel_id),
    message_id: stringValue(message?.id),
    custom_id: stringValue(data?.custom_id),
    command_name:
      stringValue(data?.name) === undefined
        ? undefined
        : [stringValue(data?.name), subcommand].filter(Boolean).join(" "),
    reason: readComponentTextValue(data, "reason"),
    snooze_until: readComponentTextValue(data, "snooze_until"),
    received_at: now.toISOString()
  };
}

function readUserId(payload: DiscordInteractionPayload): string {
  const member = objectValue(payload.member);
  const memberUser = objectValue(member?.user);
  const user = objectValue(payload.user);
  return stringValue(memberUser?.id) ?? stringValue(user?.id) ?? "";
}

function readFirstOptionName(options: unknown): string | undefined {
  if (!Array.isArray(options)) {
    return undefined;
  }

  const first = objectValue(options[0]);
  return stringValue(first?.name);
}

function readComponentTextValue(
  data: Record<string, unknown> | undefined,
  customId: string
): string | undefined {
  const value = findComponentValue(data?.components, customId)?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function findComponentValue(
  components: unknown,
  customId: string
): string | undefined {
  if (!Array.isArray(components)) {
    return undefined;
  }

  for (const component of components) {
    const item = objectValue(component);
    if (item === undefined) {
      continue;
    }

    if (stringValue(item.custom_id) === customId) {
      return stringValue(item.value);
    }

    const nested = findComponentValue(item.components, customId);
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

function formatNormalizedResult(result: NormalizedDiscordCommand): string {
  if (!result.accepted) {
    return result.duplicate
      ? "Kairon command was already handled."
      : `Kairon command was rejected: ${result.reason}`;
  }

  return result.duplicate
    ? `Kairon command was already handled: ${result.command_id}`
    : `Kairon command queued: ${result.command_id}`;
}

function readHeader(
  headers: DiscordHttpInteractionRequest["headers"],
  name: string
): string | undefined {
  const matched = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name
  )?.[1];
  if (Array.isArray(matched)) {
    return matched[0];
  }
  return matched;
}

function parseInteractionPayload(
  body: string | Buffer
): DiscordInteractionPayload | null {
  try {
    const parsed = JSON.parse(bodyBuffer(body).toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    return parsed as DiscordInteractionPayload;
  } catch {
    return null;
  }
}

function jsonResponse(
  status: number,
  payload: Record<string, unknown>
): DiscordHttpInteractionResponse {
  return {
    status,
    headers: jsonHeaders,
    body: JSON.stringify(payload)
  };
}

function bodyBuffer(body: string | Buffer): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
}

function parseHex(value: string, expectedBytes: number): Buffer | null {
  const normalized = value.trim().replace(/^0x/i, "");
  if (
    normalized.length !== expectedBytes * 2 ||
    !/^[0-9a-f]+$/i.test(normalized)
  ) {
    return null;
  }

  return Buffer.from(normalized, "hex");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
