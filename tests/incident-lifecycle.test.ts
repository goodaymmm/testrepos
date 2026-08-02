import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "../src/approvals/approval-queue.js";
import { renderBoardHtml } from "../src/board/html.js";
import { createBoardProjection } from "../src/board/projection.js";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  acknowledgeIncidentLifecycle,
  executeIncidentRecovery,
  planIncidentRecovery,
  reconcileIncidentSources,
  resolveIncidentLifecycle
} from "../src/incidents/lifecycle.js";
import {
  attachIncidentResource,
  getIncident,
  readIncidentTimeline,
  resolveIncident,
  updateIncidentResource
} from "../src/incidents/store.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { createTempProject } from "./test-utils.js";

describe("incident lifecycle", () => {
  it("deduplicates attached resources and reopens a resolved recurrence", async () => {
    const root = await createProject();
    const first = await attachIncidentResource(root, {
      fingerprint: "watchdog:queue-backlog",
      severity: "high",
      title: "Queue backlog",
      summary: "Ready queue exceeded the threshold.",
      resource: {
        kind: "watchdog_alert",
        id: "ALT-0001",
        status: "open",
        artifactPath: ".kairon/watchdog/alerts/ALT-0001.json"
      },
      now: new Date("2026-07-23T00:00:00.000Z")
    });
    const duplicate = await attachIncidentResource(root, {
      fingerprint: "watchdog:queue-backlog",
      severity: "high",
      title: "Queue backlog",
      summary: "Ready queue exceeded the threshold.",
      resource: {
        kind: "watchdog_alert",
        id: "ALT-0001",
        status: "open",
        artifactPath: ".kairon/watchdog/alerts/ALT-0001.json"
      },
      now: new Date("2026-07-23T00:00:01.000Z")
    });

    expect(duplicate).toEqual(first);
    expect(await readIncidentTimeline(root, first.incident_id)).toHaveLength(1);

    await updateIncidentResource(root, {
      kind: "watchdog_alert",
      id: "ALT-0001",
      status: "resolved",
      now: new Date("2026-07-23T00:01:00.000Z")
    });
    await resolveIncident(root, first.incident_id, "source alert cleared", {
      now: new Date("2026-07-23T00:01:01.000Z")
    });
    const reopened = await attachIncidentResource(root, {
      fingerprint: "watchdog:queue-backlog",
      severity: "critical",
      title: "Queue backlog",
      summary: "Ready queue exceeded the threshold again.",
      resource: {
        kind: "watchdog_alert",
        id: "ALT-0001",
        status: "open",
        artifactPath: ".kairon/watchdog/alerts/ALT-0001.json"
      },
      now: new Date("2026-07-23T00:02:00.000Z")
    });

    expect(reopened).toMatchObject({
      incident_id: first.incident_id,
      status: "open",
      severity: "critical",
      recurrence_count: 1
    });
    expect(
      (await readIncidentTimeline(root, first.incident_id)).map(
        (event) => event.event
      )
    ).toContain("incident.reopened");
  });

  it("keeps acknowledged incidents active until recovery sources clear", async () => {
    const fixture = await createExpiredClaim(false);
    const [incident] = await reconcileIncidentSources(fixture.root, {
      now: fixture.expiredAt
    });

    const acknowledged = await acknowledgeIncidentLifecycle(
      fixture.root,
      incident!.incident_id,
      "operator has reviewed the incident",
      { now: new Date("2026-07-23T00:00:03.000Z") }
    );

    expect(acknowledged.status).toBe("acknowledged");
    expect(acknowledged.resources).toContainEqual(
      expect.objectContaining({ kind: "recovery_target", status: "open" })
    );
    await expect(
      resolveIncidentLifecycle(
        fixture.root,
        incident!.incident_id,
        "incorrect early resolution",
        { now: new Date("2026-07-23T00:00:04.000Z") }
      )
    ).rejects.toThrow(/active issues remain/u);
  });

  it("executes one approved exact plan and resolves the recovered incident", async () => {
    const fixture = await createExpiredClaim(false);
    const [incident] = await reconcileIncidentSources(fixture.root, {
      now: fixture.expiredAt
    });
    const plan = await planIncidentRecovery(fixture.root, incident!.incident_id, {
      now: fixture.expiredAt
    });
    await new ApprovalQueue(fixture.root, {
      now: () => new Date("2026-07-23T00:00:03.000Z")
    }).decide({
      approvalId: plan.approval_id,
      action: "approve",
      reason: "safe queue requeue approved"
    });

    const executed = await executeIncidentRecovery(
      fixture.root,
      incident!.incident_id,
      {
        approvalId: plan.approval_id,
        confirm: plan.plan_id,
        now: new Date("2026-07-23T00:00:04.000Z")
      }
    );

    expect(executed).toMatchObject({
      status: "completed",
      remaining_fingerprints: []
    });
    expect(await fixture.queue.list("ready")).toContainEqual(
      expect.objectContaining({ id: fixture.itemId, status: "ready" })
    );
    await expect(
      executeIncidentRecovery(fixture.root, incident!.incident_id, {
        approvalId: plan.approval_id,
        confirm: plan.plan_id,
        now: new Date("2026-07-23T00:00:05.000Z")
      })
    ).rejects.toThrow(/already executed/u);

    const resolved = await resolveIncidentLifecycle(
      fixture.root,
      incident!.incident_id,
      "recovery verification passed",
      { now: new Date("2026-07-23T00:00:06.000Z") }
    );
    expect(resolved.status).toBe("resolved");
  });

  it("rejects stale plans and freshness changes", async () => {
    const staleFixture = await createExpiredClaim(false);
    const [staleIncident] = await reconcileIncidentSources(staleFixture.root, {
      now: staleFixture.expiredAt
    });
    const stalePlan = await planIncidentRecovery(
      staleFixture.root,
      staleIncident!.incident_id,
      { now: staleFixture.expiredAt }
    );
    await new ApprovalQueue(staleFixture.root).decide({
      approvalId: stalePlan.approval_id,
      action: "approve",
      reason: "approval should expire with the plan"
    });
    await expect(
      executeIncidentRecovery(staleFixture.root, staleIncident!.incident_id, {
        approvalId: stalePlan.approval_id,
        confirm: stalePlan.plan_id,
        now: new Date("2026-07-23T00:31:00.000Z")
      })
    ).rejects.toThrow(/plan is stale/u);

    const changedFixture = await createExpiredClaim(false);
    const [changedIncident] = await reconcileIncidentSources(changedFixture.root, {
      now: changedFixture.expiredAt
    });
    const changedPlan = await planIncidentRecovery(
      changedFixture.root,
      changedIncident!.incident_id,
      { now: changedFixture.expiredAt }
    );
    await new ApprovalQueue(changedFixture.root).decide({
      approvalId: changedPlan.approval_id,
      action: "approve",
      reason: "source freshness test"
    });
    await changedFixture.queue.requeueClaim(changedFixture.itemId, {
      now: new Date("2026-07-23T00:00:03.000Z")
    });
    await expect(
      executeIncidentRecovery(changedFixture.root, changedIncident!.incident_id, {
        approvalId: changedPlan.approval_id,
        confirm: changedPlan.plan_id,
        now: new Date("2026-07-23T00:00:04.000Z")
      })
    ).rejects.toThrow(/freshness check failed/u);
  });

  it("records partial recovery when an ambiguous target still needs approval", async () => {
    const fixture = await createExpiredClaim(true);
    const [incident] = await reconcileIncidentSources(fixture.root, {
      now: fixture.expiredAt
    });
    const plan = await planIncidentRecovery(fixture.root, incident!.incident_id, {
      now: fixture.expiredAt
    });
    await new ApprovalQueue(fixture.root).decide({
      approvalId: plan.approval_id,
      action: "approve",
      reason: "assisted recovery approved"
    });

    const executed = await executeIncidentRecovery(
      fixture.root,
      incident!.incident_id,
      {
        approvalId: plan.approval_id,
        confirm: plan.plan_id,
        now: new Date("2026-07-23T00:00:04.000Z")
      }
    );

    expect(executed.status).toBe("partial");
    expect(executed.remaining_fingerprints).toHaveLength(1);
    expect((await getIncident(fixture.root, incident!.incident_id)).recovery).toMatchObject({
      status: "partial",
      verification_status: "passed"
    });
    expect(
      (await new ApprovalQueue(fixture.root).list({ status: "all" })).filter(
        (approval) => approval.type === "runtime_recovery"
      )
    ).toHaveLength(1);
    const retry = await planIncidentRecovery(
      fixture.root,
      incident!.incident_id,
      { now: new Date("2026-07-23T00:00:06.000Z") }
    );
    expect(retry.plan_id).not.toBe(plan.plan_id);
    expect(retry.approval_id).not.toBe(plan.approval_id);
  });

  it("projects active incidents onto the read-only Board", async () => {
    const root = await createProject();
    await attachIncidentResource(root, {
      fingerprint: "watchdog:provider-suspended",
      severity: "warning",
      title: "Provider suspended",
      summary: "One provider requires operator review.",
      resource: {
        kind: "watchdog_alert",
        id: "ALT-0001",
        status: "open"
      }
    });

    const projection = await createBoardProjection(root);
    const html = renderBoardHtml(projection);

    expect(projection.incidents).toMatchObject({
      total: 1,
      active: 1,
      by_status: { open: 1 }
    });
    expect(projection.operations.active_incidents).toBe(1);
    expect(projection.operations.priority).toContainEqual(
      expect.objectContaining({ kind: "incident", id: "INC-0001" })
    );
    expect(html).toContain('id="incidents"');
    expect(html).toContain("INC-0001");
  });
});

async function createProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}

async function createExpiredClaim(codeProducing: boolean): Promise<{
  root: string;
  queue: WorkQueue;
  itemId: string;
  expiredAt: Date;
}> {
  const root = await createProject();
  const queue = new WorkQueue(root);
  const item = await queue.enqueue({
    type: "agent.run",
    payload: {
      persona: "implementer",
      code_producing: codeProducing
    }
  });
  await queue.claimById(item.id, "worker-1", {
    now: new Date("2026-07-23T00:00:00.000Z"),
    claimTtlMs: 1000
  });
  return {
    root,
    queue,
    itemId: item.id,
    expiredAt: new Date("2026-07-23T00:00:02.000Z")
  };
}
