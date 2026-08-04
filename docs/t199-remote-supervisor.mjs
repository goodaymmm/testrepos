import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  hydrateDiscordPublicKey,
  hydrateNonSecretDiscordEnvironment
} from "./t199-discord-environment.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const cliPath = path.join(repositoryRoot, "dist", "cli", "main.js");
const arguments_ = process.argv.slice(2);
const projectRoot = resolveProjectRoot(arguments_);
const runtimeRoot = path.join(projectRoot, ".kairon", "runtime");
const logRoot = path.join(projectRoot, ".kairon", "logs", "t199-remote");
const statusPath = path.join(runtimeRoot, "t199-remote-supervisor.json");
const stopRequestPath = path.join(runtimeRoot, "t199-remote-supervisor.stop.json");
const notificationsPath = path.join(
  projectRoot,
  ".kairon",
  "config",
  "notifications.json"
);
const restartDelayMs = 5_000;
const boardRotationMs = 12 * 60 * 60 * 1_000;
const statusRenameRetryDelaysMs = [25, 50, 100, 200, 400, 800, 1_000];
const children = new Map();
let shuttingDown = false;
let boardAccess;
let statusWriteSequence = 0;
let statusWriteQueue = Promise.resolve();
let heartbeatTimer;
let stopRequestTimer;

await mkdir(logRoot, { recursive: true });
if (arguments_.includes("--request-stop")) {
  try {
    await requestSupervisorStop(readIntegerArgument(arguments_, "--timeout-ms", 30_000));
    process.exit(0);
  } catch (error) {
    const reason = String(error?.message ?? error)
      .replace(/[\r\n]+/gu, " ")
      .slice(0, 500);
    console.error(
      `remote_supervisor.stop_status=legacy_cleanup_required reason=${reason}`
    );
    process.exit(4);
  }
}

await rm(stopRequestPath, { force: true });
await hydrateNonSecretDiscordEnvironment(process.env, projectRoot);
await hydrateDiscordPublicKey(process.env);
const notifications = JSON.parse(await readFile(notificationsPath, "utf8"));
const remote = notifications.remote ?? {};
const boardExternalUrl = requireHttpsUrl(
  "notifications.remote.board_base_url",
  remote.board_base_url
);
const discordExternalUrl = requireHttpsUrl(
  "notifications.remote.discord_interactions_base_url",
  remote.discord_interactions_base_url
);
requireEnvironment([
  "KAIRON_DISCORD_APPLICATION_ID",
  "KAIRON_DISCORD_GUILD_ID",
  "KAIRON_DISCORD_APPROVAL_CHANNEL_ID"
]);

for (const port of [18776, 18777, 18778, 18779]) {
  await assertPortAvailable(port);
}

await revokePreviousBoardAccess();
await startFixedServices();
await rotateBoardAccess();
await writeStatus("running");

const rotationTimer = setInterval(() => {
  void rotateBoardAccess().catch((error) => recordError("board-token-rotation", error));
}, boardRotationMs);
heartbeatTimer = setInterval(() => {
  void writeStatus("running").catch((error) => recordError("heartbeat", error));
}, 5_000);
stopRequestTimer = setInterval(() => {
  void checkStopRequest();
}, 1_000);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void shutdown(signal));
}

await new Promise(() => {});

async function startFixedServices() {
  launch({
    name: "board-server",
    command: process.execPath,
    args: [
      cliPath,
      "board",
      "serve",
      "--profile",
      "remote-readonly",
      "--host",
      "127.0.0.1",
      "--port",
      "18778"
    ]
  });
  launch({
    name: "discord-http",
    command: process.execPath,
    args: [
      cliPath,
      "discord",
      "http",
      "start",
      "--profile",
      "reverse-proxy",
      "--host",
      "127.0.0.1",
      "--port",
      "18777"
    ]
  });
  await delay(1_500);
  launch({
    name: "discord-proxy",
    command: process.execPath,
    args: [path.join(scriptDirectory, "t174-tailscale-discord-proxy.mjs")],
    env: {
      KAIRON_T174_DISCORD_PROXY_PORT: "18776",
      KAIRON_T174_DISCORD_UPSTREAM: "http://127.0.0.1:18777/",
      KAIRON_T174_DISCORD_EXTERNAL_HOST: discordExternalUrl.host
    }
  });
}

async function rotateBoardAccess() {
  await stopChild("board-proxy");
  if (boardAccess?.accessId) {
    await runCliCapture([
      "board",
      "access",
      "revoke",
      boardAccess.accessId
    ]).catch(() => undefined);
  }
  const output = await runCliCapture([
    "board",
    "access",
    "issue",
    "--ttl-minutes",
    "1440"
  ]);
  const accessId = readOutputValue(output, "access_id");
  const accessToken = readOutputValue(output, "access_token");
  const expiresAt = readOutputValue(output, "expires_at");
  boardAccess = { accessId, accessToken, expiresAt };
  launch({
    name: "board-proxy",
    command: process.execPath,
    args: [path.join(scriptDirectory, "t174-tailscale-board-proxy.mjs")],
    env: {
      KAIRON_T174_BOARD_PROXY_PORT: "18779",
      KAIRON_T174_BOARD_UPSTREAM: "http://127.0.0.1:18778/",
      KAIRON_T174_BOARD_EXTERNAL_URL: boardExternalUrl.toString(),
      KAIRON_T174_BOARD_TOKEN: accessToken
    }
  });
  await writeStatus("running");
}

function launch(specification) {
  const record = children.get(specification.name) ?? {
    restarts: 0,
    restartEnabled: true
  };
  record.specification = specification;
  record.restartEnabled = true;
  const child = spawn(specification.command, specification.args, {
    cwd: projectRoot,
    env: { ...process.env, ...(specification.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  record.child = child;
  record.startedAt = new Date().toISOString();
  children.set(specification.name, record);
  pipeLog(specification.name, child.stdout);
  pipeLog(specification.name, child.stderr);
  child.on("exit", (code, signal) => {
    void appendLog(
      specification.name,
      `process_exit code=${code ?? "none"} signal=${signal ?? "none"}`
    );
    if (shuttingDown || !record.restartEnabled || record.child !== child) {
      return;
    }
    record.restarts += 1;
    setTimeout(() => launch(specification), restartDelayMs);
  });
  child.on("error", (error) => void recordError(specification.name, error));
}

async function stopChild(name) {
  const record = children.get(name);
  if (!record?.child || record.child.exitCode !== null) {
    return;
  }
  record.restartEnabled = false;
  record.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => record.child.once("exit", resolve)),
    delay(5_000)
  ]);
  if (record.child.exitCode === null) {
    record.child.kill();
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(rotationTimer);
  clearInterval(heartbeatTimer);
  clearInterval(stopRequestTimer);
  await writeStatus("stopping", { signal });
  await Promise.all([...children.keys()].map(stopChild));
  if (boardAccess?.accessId) {
    await runCliCapture([
      "board",
      "access",
      "revoke",
      boardAccess.accessId
    ]).catch(() => undefined);
  }
  await writeStatus("stopped", { signal });
  await rm(stopRequestPath, { force: true });
  process.exit(0);
}

async function checkStopRequest() {
  try {
    await readFile(stopRequestPath, "utf8");
    await shutdown("stop_request");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      await recordError("stop-request", error);
    }
  }
}

async function requestSupervisorStop(timeoutMs) {
  let status;
  try {
    status = JSON.parse(await readFile(statusPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.log("remote_supervisor.status=not_running");
      return;
    }
    throw error;
  }

  if (status.status === "stopped") {
    console.log("remote_supervisor.status=stopped");
    return;
  }
  if (!Number.isInteger(status.supervisor_pid) || !processExists(status.supervisor_pid)) {
    throw new Error(
      "Remote supervisor status does not identify a live stoppable process. " +
      "Clean up the legacy residual process tree before retrying."
    );
  }

  await writeFile(
    stopRequestPath,
    `${JSON.stringify({
      schema_version: "0.1",
      requested_at: new Date().toISOString(),
      requested_by_pid: process.pid
    }, null, 2)}\n`,
    "utf8"
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(250);
    try {
      const current = JSON.parse(await readFile(statusPath, "utf8"));
      if (current.status === "stopped") {
        console.log("remote_supervisor.status=stopped");
        return;
      }
    } catch {
      // The supervisor may be replacing the status file atomically.
    }
  }
  throw new Error(`Remote supervisor did not stop within ${timeoutMs}ms.`);
}

async function revokePreviousBoardAccess() {
  try {
    const previous = JSON.parse(await readFile(statusPath, "utf8"));
    if (previous.board_access_id) {
      await runCliCapture([
        "board",
        "access",
        "revoke",
        previous.board_access_id
      ]).catch(() => undefined);
    }
  } catch {
    // A missing or stale supervisor status must not prevent recovery.
  }
}

async function runCliCapture(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Kairon command failed with exit code ${code}: ${stderr.trim()}`));
    });
  });
}

async function writeStatus(status, extra = {}) {
  const write = statusWriteQueue.then(() => writeStatusAtomic(status, extra));
  statusWriteQueue = write.catch(() => undefined);
  return write;
}

async function writeStatusAtomic(status, extra = {}) {
  const value = {
    schema_version: "0.1",
    artifact_kind: "t199_remote_supervisor_status",
    status,
    supervisor_pid: process.pid,
    project_root: "configured",
    services: Object.fromEntries(
      [...children.entries()].map(([name, record]) => [
        name,
        {
          pid: record.child?.pid ?? null,
          running: record.child?.exitCode === null,
          restarts: record.restarts,
          started_at: record.startedAt
        }
      ])
    ),
    board_access_id: boardAccess?.accessId ?? null,
    board_access_expires_at: boardAccess?.expiresAt ?? null,
    updated_at: new Date().toISOString(),
    ...extra
  };
  const temporary = `${statusPath}.tmp-${process.pid}-${statusWriteSequence++}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await renameStatusFile(temporary, statusPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function renameStatusFile(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (
        !["EACCES", "EBUSY", "EPERM"].includes(error?.code) ||
        attempt >= statusRenameRetryDelaysMs.length
      ) {
        throw error;
      }
      await delay(statusRenameRetryDelaysMs[attempt]);
    }
  }
}

function pipeLog(name, stream) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => void appendLog(name, chunk.trimEnd()));
}

async function appendLog(name, message) {
  if (!message) return;
  const line = `${new Date().toISOString()} ${message}\n`;
  await appendFile(path.join(logRoot, `${name}.log`), line, "utf8");
}

async function recordError(component, error) {
  const message = String(error?.message ?? error).replace(/[\r\n]+/gu, " ").slice(0, 500);
  await appendLog(component, `error=${message}`);
  await writeStatus("degraded", { component, error: message }).catch(async (statusError) => {
    const statusMessage = String(statusError?.message ?? statusError)
      .replace(/[\r\n]+/gu, " ")
      .slice(0, 500);
    await appendLog(component, `status_error=${statusMessage}`).catch(() => undefined);
  });
}

function resolveProjectRoot(args) {
  const index = args.indexOf("--project-root");
  if (index < 0 || !args[index + 1]) {
    throw new Error("--project-root is required.");
  }
  return path.resolve(args[index + 1]);
}

function readIntegerArgument(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number.parseInt(args[index + 1] ?? "", 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function requireEnvironment(names) {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing user environment: ${missing.join(",")}`);
  }
}

function requireHttpsUrl(name, value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${name} must be HTTPS.`);
  return url;
}

function readOutputValue(output, name) {
  const match = output.match(new RegExp(`^${name}=(.+)$`, "mu"));
  if (!match) throw new Error(`Kairon output is missing ${name}.`);
  return match[1].trim();
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error(`Loopback port is already in use: ${port}`)));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
