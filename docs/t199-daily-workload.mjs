import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  decideApprovalCommand,
  seedApprovalCommand
} from "../dist/cli/commands/approval.js";
import { metricsSloCheckCommand } from "../dist/cli/commands/metrics.js";
import { runRemoteDoctorCommand } from "../dist/cli/commands/remote.js";
import { WorkQueue } from "../dist/queue/work-queue.js";
import { createT199ApprovalId } from "./t199-soak-identifiers.mjs";

const remoteProbeIntervalMs = 30_000;

const projectRoot = resolveProjectRoot(process.argv.slice(2));
const runtimeRoot = path.join(projectRoot, ".kairon", "runtime");
const lockPath = path.join(runtimeRoot, "t199-daily-workload.lock");
const statusPath = path.join(runtimeRoot, "t199-daily-workload.json");
const date = localDateKey(new Date());
const soakId = await readActiveSoakId(projectRoot);
let lock;

await mkdir(runtimeRoot, { recursive: true });
try {
  lock = await open(lockPath, "wx");
} catch (error) {
  if (error.code === "EEXIST") {
    console.log("status=skipped");
    console.log("reason=daily_workload_already_running");
    process.exit(0);
  }
  throw error;
}

const startedAt = new Date();
const result = {
  schema_version: "0.1",
  artifact_kind: "t199_daily_workload",
  date,
  soak_id: soakId,
  status: "running",
  started_at: startedAt.toISOString(),
  queue_items: [],
  approvals: [],
  remote_probes: [],
  slo: null
};

try {
  await writeStatus();
  const queue = new WorkQueue(projectRoot);
  for (let index = 1; index <= 5; index += 1) {
    const idempotencyKey = `t199:${soakId}:${date}:runtime-health:${index}`;
    const existing = (await queue.list()).find(
      (item) => item.idempotency_key === idempotencyKey
    );
    if (existing) {
      result.queue_items.push({ id: existing.id, created: false });
      continue;
    }
    const enqueued = await queue.enqueueIdempotent({
      type: "health.check",
      priority: 20,
      idempotency_key: idempotencyKey,
      schedule_mode: "standby_work",
      payload: {
        check: "runtime_status"
      },
      test_scope: {
        kind: "operation_test",
        tags: ["t199-soak", date],
        expires_at: new Date(Date.now() + 48 * 60 * 60 * 1_000).toISOString()
      }
    });
    result.queue_items.push({ id: enqueued.item.id, created: true });
  }

  for (let index = 1; index <= 5; index += 1) {
    const approvalId = createT199ApprovalId(soakId, date, index);
    const approvalPath = path.join(
      projectRoot,
      ".kairon",
      "approvals",
      `${approvalId}.json`
    );
    let exists = false;
    try {
      await readFile(approvalPath, "utf8");
      exists = true;
    } catch {}
    if (!exists) {
      await seedApprovalCommand(projectRoot, approvalId, {
        title: `T199 daily notification sample ${date} ${index}`,
        actions: "approve,reject"
      });
    }
    result.approvals.push({ id: approvalId, created: !exists });
  }

  for (let index = 1; index <= 3; index += 1) {
    const output = await runRemoteDoctorCommand(projectRoot, { format: "json" });
    const probe = JSON.parse(output);
    result.remote_probes.push({
      discord: probe.discord?.external_readiness ?? "unknown",
      discord_attempts: probe.discord?.probe?.attempts ?? 0,
      discord_failure_category:
        probe.discord?.probe?.failure_category ?? "none",
      board: probe.board?.external_readiness ?? "unknown",
      board_attempts: probe.board?.probe?.attempts ?? 0,
      board_failure_category: probe.board?.probe?.failure_category ?? "none"
    });
    if (index < 3) {
      await delay(remoteProbeIntervalMs);
    }
  }

  await waitForNotifications(projectRoot, result.approvals.map((item) => item.id));
  await cleanupPendingApprovals(
    projectRoot,
    result.approvals.map((approval) => approval.id),
    "T199 daily notification sample completed"
  );

  const queueRecords = await waitForQueue(
    queue,
    result.queue_items.map((item) => item.id)
  );
  const failedQueueItems = queueRecords.filter((item) => item.status === "failed");
  if (failedQueueItems.length > 0) {
    throw new Error(
      `Runtime health queue failed: ${failedQueueItems.map((item) => item.id).join(",")}`
    );
  }
  result.slo = parseKeyValues(await metricsSloCheckCommand(projectRoot));
  result.status = "completed";
  result.completed_at = new Date().toISOString();
  await writeStatus();
  console.log("status=completed");
  console.log(`date=${date}`);
  console.log(`queue_items=${result.queue_items.length}`);
  console.log(`approvals=${result.approvals.length}`);
  console.log(`remote_probes=${result.remote_probes.length}`);
} catch (error) {
  result.status = "failed";
  result.error = String(error?.message ?? error).replace(/[\r\n]+/gu, " ").slice(0, 500);
  try {
    await cleanupPendingApprovals(
      projectRoot,
      result.approvals.map((approval) => approval.id),
      "T199 daily notification sample cleanup after workload failure"
    );
  } catch (cleanupError) {
    result.cleanup_error = String(cleanupError?.message ?? cleanupError)
      .replace(/[\r\n]+/gu, " ")
      .slice(0, 500);
  }
  result.completed_at = new Date().toISOString();
  await writeStatus();
  console.error("status=failed");
  console.error(`reason=${result.error}`);
  process.exitCode = 2;
} finally {
  await lock.close();
  await rm(lockPath, { force: true });
}

async function waitForNotifications(root, approvalIds) {
  const deadline = Date.now() + 20 * 60 * 1_000;
  while (Date.now() < deadline) {
    const records = await Promise.all(approvalIds.map((id) => readApproval(root, id)));
    if (records.every((record) => record.discord?.notified_at)) return;
    await delay(10_000);
  }
  throw new Error("Discord approval notifications did not complete within 20 minutes.");
}

async function waitForQueue(queue, itemIds) {
  const deadline = Date.now() + 45 * 60 * 1_000;
  while (Date.now() < deadline) {
    const state = await queue.list();
    const records = itemIds.map((id) => state.find((item) => item.id === id));
    if (records.every((item) => item && ["completed", "failed"].includes(item.status))) {
      return records;
    }
    await delay(15_000);
  }
  throw new Error("Runtime health queue did not complete within 45 minutes.");
}

async function cleanupPendingApprovals(root, approvalIds, reason) {
  for (const approvalId of approvalIds) {
    const record = await readApproval(root, approvalId);
    if (record.status === "pending" || record.status === "snoozed") {
      await decideApprovalCommand(root, approvalId, {
        action: "reject",
        reason
      });
    }
  }
}

async function readApproval(root, approvalId) {
  return JSON.parse(
    await readFile(
      path.join(root, ".kairon", "approvals", `${approvalId}.json`),
      "utf8"
    )
  );
}

async function writeStatus() {
  await writeFile(statusPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function resolveProjectRoot(args) {
  const index = args.indexOf("--project-root");
  if (index < 0 || !args[index + 1]) throw new Error("--project-root is required.");
  return path.resolve(args[index + 1]);
}

function parseKeyValues(output) {
  return Object.fromEntries(
    output
      .split(/\r?\n/u)
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

function localDateKey(now) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function readActiveSoakId(root) {
  const latestPath = path.join(root, ".kairon", "runtime", "soak", "latest.json");
  const latest = JSON.parse(await readFile(latestPath, "utf8"));
  if (typeof latest.soak_id !== "string" || !latest.soak_id.startsWith("SSK-")) {
    throw new Error("Active Stable soak id is unavailable.");
  }
  return latest.soak_id;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
