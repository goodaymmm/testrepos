import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSecret } from "../dist/core/secrets/secret-resolver.js";
import { hydrateNonSecretDiscordEnvironment } from "./t199-discord-environment.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const cliPath = path.join(repositoryRoot, "dist", "cli", "main.js");
const cliArguments = process.argv.slice(2);
const childEnvironment = { ...process.env };
const requiresDiscord = cliArguments[0] !== "stop";
if (requiresDiscord) {
  await hydrateNonSecretDiscordEnvironment(childEnvironment, process.cwd());
}

if (requiresDiscord && !childEnvironment.KAIRON_DISCORD_BOT_TOKEN?.trim()) {
  const credentialTarget =
    childEnvironment.KAIRON_DISCORD_BOT_TOKEN_CREDENTIAL_TARGET?.trim() ||
    "Kairon/DISCORD_BOT_TOKEN";
  const secret = await resolveSecret({
    env: childEnvironment,
    references: [
      { provider: "windows_credential", target: credentialTarget }
    ]
  });
  if (secret.status !== "present") {
    console.error("Kairon Discord credential setup required.");
    console.error(`credential_target=${credentialTarget}`);
    process.exit(2);
  }
  childEnvironment.KAIRON_DISCORD_BOT_TOKEN = secret.value;
}

const child = spawn(process.execPath, [cliPath, ...cliArguments], {
  cwd: process.cwd(),
  env: childEnvironment,
  stdio: "inherit",
  windowsHide: true
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`Kairon launcher failed: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === null ? 1 : 0);
});
