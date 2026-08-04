import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

export async function appendJsonLine(
  filePath: string,
  value: unknown
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export async function readJsonLines<T>(filePath: string): Promise<T[]> {
  const text = await readFile(filePath, "utf8");

  return parseJsonLines<T>(text, filePath);
}

export async function readJsonLinesTail<T>(
  filePath: string,
  maxLines: number,
  options: { chunkSizeBytes?: number } = {}
): Promise<T[]> {
  if (!Number.isSafeInteger(maxLines) || maxLines < 0) {
    throw new Error(`maxLines must be a non-negative safe integer: ${maxLines}`);
  }
  if (maxLines === 0) {
    return [];
  }

  const chunkSize = options.chunkSizeBytes ?? 64 * 1_024;
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`chunkSizeBytes must be a positive safe integer: ${chunkSize}`);
  }

  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    let position = size;
    let newlineCount = 0;
    const chunks: Buffer[] = [];

    while (position > 0 && newlineCount <= maxLines) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      for (const byte of chunk) {
        if (byte === 0x0a) {
          newlineCount += 1;
        }
      }
    }

    const text = Buffer.concat(chunks).toString("utf8");
    const lines = nonEmptyJsonLines(text).slice(-maxLines);
    return parseJsonLineValues<T>(lines, filePath, "tail");
  } finally {
    await handle.close();
  }
}

function parseJsonLines<T>(text: string, filePath: string): T[] {
  return parseJsonLineValues<T>(nonEmptyJsonLines(text), filePath, "line");
}

function nonEmptyJsonLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function parseJsonLineValues<T>(
  lines: string[],
  filePath: string,
  locationLabel: "line" | "tail"
): T[] {
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as T;
    } catch (error) {
      throw new Error(
        `Failed to parse JSONL ${filePath} at ${locationLabel} ${index + 1}: ${String(
          error
        )}`
      );
    }
  });
}
