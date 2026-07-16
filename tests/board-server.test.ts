import path from "node:path";
import { describe, expect, it } from "vitest";
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
});
