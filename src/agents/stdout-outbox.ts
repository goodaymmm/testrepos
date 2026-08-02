const OUTBOX_START = "KAIRON_OUTBOX_JSON_START";
const OUTBOX_END = "KAIRON_OUTBOX_JSON_END";

export function extractOutboxFromStdout(stdout: string): unknown | undefined {
  let latest: unknown | undefined;

  for (const candidate of stdoutCandidates(stripTerminalControlSequences(stdout))) {
    const pattern = new RegExp(
      `${OUTBOX_START}\\s*([\\s\\S]*?)\\s*${OUTBOX_END}`,
      "g"
    );

    for (const match of candidate.matchAll(pattern)) {
      if (match[1] === undefined) {
        continue;
      }

      try {
        latest = JSON.parse(match[1]) as unknown;
      } catch {
        // Interactive terminals can echo the fallback contract before the response.
      }
    }
  }

  return latest;
}

export function hasMatchingStdoutOutbox(stdout: string, runId: string): boolean {
  const outbox = extractOutboxFromStdout(stdout);
  return (
    outbox !== null &&
    typeof outbox === "object" &&
    !Array.isArray(outbox) &&
    (outbox as Record<string, unknown>).run_id === runId
  );
}

export function stripTerminalControlSequences(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B[P^_][\s\S]*?\u001B\\/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "");
}

function stdoutCandidates(stdout: string): string[] {
  const candidates = [stdout];

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) {
      continue;
    }

    try {
      collectStrings(JSON.parse(line) as unknown, candidates);
    } catch {
      continue;
    }
  }

  return candidates;
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, output);
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectStrings(item, output);
    }
  }
}
