import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile } from "../src/core/fs/json-file.js";
import { DiscordIdempotencyStore } from "../src/discord/idempotency.js";
import { createTempProject } from "./test-utils.js";

describe("DiscordIdempotencyStore", () => {
  it("accepts a key once and rejects duplicate interactions", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const store = new DiscordIdempotencyStore(root);
    const now = new Date("2026-05-25T00:00:00.000Z");

    await expect(
      store.accept("discord:interaction:1", {
        commandId: "CMD-0001",
        ttlMinutes: 60,
        now
      })
    ).resolves.toMatchObject({
      duplicate: false
    });
    await expect(
      store.accept("discord:interaction:1", {
        commandId: "CMD-0001",
        ttlMinutes: 60,
        now
      })
    ).resolves.toMatchObject({
      duplicate: true
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "runtime", "discord", "idempotency.json"))
    ).resolves.toMatchObject({
      keys: {
        "discord:interaction:1": {
          status: "accepted",
          command_id: "CMD-0001"
        }
      }
    });
  });

  it("allows an expired key to be accepted again", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const store = new DiscordIdempotencyStore(root);

    await store.accept("discord:interaction:1", {
      ttlMinutes: 1,
      now: new Date("2026-05-25T00:00:00.000Z")
    });
    await expect(
      store.accept("discord:interaction:1", {
        ttlMinutes: 1,
        now: new Date("2026-05-25T00:02:00.000Z")
      })
    ).resolves.toMatchObject({
      duplicate: false
    });
  });
});
