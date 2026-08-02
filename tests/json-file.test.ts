import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempProject } from "./test-utils.js";

const fsMocks = vi.hoisted(() => ({
  rename: vi.fn()
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: fsMocks.rename
  };
});

import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";

describe("atomic JSON files", () => {
  beforeEach(() => {
    fsMocks.rename.mockReset();
  });

  it("retries transient Windows rename failures", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises"
    );
    const root = await createTempProject();
    const filePath = path.join(root, "state.json");
    const transient = Object.assign(new Error("sharing violation"), {
      code: "EPERM"
    });
    fsMocks.rename
      .mockRejectedValueOnce(transient)
      .mockImplementation(actual.rename);

    await writeJsonFileAtomic(filePath, { status: "ready" });

    expect(fsMocks.rename).toHaveBeenCalledTimes(2);
    await expect(readJsonFile(filePath)).resolves.toEqual({ status: "ready" });
  });

  it("does not retry permanent rename failures", async () => {
    const root = await createTempProject();
    const filePath = path.join(root, "state.json");
    const permanent = Object.assign(new Error("invalid destination"), {
      code: "EINVAL"
    });
    fsMocks.rename.mockRejectedValue(permanent);

    await expect(writeJsonFileAtomic(filePath, { status: "ready" })).rejects.toMatchObject({
      code: "EINVAL"
    });
    expect(fsMocks.rename).toHaveBeenCalledTimes(1);
  });
});
