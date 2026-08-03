import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { validateConfigFile } from "../src/core/config/validate-config.js";
import {
  prepareStableRemoteProfile,
  proposeStableRemoteMigration,
  resolveBoardProfileConfig,
  resolveDiscordHttpProfileConfig,
  type RemoteNotificationsConfig
} from "../src/remote/profile.js";
import {
  getStoredStableRemoteStatus,
  inspectStableRemoteOperations
} from "../src/remote/status.js";
import {
  getRemoteStatusCommand,
  validateRemoteProfileCommand
} from "../src/cli/commands/remote.js";
import { notifyPendingDiscordApprovals } from "../src/discord/approval-notifier.js";
import type { PreparedDiscordGateway } from "../src/discord/gateway.js";
import { createTempProject } from "./test-utils.js";

describe("stable remote operations profile", () => {
  it("requires fixed HTTPS hosts and rejects ephemeral quick tunnels", () => {
    const prepared = prepareStableRemoteProfile({
      profile: "stable-remote-readonly",
      discord_interactions_base_url:
        "https://temporary.trycloudflare.com/discord/",
      board_base_url: "http://127.0.0.1:8787/",
      trusted_proxies: ["not-a-cidr"],
      allowed_origins: ["http://board.example.test"],
      identity_header: "invalid header"
    });

    expect(prepared.configured).toBe(true);
    expect(prepared.missingConfig).toEqual(
      expect.arrayContaining([
        "notifications.remote.discord_interactions_base_url",
        "notifications.remote.board_base_url"
      ])
    );
    expect(prepared.invalidConfig).toEqual(
      expect.arrayContaining([
        "notifications.remote.discord_interactions_base_url",
        "notifications.remote.board_base_url",
        "notifications.remote.trusted_proxies",
        "notifications.remote.allowed_origins",
        "notifications.remote.identity_header"
      ])
    );
  });

  it("resolves one stable profile into Discord and Board settings", () => {
    const notifications: RemoteNotificationsConfig = {
      remote: stableRemoteConfig(),
      http: { profile: "loopback" },
      board: { enabled: false, profile: "loopback" }
    };

    expect(resolveDiscordHttpProfileConfig(notifications)).toEqual({
      profile: "reverse-proxy",
      external_base_url: "https://ops.example.test/discord/",
      trusted_proxies: ["127.0.0.1/32"]
    });
    expect(resolveBoardProfileConfig(notifications)).toMatchObject({
      enabled: true,
      profile: "remote-readonly",
      external_base_url: "https://ops.example.test/board/",
      trusted_proxies: ["127.0.0.1/32"],
      allowed_origins: ["https://ops.example.test"],
      identity_header: "x-kairon-verified-identity"
    });
  });

  it("validates the stable profile through the notifications schema", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const configPath = path.join(
      root,
      ".kairon",
      "config",
      "notifications.json"
    );
    const notifications = await readJsonFile<Record<string, unknown>>(configPath);
    notifications.remote = stableRemoteConfig();

    expect(
      validateConfigFile("notifications.json", notifications)
    ).toMatchObject({ ok: true, errors: [] });

    notifications.remote = {
      ...stableRemoteConfig(),
      board_base_url: "https://temporary.trycloudflare.com/"
    };
    expect(
      validateConfigFile("notifications.json", notifications)
    ).toMatchObject({ ok: false });
  });

  it("reports an unknown profile as setup required through CLI status", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const configPath = path.join(
      root,
      ".kairon",
      "config",
      "notifications.json"
    );
    const notifications = await readJsonFile<Record<string, unknown>>(configPath);
    notifications.remote = { profile: "unexpected-profile" };
    await writeJsonFileAtomic(configPath, notifications);

    const validation = JSON.parse(
      await validateRemoteProfileCommand(root, { format: "json" })
    ) as Record<string, unknown>;
    const status = await inspectStableRemoteOperations(root, {
      probeExternal: false,
      persist: false
    });

    expect(validation).toMatchObject({
      status: "setup_required",
      valid: false,
      invalid_config: ["notifications.remote.profile"]
    });
    expect(status).toMatchObject({
      status: "setup_required",
      config: {
        status: "setup_required",
        invalid: ["notifications.remote.profile"]
      }
    });
  });

  it("proposes a non-mutating migration from matching legacy profiles", () => {
    const notifications: RemoteNotificationsConfig = {
      http: {
        profile: "reverse-proxy",
        external_base_url: "https://ops.example.test/discord/",
        trusted_proxies: ["127.0.0.1/32"]
      },
      board: {
        enabled: true,
        profile: "remote-readonly",
        external_base_url: "https://ops.example.test/board/",
        trusted_proxies: ["127.0.0.1/32"],
        allowed_origins: ["https://ops.example.test"],
        identity_header: "x-kairon-verified-identity"
      }
    };

    expect(proposeStableRemoteMigration(notifications)).toMatchObject({
      proposal_kind: "stable_remote_profile",
      source: "notifications.http+notifications.board",
      target: stableRemoteConfig()
    });
    expect(notifications.remote).toBeUndefined();
  });

  it("does not propose an invalid migration from mismatched Board origins", () => {
    const notifications: RemoteNotificationsConfig = {
      http: {
        profile: "reverse-proxy",
        external_base_url: "https://ops.example.test/discord/",
        trusted_proxies: ["127.0.0.1/32"]
      },
      board: {
        enabled: true,
        profile: "remote-readonly",
        external_base_url: "https://ops.example.test/board/",
        trusted_proxies: ["127.0.0.1/32"],
        allowed_origins: ["https://different.example.test"],
        identity_header: "x-kairon-verified-identity"
      }
    };

    expect(proposeStableRemoteMigration(notifications)).toBeUndefined();
  });

  it("records ready external endpoints with identity enforcement", async () => {
    const root = await createRemoteProject();
    await writeRuntimeStatuses(root);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/discord/ready")) {
        return Response.json({
          status: "ready",
          mode: "http_interactions"
        });
      }
      return new Response("", {
        status: 302,
        headers: { location: "https://identity.example.test/login" }
      });
    }) as unknown as typeof fetch;

    const status = await inspectStableRemoteOperations(root, {
      fetchImpl,
      probeExternal: true,
      now: () => new Date("2026-07-25T00:00:00.000Z")
    });

    expect(status).toMatchObject({
      profile: "stable-remote-readonly",
      status: "ready",
      discord: {
        local_status: "ready",
        external_readiness: "ready",
        url_drift: false
      },
      board: {
        local_status: "ready",
        external_readiness: "identity_enforced",
        url_drift: false
      },
      identity: { status: "enforced" },
      tunnel: { status: "connected" },
      issues: []
    });
    await expect(getStoredStableRemoteStatus(root)).resolves.toMatchObject({
      status: "ready",
      checked_at: "2026-07-25T00:00:00.000Z"
    });

    await getRemoteStatusCommand(root, { format: "json" });
    await expect(getStoredStableRemoteStatus(root)).resolves.toMatchObject({
      status: "ready",
      checked_at: "2026-07-25T00:00:00.000Z",
      discord: { external_readiness: "ready" },
      identity: { status: "enforced" }
    });
  });

  it("accepts a successful Board response marked by the identity proxy", async () => {
    const root = await createRemoteProject();
    await writeRuntimeStatuses(root);
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/discord/ready")
        ? Response.json({ status: "ready", mode: "http_interactions" })
        : new Response("<html>Board</html>", {
            status: 200,
            headers: { "x-kairon-identity-enforced": "verified" }
          })
    ) as unknown as typeof fetch;

    const status = await inspectStableRemoteOperations(root, {
      fetchImpl,
      probeExternal: true
    });

    expect(status).toMatchObject({
      status: "ready",
      board: { external_readiness: "identity_enforced" },
      identity: { status: "enforced" },
      issues: []
    });
  });

  it("tracks and resets consecutive external probe failures", async () => {
    const root = await createRemoteProject();
    await writeRuntimeStatuses(root);
    const now = new Date("2026-07-25T00:00:00.000Z");
    const failingFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/discord/ready")) {
        return Response.json({ status: "ready", mode: "http_interactions" });
      }
      throw new Error("transient board failure");
    }) as unknown as typeof fetch;

    const first = await inspectStableRemoteOperations(root, {
      fetchImpl: failingFetch,
      probeExternal: true,
      now: () => now
    });
    const second = await inspectStableRemoteOperations(root, {
      fetchImpl: failingFetch,
      probeExternal: true,
      now: () => new Date(now.getTime() + 60_000)
    });
    const third = await inspectStableRemoteOperations(root, {
      fetchImpl: failingFetch,
      probeExternal: true,
      now: () => new Date(now.getTime() + 120_000)
    });
    expect(first.board.consecutive_failures).toBe(1);
    expect(second.board.consecutive_failures).toBe(2);
    expect(third.board.consecutive_failures).toBe(3);
    expect(second.discord.consecutive_failures).toBe(0);

    const recovered = await inspectStableRemoteOperations(root, {
      probeExternal: true,
      now: () => new Date(now.getTime() + 180_000),
      fetchImpl: vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/discord/ready")
          ? Response.json({ status: "ready", mode: "http_interactions" })
          : new Response("", { status: 302 })
      ) as unknown as typeof fetch
    });
    expect(recovered.status).toBe("ready");
    expect(recovered.board.consecutive_failures).toBe(0);
    expect(recovered.tunnel.consecutive_failures).toBe(0);
  });

  it("adds the fixed remote Board deep link without embedding a token", async () => {
    const root = await createRemoteProject();
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "approvals", "APR-REMOTE.json"),
      {
        schema_version: "0.1",
        id: "APR-REMOTE",
        status: "pending",
        title: "Remote approval",
        type: "manual_test",
        actions: ["approve", "reject"]
      }
    );
    const sent: unknown[] = [];
    const result = await notifyPendingDiscordApprovals(
      root,
      {
        status: "ready",
        approval_channel_id: "1512774533143335034"
      } as PreparedDiscordGateway & { status: "ready" },
      {
        id: "1512774533143335034",
        send: async (payload) => {
          sent.push(payload);
          return { id: "message-remote" };
        }
      }
    );

    const payload = JSON.stringify(sent[0]);
    expect(result.sent).toBe(1);
    expect(payload).toContain(
      "https://ops.example.test/board/#approval-APR-REMOTE"
    );
    expect(payload).not.toMatch(/[?&](?:token|access_token)=/iu);
  });

  it("detects URL drift, identity bypass, and a disconnected tunnel", async () => {
    const root = await createRemoteProject();
    await writeRuntimeStatuses(root, {
      discordUrl: "https://drift.example.test/interactions",
      boardUrl: "https://drift.example.test/board/"
    });
    const bypass = await inspectStableRemoteOperations(root, {
      probeExternal: true,
      fetchImpl: vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/discord/ready")
          ? Response.json({ status: "ready", mode: "http_interactions" })
          : new Response("<html>Board</html>", { status: 200 })
      ) as unknown as typeof fetch
    });
    expect(bypass.status).toBe("degraded");
    expect(bypass.identity.status).toBe("bypass_detected");
    expect(bypass.issues).toEqual(
      expect.arrayContaining([
        "discord_url_drift",
        "board_url_drift",
        "board_identity_bypass"
      ])
    );

    const disconnected = await inspectStableRemoteOperations(root, {
      probeExternal: true,
      fetchImpl: vi.fn(async () => {
        throw new Error("network unavailable");
      }) as unknown as typeof fetch
    });
    expect(disconnected.tunnel.status).toBe("disconnected");
    expect(disconnected.issues).toContain("tunnel_disconnected");
  });
});

function stableRemoteConfig() {
  return {
    profile: "stable-remote-readonly" as const,
    discord_interactions_base_url: "https://ops.example.test/discord/",
    board_base_url: "https://ops.example.test/board/",
    trusted_proxies: ["127.0.0.1/32"],
    allowed_origins: ["https://ops.example.test"],
    identity_header: "x-kairon-verified-identity"
  };
}

async function createRemoteProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  const configPath = path.join(
    root,
    ".kairon",
    "config",
    "notifications.json"
  );
  const notifications = await readJsonFile<RemoteNotificationsConfig>(configPath);
  notifications.remote = stableRemoteConfig();
  await writeJsonFileAtomic(configPath, notifications);
  return root;
}

async function writeRuntimeStatuses(
  root: string,
  options: {
    discordUrl?: string;
    boardUrl?: string;
  } = {}
): Promise<void> {
  await writeJsonFileAtomic(
    path.join(root, ".kairon", "runtime", "discord", "http-server.json"),
    {
      schema_version: "0.1",
      status: "ready",
      mode: "http_interactions",
      profile: "reverse-proxy",
      external_url:
        options.discordUrl ??
        "https://ops.example.test/discord/interactions",
      updated_at: "2026-07-25T00:00:00.000Z"
    }
  );
  await writeJsonFileAtomic(
    path.join(root, ".kairon", "runtime", "board", "server.json"),
    {
      schema_version: "0.1",
      status: "ready",
      mode: "remote_read_only",
      profile: "remote-readonly",
      external_url: options.boardUrl ?? "https://ops.example.test/board/",
      updated_at: "2026-07-25T00:00:00.000Z"
    }
  );
}
