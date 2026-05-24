import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type LockFileData = {
  owner: string;
  pid: number;
  created_at: string;
  expires_at: string;
};

export type LockHandle = {
  path: string;
  data: LockFileData;
};

export async function acquireLockFile(
  filePath: string,
  owner: string,
  ttlMs: number
): Promise<LockHandle> {
  await mkdir(path.dirname(filePath), { recursive: true });

  const now = Date.now();
  const data: LockFileData = {
    owner,
    pid: process.pid,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString()
  };

  try {
    const handle = await open(filePath, "wx");
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
    await handle.close();
    return { path: filePath, data };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }

    if (await isLockExpired(filePath)) {
      await rm(filePath, { force: true });
      return acquireLockFile(filePath, owner, ttlMs);
    }

    throw new Error(`Lock already exists: ${filePath}`);
  }
}

export async function releaseLockFile(handle: LockHandle): Promise<void> {
  await rm(handle.path, { force: true });
}

export async function refreshLockFile(
  handle: LockHandle,
  ttlMs: number
): Promise<LockHandle> {
  const now = Date.now();
  const data: LockFileData = {
    ...handle.data,
    expires_at: new Date(now + ttlMs).toISOString()
  };

  await writeFile(handle.path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return { ...handle, data };
}

export async function isLockExpired(filePath: string): Promise<boolean> {
  const raw = await readFile(filePath, "utf8");
  const data = JSON.parse(raw) as LockFileData;
  return Date.parse(data.expires_at) <= Date.now();
}
