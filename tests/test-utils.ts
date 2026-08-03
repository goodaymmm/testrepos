import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function createTempProject(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "kairon-test-"));
}
