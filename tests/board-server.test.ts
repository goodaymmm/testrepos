import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  issuePersistentBoardAccess,
  revokePersistentBoardAccess
} from "../src/board/access-token.js";
import { readJsonLines } from "../src/core/fs/jsonl-file.js";
import { startBoardServer } from "../src/board/server.js";
import { renderBoardHtml } from "../src/board/html.js";
import { createBoardProjection } from "../src/board/projection.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { TaskRunner } from "../src/tasks/task-runner.js";
import { WorkflowControls } from "../src/workflow/controls.js";
import { ProductionWorkflowRuntime } from "../src/workflow/runtime.js";
import { createTempProject } from "./test-utils.js";

describe("Board workflow observability", () => {
  it("renders workflow progress, blocker, retry count, and latest event", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeJsonFileAtomic(path.join(root, ".kairon", "config", "schedule.json"), {
      schema_version: "0.1",
      timezone: "UTC",
      active_work_time: [{ start: "00:00", end: "23:59" }],
      standby_work_time: [],
      maintenance_time: []
    });
    const task = await new TaskRunner(root).createTask({
      title: "Board workflow",
      persona: "researcher"
    });
    const env = { KAIRON_WORKFLOW_RUNTIME: "1" };
    await new ProductionWorkflowRuntime(root, { env }).run({
      workflowId: "WF-0152-BOARD",
      taskId: task.task_id
    });
    await new WorkflowControls(root, { env }).pause(
      "WF-0152-BOARD",
      "board inspection"
    );

    const projection = await createBoardProjection(root);
    const html = renderBoardHtml(projection);

    expect(projection.workflows).toMatchObject({
      total: 1,
      by_status: { paused: 1 },
      attention: 1,
      recent: [
        {
          workflow_id: "WF-0152-BOARD",
          status: "paused",
          current_node: `task_${task.task_id}`,
          progress_completed: 1,
          progress_total: 2,
          blocker: "board inspection",
          retry_count: 0,
          control_mode: "paused",
          last_event: { action: "pause", status_after: "paused" }
        }
      ]
    });
    expect(projection.operations).toMatchObject({
      workflow_attention: 1,
      attention_total: 1
    });
    expect(html).toContain('href="#workflows"');
    expect(html).toContain('id="workflows"');
    expect(html).toContain('id="workflow-WF-0152-BOARD"');
    expect(html).toContain("pause (paused)");
  });

  it("renders a secret-free approval and Discord correlation timeline", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeJsonFileAtomic(path.join(root, ".kairon", "approvals", "APR-T155.json"), {
      schema_version: "0.1",
      id: "APR-T155",
      status: "pending",
      type: "git_push",
      title: "Correlation token=SHOULD-NOT-LEAK",
      actions: ["approve", "reject"],
      discord: {
        channel_id: "333333333333333333",
        message_id: "discord-message-t155"
      },
      created_at: "2026-07-16T01:00:00.000Z",
      updated_at: "2026-07-16T01:00:00.000Z"
    });

    const projection = await createBoardProjection(root);
    const html = renderBoardHtml(projection);

    expect(projection.correlations).toMatchObject({
      total: 1,
      attention: 0,
      recent: [
        expect.objectContaining({
          status: "pending",
          approval_id: "APR-T155",
          member_count: 1
        })
      ]
    });
    const correlationId = projection.correlations.recent[0]?.correlation_id;
    expect(correlationId).toMatch(/^COR-\d{6}$/u);
    expect(html).toContain('href="#correlations"');
    expect(html).toContain('id="correlations"');
    expect(html).toContain(String(correlationId));
    expect(JSON.stringify(projection)).not.toContain("SHOULD-NOT-LEAK");
    expect(html).not.toContain("SHOULD-NOT-LEAK");
  });
});

describe("remote read-only Board", () => {
  it("requires proxy, origin, identity, and persistent access while blocking writes", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeJsonFileAtomic(path.join(root, ".kairon", "approvals", "APR-T154.json"), {
      schema_version: "0.1",
      id: "APR-T154",
      status: "pending",
      type: "deploy",
      title: "Remote Board approval",
      actions: ["approve", "reject"],
      rollback_hint: "git revert SHOULD-NOT-REACH-REMOTE",
      local_command_hint: "kairon approval decide SHOULD-NOT-REACH-REMOTE",
      created_at: "2026-07-16T00:00:00.000Z",
      updated_at: "2026-07-16T00:00:00.000Z"
    });
    const token = "remote-board-server-token-abcdefghijklmnopqrstuvwxyz0123456789";
    const issued = await issuePersistentBoardAccess(root, {
      now: new Date("2026-07-16T00:00:00.000Z"),
      ttlMinutes: 15,
      randomToken: () => token,
      accessId: "BOARD-ACCESS-T154-SERVER"
    });
    const server = await startBoardServer(root, {
      profile: "remote-readonly",
      port: 0,
      externalBaseUrl: "https://board.example.test/",
      trustedProxies: ["127.0.0.1/32", "::1/128"],
      allowedOrigins: ["https://board.example.test"],
      identityHeader: "x-kairon-verified-identity",
      rateLimitPerMinute: 2,
      now: () => new Date("2026-07-16T00:05:00.000Z")
    });
    const proxyHeaders = {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "board.example.test",
      origin: "https://board.example.test",
      "x-kairon-verified-identity": "operator@example.test",
      authorization: `Bearer ${token}`
    };

    try {
      expect(server).toMatchObject({
        profile: "remote-readonly",
        external_url: "https://board.example.test/",
        audit_path: ".kairon/audit/board-access.jsonl"
      });
      expect(await fetch(server.board_url)).toMatchObject({ status: 400 });
      expect(
        await fetch(server.board_url, {
          headers: {
            ...proxyHeaders,
            origin: "https://evil.example.test"
          }
        })
      ).toMatchObject({ status: 403 });
      const { "x-kairon-verified-identity": _identity, ...withoutIdentity } =
        proxyHeaders;
      expect(
        await fetch(server.board_url, { headers: withoutIdentity })
      ).toMatchObject({ status: 401 });
      const { authorization: _authorization, ...withoutToken } = proxyHeaders;
      expect(
        await fetch(server.board_url, { headers: withoutToken })
      ).toMatchObject({ status: 401 });

      const htmlResponse = await fetch(server.board_url, { headers: proxyHeaders });
      expect(htmlResponse.status).toBe(200);
      const html = await htmlResponse.text();
      expect(html).toContain("view=remote-read-only");
      expect(html).not.toContain("Local CLI");
      expect(html).not.toContain("SHOULD-NOT-REACH-REMOTE");

      const projectionResponse = await fetch(`${server.board_url}projection.json`, {
        headers: proxyHeaders
      });
      expect(projectionResponse.status).toBe(200);
      const projectionText = await projectionResponse.text();
      expect(projectionText).not.toContain("local_command_hint");
      expect(projectionText).not.toContain("rollback_hint");
      expect(projectionText).not.toContain(token);

      expect(
        await fetch(server.board_url, { headers: proxyHeaders })
      ).toMatchObject({ status: 429 });
      expect(
        await fetch(server.board_url, { method: "POST", headers: proxyHeaders })
      ).toMatchObject({ status: 405 });

      await revokePersistentBoardAccess(
        root,
        issued.access_id,
        new Date("2026-07-16T00:06:00.000Z")
      );
      expect(
        await fetch(server.board_url, { headers: proxyHeaders })
      ).toMatchObject({ status: 401 });
    } finally {
      await server.stop();
    }

    const audit = await readJsonLines<Record<string, unknown>>(
      path.join(root, ".kairon", "audit", "board-access.jsonl")
    );
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          client: "remote",
          profile: "remote-readonly",
          auth_status: "accepted",
          proxy_status: "accepted",
          origin_status: "accepted",
          rate_limited: true
        }),
        expect.objectContaining({
          proxy_status: "forwarded_headers_required",
          http_status: 400
        })
      ])
    );
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain(token);
    expect(auditText).not.toContain("operator@example.test");
    expect(auditText).not.toMatch(/authorization|cookie/i);
  });

  it("rejects requests from a proxy outside the trusted CIDRs", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const server = await startBoardServer(root, {
      profile: "remote-readonly",
      port: 0,
      externalBaseUrl: "https://board.example.test/",
      trustedProxies: ["10.0.0.0/8"],
      allowedOrigins: ["https://board.example.test"]
    });
    try {
      const response = await fetch(server.board_url, {
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "board.example.test",
          origin: "https://board.example.test"
        }
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        reason: "untrusted_proxy"
      });
    } finally {
      await server.stop();
    }
  });
});
