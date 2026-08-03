import { readFile } from "node:fs/promises";
import path from "node:path";

import { resolveSecret } from "../dist/core/secrets/secret-resolver.js";

export async function hydrateNonSecretDiscordEnvironment(
  environment,
  projectRoot
) {
  try {
    const gateway = JSON.parse(
      await readFile(
        path.join(
          projectRoot,
          ".kairon",
          "runtime",
          "discord",
          "gateway.json"
        ),
        "utf8"
      )
    );
    environment.KAIRON_DISCORD_APPLICATION_ID ??= String(gateway.application_id);
    environment.KAIRON_DISCORD_GUILD_ID ??= String(gateway.guild_id);
    environment.KAIRON_DISCORD_APPROVAL_CHANNEL_ID ??= String(
      gateway.approval_channel_id
    );
  } catch {
    // Fresh projects must provide the non-secret Discord IDs explicitly.
  }
  try {
    const schedule = JSON.parse(
      await readFile(
        path.join(projectRoot, ".kairon", "config", "t199-soak-schedule.json"),
        "utf8"
      )
    );
    environment.KAIRON_DISCORD_OWNER_USER_ID ??= String(
      schedule.discord_owner_user_id
    );
    environment.KAIRON_DISCORD_ALLOWED_USER_IDS ??= String(
      schedule.discord_allowed_user_ids
    );
  } catch {
    // Operators may provide the non-secret user IDs through the environment.
  }
  const missing = [
    "KAIRON_DISCORD_OWNER_USER_ID",
    "KAIRON_DISCORD_ALLOWED_USER_IDS"
  ].filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing non-secret Discord environment: ${missing.join(",")}`);
  }
  return environment;
}

export async function hydrateDiscordPublicKey(environment) {
  if (environment.KAIRON_DISCORD_PUBLIC_KEY?.trim()) {
    return environment;
  }
  const target =
    environment.KAIRON_DISCORD_PUBLIC_KEY_CREDENTIAL_TARGET?.trim() ||
    "Kairon/DISCORD_PUBLIC_KEY";
  const secret = await resolveSecret({
    env: environment,
    references: [{ provider: "windows_credential", target }]
  });
  if (secret.status !== "present") {
    throw new Error(`Discord Public Key is unavailable: ${target}`);
  }
  environment.KAIRON_DISCORD_PUBLIC_KEY = secret.value;
  return environment;
}
