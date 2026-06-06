import type {
  BoardApprovalSummary,
  BoardCleanupProposalSummary,
  BoardProjection,
  BoardQueueItemSummary,
  BoardReviewLoopSummary,
  BoardReviewResultSummary,
  BoardRunSummary,
  BoardTaskSummary
} from "./projection.js";

export function renderBoardHtml(projection: BoardProjection): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kairon Board</title>
  <style>
    :root { color-scheme: light; font-family: Arial, sans-serif; }
    body { margin: 0; color: #202124; background: #f7f8fa; }
    header { padding: 24px 32px; background: #ffffff; border-bottom: 1px solid #d9dee7; }
    main { padding: 24px 32px 40px; display: grid; gap: 24px; }
    h1, h2 { margin: 0; }
    h1 { font-size: 28px; }
    h2 { font-size: 18px; }
    .meta { margin-top: 8px; color: #5f6673; font-size: 13px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
    .stat, section { background: #ffffff; border: 1px solid #d9dee7; border-radius: 8px; }
    .stat { padding: 14px 16px; }
    .label { color: #5f6673; font-size: 12px; text-transform: uppercase; }
    .value { margin-top: 6px; font-size: 24px; font-weight: 700; }
    section { overflow: hidden; }
    section h2 { padding: 16px 18px; border-bottom: 1px solid #e6e9ef; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #edf0f5; vertical-align: top; }
    th { color: #5f6673; background: #fbfcfe; font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    a { color: #2457c5; text-decoration: none; }
    code { font-family: Consolas, monospace; font-size: 12px; }
    .empty { padding: 14px 18px; color: #5f6673; }
  </style>
</head>
<body>
  <header>
    <h1>Kairon Board</h1>
    <div class="meta">generated_at=${escapeHtml(projection.generated_at)} | projection=<a href="/projection.json">projection.json</a></div>
  </header>
  <main>
    <div class="stats">
      ${stat("Schedule", projection.runtime.schedule.mode)}
      ${stat("Queue Ready", String(projection.queue.ready))}
      ${stat("Approvals Pending", String(projection.approvals.pending))}
      ${stat("Runs", String(projection.runs.total))}
      ${stat("Tasks", String(projection.tasks.total))}
      ${stat("Review Loops", String(projection.reviews.loops_total))}
    </div>
    ${renderTasks(projection.tasks.recent)}
    ${renderQueue(projection.queue.recent)}
    ${renderApprovals(projection.approvals.recent)}
    ${renderRuns(projection.runs.recent)}
    ${renderReviews(projection.reviews.recent_loops, projection.reviews.recent_results)}
    ${renderCleanup(projection.cleanup.recent)}
  </main>
</body>
</html>`;
}

function stat(label: string, value: string): string {
  return `<div class="stat"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
}

function renderTasks(tasks: BoardTaskSummary[]): string {
  return section(
    "Tasks",
    ["ID", "Status", "Title", "Persona", "Updated"],
    tasks.map((task) => [
      code(task.id),
      text(task.status),
      text(task.title),
      text(task.persona),
      text(task.updated_at ?? task.created_at)
    ])
  );
}

function renderQueue(items: BoardQueueItemSummary[]): string {
  return section(
    "Queue",
    ["ID", "Type", "Status", "Task", "Attempts", "Updated"],
    items.map((item) => [
      code(item.id),
      text(item.type),
      text(item.status),
      text(item.task_id),
      text(String(item.attempts)),
      text(item.updated_at ?? item.created_at)
    ])
  );
}

function renderApprovals(approvals: BoardApprovalSummary[]): string {
  return section(
    "Approvals",
    ["ID", "Status", "Type", "Title", "Task", "Updated"],
    approvals.map((approval) => [
      `<a id="${approvalAnchor(approval.id)}" href="#${approvalAnchor(approval.id)}">${escapeHtml(approval.id)}</a>`,
      text(approval.status),
      text(approval.type),
      text(approval.title),
      text(approval.task_id),
      text(approval.updated_at ?? approval.created_at)
    ])
  );
}

function renderRuns(runs: BoardRunSummary[]): string {
  return section(
    "Runs",
    ["Run", "Task", "Agent", "Status", "Exit", "Finished"],
    runs.map((run) => [
      code(run.run_id),
      text(run.task_id),
      text(run.agent),
      text(run.status ?? run.outbox_status),
      text(run.exit_code === undefined ? undefined : String(run.exit_code)),
      text(run.finished_at ?? run.created_at)
    ])
  );
}

function renderReviews(
  loops: BoardReviewLoopSummary[],
  results: BoardReviewResultSummary[]
): string {
  const loopRows = loops.map((loop) => [
    code(loop.loop_id),
    text(loop.task_id),
    text(loop.status),
    text(loop.iteration === undefined ? undefined : String(loop.iteration)),
    text(loop.updated_at ?? loop.created_at)
  ]);
  const resultRows = results.map((result) => [
    code(result.review_id),
    text(result.run_id),
    text(result.status),
    text(result.score === undefined ? undefined : String(result.score)),
    text(result.highest_severity),
    text(result.created_at)
  ]);

  return `${section("Review Loops", ["Loop", "Task", "Status", "Iteration", "Updated"], loopRows)}
${section("Review Results", ["Review", "Run", "Status", "Score", "Highest Severity", "Created"], resultRows)}`;
}

function renderCleanup(proposals: BoardCleanupProposalSummary[]): string {
  return section(
    "Cleanup",
    ["Date", "Candidates", "Direct Delete", "Created"],
    proposals.map((proposal) => [
      text(proposal.date),
      text(String(proposal.candidate_count)),
      text(String(proposal.direct_delete ?? false)),
      text(proposal.created_at)
    ])
  );
}

function section(title: string, headers: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return `<section><h2>${escapeHtml(title)}</h2><div class="empty">No items</div></section>`;
  }

  return `<section><h2>${escapeHtml(title)}</h2><table><thead><tr>${headers
    .map((header) => `<th>${escapeHtml(header)}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></section>`;
}

function text(value: string | undefined): string {
  return escapeHtml(value ?? "-");
}

function code(value: string | undefined): string {
  return `<code>${escapeHtml(value ?? "-")}</code>`;
}

function approvalAnchor(approvalId: string): string {
  return `approval-${escapeAttribute(approvalId)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/[^A-Za-z0-9_-]/g, "-");
}
