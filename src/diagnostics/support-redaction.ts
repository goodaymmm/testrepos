import os from "node:os";
import path from "node:path";

export type SupportRedactionSummary = {
  policy_version: "0.1";
  redacted_fields: number;
  redacted_values: number;
  omitted_fields: number;
  truncated_values: number;
};

export type SupportSecretFinding = {
  entry: string;
  pattern: string;
};

export type SupportSecretScan = {
  status: "passed" | "failed";
  scanned_entries: number;
  finding_count: number;
  findings: SupportSecretFinding[];
};

type SanitizeOptions = {
  projectRoot?: string;
  homeDirectory?: string;
};

const sensitiveKeyPattern = /(?:api[_-]?key|token|secret|password|authorization|credential|cookie|private[_-]?key)/iu;
const omittedKeyPattern = /^(?:stdout|stderr|diff|patch|prompt|raw_output|raw_content|command_line)$/iu;
const maxStringLength = 1_000;
const maxArrayLength = 100;

const secretPatterns: Array<{ id: string; pattern: RegExp }> = [
  { id: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu },
  { id: "github_token", pattern: /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[opusr]_[A-Za-z0-9]{20,})\b/gu },
  { id: "openai_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/gu },
  { id: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu },
  { id: "discord_token", pattern: /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/gu },
  { id: "bearer_token", pattern: /\bBearer\s+(?!\[(?:redacted|omitted)\])[A-Za-z0-9._~+\/-]{12,}/giu },
  {
    id: "sensitive_assignment",
    pattern: /\b(?:api[_-]?key|token|secret|password|authorization|credential|cookie|private[_-]?key)\b\s*[:=]\s*(?!\[(?:redacted|omitted)\])(?!(?:null|none|missing|present|false|true)\b)[^\s,;}{]{4,}/giu
  },
  {
    id: "sensitive_url_query",
    pattern: /[?&](?:access_token|api_key|apikey|token|secret|password|signature)=(?!\[(?:redacted|omitted)\])[^&#\s]+/giu
  }
];

export function sanitizeSupportValue(
  value: unknown,
  options: SanitizeOptions = {}
): { value: unknown; redaction: SupportRedactionSummary } {
  const redaction: SupportRedactionSummary = {
    policy_version: "0.1",
    redacted_fields: 0,
    redacted_values: 0,
    omitted_fields: 0,
    truncated_values: 0
  };

  return {
    value: sanitizeValue(value, options, redaction, new WeakSet<object>()),
    redaction
  };
}

export function sanitizeSupportText(
  input: string,
  options: SanitizeOptions = {},
  redaction?: SupportRedactionSummary
): string {
  let value = input;
  const replacements: Array<[RegExp, string]> = [
    [/\bBearer\s+[A-Za-z0-9._~+\/-]+/giu, "Bearer [redacted]"],
    [/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[opusr]_[A-Za-z0-9]{20,})\b/gu, "[redacted-token]"],
    [/\bsk-[A-Za-z0-9_-]{20,}\b/gu, "[redacted-token]"],
    [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/gu, "[redacted-token]"],
    [
      /\b(api[_-]?key|token|secret|password|authorization|credential|cookie|private[_-]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}{]+)/giu,
      "$1=[redacted]"
    ],
    [/[?&](access_token|api_key|apikey|token|secret|password|signature)=[^&#\s]*/giu, "?$1=[redacted]"],
    [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[redacted-email]"]
  ];

  for (const [pattern, replacement] of replacements) {
    const before = value;
    value = value.replace(pattern, replacement);
    if (before !== value) {
      redaction !== undefined && (redaction.redacted_values += 1);
    }
  }

  const roots = [
    options.projectRoot,
    options.homeDirectory ?? os.homedir()
  ].filter((candidate): candidate is string =>
    typeof candidate === "string" && candidate.length > 0
  );
  for (const root of roots) {
    for (const candidate of new Set([path.resolve(root), path.resolve(root).replaceAll("\\", "/")])) {
      const before = value;
      value = value.replace(new RegExp(escapeRegExp(candidate), "giu"),
        root === options.projectRoot ? "<project-root>" : "<user-home>");
      if (before !== value) {
        redaction !== undefined && (redaction.redacted_values += 1);
      }
    }
  }

  value = value.replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s]+/giu, "<user-home>");
  if (value.length > maxStringLength) {
    redaction !== undefined && (redaction.truncated_values += 1);
    return `${value.slice(0, maxStringLength - 3)}...`;
  }
  return value;
}

export function scanSupportEntries(
  entries: Array<{ path: string; content: Uint8Array | string }>
): SupportSecretScan {
  const findings: SupportSecretFinding[] = [];
  for (const entry of entries) {
    const text = typeof entry.content === "string"
      ? entry.content
      : Buffer.from(entry.content).toString("utf8");
    for (const candidate of secretPatterns) {
      candidate.pattern.lastIndex = 0;
      if (candidate.pattern.test(text)) {
        findings.push({ entry: entry.path, pattern: candidate.id });
      }
    }
  }

  return {
    status: findings.length === 0 ? "passed" : "failed",
    scanned_entries: entries.length,
    finding_count: findings.length,
    findings
  };
}

function sanitizeValue(
  value: unknown,
  options: SanitizeOptions,
  redaction: SupportRedactionSummary,
  seen: WeakSet<object>
): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return sanitizeSupportText(value, options, redaction);
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    redaction.omitted_fields += 1;
    return "[omitted-circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    if (value.length > maxArrayLength) {
      redaction.truncated_values += 1;
    }
    return value.slice(0, maxArrayLength).map((item) =>
      sanitizeValue(item, options, redaction, seen));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (omittedKeyPattern.test(key)) {
      sanitized[key] = "[omitted]";
      redaction.omitted_fields += 1;
      continue;
    }
    if (sensitiveKeyPattern.test(key)) {
      sanitized[key] = "[redacted]";
      redaction.redacted_fields += 1;
      continue;
    }
    sanitized[key] = sanitizeValue(child, options, redaction, seen);
  }
  return sanitized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
