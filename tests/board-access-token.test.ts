import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  issuePersistentBoardAccess,
  revokePersistentBoardAccess,
  validatePersistentBoardAccess,
  type BoardAccessRecord
} from "../src/board/access-token.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile } from "../src/core/fs/json-file.js";
import { createTempProject } from "./test-utils.js";

describe("persistent Board access token", () => {
  it("stores only a hash and rejects expiry and revocation", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const token = "remote-board-token-abcdefghijklmnopqrstuvwxyz0123456789";
    const issued = await issuePersistentBoardAccess(root, {
      now: new Date("2026-07-16T00:00:00.000Z"),
      ttlMinutes: 15,
      randomToken: () => token,
      accessId: "BOARD-ACCESS-T154-0001"
    });

    expect(issued).toMatchObject({
      access_id: "BOARD-ACCESS-T154-0001",
      access_token: token,
      expires_at: "2026-07-16T00:15:00.000Z",
      artifact_path: ".kairon/runtime/board/access/BOARD-ACCESS-T154-0001.json"
    });
    const record = await readJsonFile<BoardAccessRecord>(
      path.join(root, issued.artifact_path)
    );
    expect(record.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain(token);

    await expect(
      validatePersistentBoardAccess({
        projectRoot: root,
        token,
        now: new Date("2026-07-16T00:14:59.000Z")
      })
    ).resolves.toEqual({ accepted: true, access_id: issued.access_id });
    await expect(
      validatePersistentBoardAccess({
        projectRoot: root,
        token,
        now: new Date("2026-07-16T00:15:00.000Z")
      })
    ).resolves.toEqual({
      accepted: false,
      reason: "expired_token",
      access_id: issued.access_id
    });

    await revokePersistentBoardAccess(
      root,
      issued.access_id,
      new Date("2026-07-16T00:10:00.000Z")
    );
    await expect(
      validatePersistentBoardAccess({
        projectRoot: root,
        token,
        now: new Date("2026-07-16T00:11:00.000Z")
      })
    ).resolves.toEqual({
      accepted: false,
      reason: "invalid_token",
      access_id: issued.access_id
    });
  });

  it("rejects unsafe ids and excessive TTLs", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await expect(
      issuePersistentBoardAccess(root, { accessId: "../escape" })
    ).rejects.toThrow("Invalid Board access id");
    await expect(
      issuePersistentBoardAccess(root, { ttlMinutes: 1_441 })
    ).rejects.toThrow("1440 minutes");
  });
});
