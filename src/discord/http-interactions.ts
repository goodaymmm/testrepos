import { createPublicKey, verify as verifySignature } from "node:crypto";
import {
  normalizeDiscordApprovalInteraction,
  normalizeDiscordLeaveCommand,
  normalizeDiscordStatusCommand,
  type DiscordInteractionInput,
  type NormalizedDiscordCommand
} from "./interactions.js";
import type { PreparedDiscordGateway } from "./gateway.js";

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
};

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
  if ((request.method ?? "POST").toUpperCase() !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  const signature = readHeader(request.headers, "x-signature-ed25519");
  const timestamp = readHeader(request.headers, "x-signature-timestamp");
  if (
    signature === undefined ||
    timestamp === undefined ||
    !verifyDiscordHttpInteractionSignature({
      publicKey: options.publicKey,
      signature,
      timestamp,
      body: request.body
    })
  ) {
    return jsonResponse(401, { error: "invalid_request_signature" });
  }

  const payload = parseInteractionPayload(request.body);
  if (payload === null) {
    return jsonResponse(400, { error: "invalid_json_body" });
  }

  if (payload.type === 1) {
    return jsonResponse(200, { type: interactionCallback.pong });
  }

  const now = options.now?.() ?? new Date();
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
