import { appendFile, mkdir, readFile } from "node:fs/promises";
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

  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        throw new Error(
          `Failed to parse JSONL ${filePath} at line ${index + 1}: ${String(
            error
          )}`
        );
      }
    });
}
