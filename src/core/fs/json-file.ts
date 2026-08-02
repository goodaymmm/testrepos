import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const atomicRenameRetryDelaysMs = [25, 50, 100, 200, 400, 800, 1_000] as const;

export async function readJsonFile<T>(filePath: string): Promise<T> {
  try {
    return JSON.parse(stripUtf8Bom(await readFile(filePath, "utf8"))) as T;
  } catch (error) {
    throw new Error(`Failed to read JSON file ${filePath}: ${String(error)}`);
  }
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });

  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`
  );

  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await renameAtomicFile(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    const wrapped = new Error(
      `Failed to write JSON file ${filePath}: ${String(error)}`,
      { cause: error }
    );
    const code = findErrorCode(error);
    if (code !== undefined) {
      (wrapped as NodeJS.ErrnoException).code = code;
    }
    throw wrapped;
  }
}

async function renameAtomicFile(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (
        !isTransientRenameError(error) ||
        attempt >= atomicRenameRetryDelaysMs.length
      ) {
        throw error;
      }
      await delay(atomicRenameRetryDelaysMs[attempt]);
    }
  }
}

function isTransientRenameError(error: unknown): boolean {
  return ["EACCES", "EBUSY", "EPERM"].includes(findErrorCode(error) ?? "");
}

function findErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
