const redactedValue = "[redacted]";
const omittedValue = "[omitted]";

const secretLikeKeyPattern =
  /(^|[_-])(secret|token|password|api[_-]?key|authorization|cookie|credential|private[_-]?key|webhook)([_-]|$)/i;
const safeSecretMetadataKeys = new Set(["secret_scan", "secret_scan_passed"]);
const inlineSecretAssignmentPattern =
  /((?:api[_-]?key|token|secret|password|authorization|cookie|credential|private[_-]?key|webhook)\s*[:=]\s*)(?!Bearer\s+\[redacted\])(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const authorizationBearerAssignmentPattern =
  /(authorization\s*[:=]\s*)Bearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}/gi;
const bearerTokenPattern = /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}/gi;
const opaqueSecretPatterns = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];

export type BoardSecretScanStatus = "passed" | "warning";

export type BoardSecretScanSummary = {
  status: BoardSecretScanStatus;
  scanned_fields: number;
  scanned_strings: number;
  redacted_fields: number;
  redacted_values: number;
  unresolved_findings: number;
};

export type BoardSecretScanInspection = BoardSecretScanSummary & {
  exposed_findings: number;
};

export function sanitizeBoardProjection<T>(value: T): {
  projection: T;
  summary: BoardSecretScanSummary;
} {
  const counts = createCounts();
  const projection = sanitizeValue(value, counts) as T;

  return {
    projection,
    summary: {
      status: "passed",
      ...counts,
      unresolved_findings: 0
    }
  };
}

export function inspectBoardProjectionSecrets(
  value: unknown
): BoardSecretScanInspection {
  const result = sanitizeBoardProjection(value);
  const exposedFindings =
    result.summary.redacted_fields + result.summary.redacted_values;

  return {
    ...result.summary,
    status: exposedFindings === 0 ? "passed" : "warning",
    unresolved_findings: exposedFindings,
    exposed_findings: exposedFindings
  };
}

function sanitizeValue(value: unknown, counts: ScanCounts): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, counts));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, raw]) => {
        counts.scanned_fields += 1;
        if (isUnsafeSecretField(key, raw)) {
          counts.redacted_fields += 1;
          return [key, typeof raw === "string" ? redactedValue : omittedValue];
        }

        return [key, sanitizeValue(raw, counts)];
      })
    );
  }

  if (typeof value !== "string") {
    return value;
  }

  counts.scanned_strings += 1;
  const sanitized = sanitizeSecretString(value);
  if (sanitized !== value) {
    counts.redacted_values += 1;
  }
  return sanitized;
}

function isUnsafeSecretField(key: string, value: unknown): boolean {
  if (!secretLikeKeyPattern.test(key) || safeSecretMetadataKeys.has(key)) {
    return false;
  }

  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return false;
  }

  return value !== redactedValue && value !== omittedValue;
}

function sanitizeSecretString(value: string): string {
  let sanitized = value
    .replace(authorizationBearerAssignmentPattern, "$1Bearer [redacted]")
    .replace(inlineSecretAssignmentPattern, "$1[redacted]")
    .replace(bearerTokenPattern, "Bearer [redacted]");

  for (const pattern of opaqueSecretPatterns) {
    sanitized = sanitized.replace(pattern, redactedValue);
  }

  return sanitized;
}

type ScanCounts = {
  scanned_fields: number;
  scanned_strings: number;
  redacted_fields: number;
  redacted_values: number;
};

function createCounts(): ScanCounts {
  return {
    scanned_fields: 0,
    scanned_strings: 0,
    redacted_fields: 0,
    redacted_values: 0
  };
}
