import type {
  BoardApprovalFollowUpSummary,
  BoardApprovalCheckSummary,
  BoardApprovalRelatedArtifact,
  BoardApprovalRequiredApprovalSummary,
  BoardApprovalSummary,
  BoardCleanupProposalSummary,
  BoardCorrelationSummary,
  BoardDailyReportSummary,
  BoardDiscordAuditSummary,
  BoardDiscordDecisionAuditSummary,
  BoardGitTransactionSummary,
  BoardIncidentSummary,
  BoardOperationPriorityItem,
  BoardProjection,
  BoardQueueItemSummary,
  BoardReviewLoopSummary,
  BoardReviewResultSummary,
  BoardRunSummary,
  BoardTaskSummary,
  BoardWorkflowSummary
} from "./projection.js";

export function renderBoardHtml(
  projection: BoardProjection,
  options: { remoteReadOnly?: boolean } = {}
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kairon Board</title>
  <style>
    :root { color-scheme: light; font-family: Arial, sans-serif; }
    html { -webkit-text-size-adjust: 100%; }
    body { margin: 0; color: #202124; background: #f6f7f9; overflow-x: hidden; }
    header { padding: 22px 32px 16px; background: #ffffff; border-bottom: 1px solid #d9dee7; }
    main { padding: 24px 32px 40px; display: grid; gap: 24px; }
    h1, h2 { margin: 0; }
    h1 { font-size: 28px; }
    h2 { font-size: 18px; }
    .meta { margin-top: 8px; color: #5f6673; font-size: 13px; }
    nav { display: flex; flex-wrap: wrap; gap: 8px 14px; margin-top: 18px; font-size: 13px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
    .stat, section { background: #ffffff; border: 1px solid #d9dee7; border-radius: 8px; }
    .stat { padding: 14px 16px; }
    .label { color: #5f6673; font-size: 12px; text-transform: uppercase; }
    .value { margin-top: 6px; font-size: 24px; font-weight: 700; }
    .subvalue { margin-top: 4px; color: #5f6673; font-size: 12px; }
    .severity-high { color: #8a1c1c; font-weight: 700; }
    .severity-medium { color: #725200; font-weight: 700; }
    section { overflow: hidden; }
    section h2 { padding: 16px 18px; border-bottom: 1px solid #e6e9ef; }
    .table-wrap { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #edf0f5; vertical-align: top; overflow-wrap: anywhere; }
    th { color: #5f6673; background: #fbfcfe; font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    a { color: #2457c5; text-decoration: none; overflow-wrap: anywhere; }
    code { font-family: Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
    .empty { padding: 14px 18px; color: #5f6673; }
    .section-group { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 24px; }
    .compact-overview { display: grid; gap: 14px; padding: 16px 18px 18px; }
    .compact-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
    .compact-card { border: 1px solid #d9dee7; border-radius: 8px; padding: 12px 14px; background: #fbfcfe; min-width: 0; }
    .compact-card strong { display: block; margin-top: 6px; font-size: 20px; }
    .compact-status-high { border-color: #dfb4b4; background: #fff7f7; }
    .compact-status-medium { border-color: #dfd0a4; background: #fffaf0; }
    .compact-status-ok { border-color: #bad6c2; background: #f5fbf7; }
    .compact-priority-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
    .compact-priority-list li { display: grid; grid-template-columns: minmax(72px, auto) 1fr auto; gap: 10px; align-items: center; padding: 9px 10px; border: 1px solid #e6e9ef; border-radius: 8px; background: #ffffff; }
    .compact-pill { display: inline-block; border-radius: 999px; padding: 3px 8px; font-size: 12px; font-weight: 700; background: #edf0f5; color: #3d4653; }
    .compact-target { min-width: 0; overflow-wrap: anywhere; }
    .compact-action { white-space: nowrap; font-size: 12px; }
    @media (max-width: 720px) {
      header { padding: 16px; }
      main { padding: 16px; gap: 16px; }
      h1 { font-size: 23px; }
      nav { gap: 8px; overflow-x: auto; flex-wrap: nowrap; padding-bottom: 4px; }
      nav a { white-space: nowrap; }
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .value { font-size: 20px; }
      .section-group { grid-template-columns: 1fr; gap: 16px; }
      section h2 { padding: 14px 14px; }
      table { min-width: 640px; }
      th, td { padding: 9px 10px; }
      .compact-overview { padding: 14px; }
      .compact-grid { grid-template-columns: 1fr; }
      .compact-priority-list li { grid-template-columns: 1fr; align-items: start; }
      .compact-action { white-space: normal; }
    }
    @media (max-width: 520px) {
      header { padding: 14px 12px; }
      main { padding: 12px; }
      .stats { grid-template-columns: 1fr; }
      .stat, .compact-card { padding: 12px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Kairon Board</h1>
    <div class="meta">generated_at=${escapeHtml(projection.generated_at)} | view=${options.remoteReadOnly === true ? "remote-read-only" : "loopback-read-only"} | projection=<a href="/projection.json">projection.json</a> | <a href="/">refresh</a></div>
    <nav>
      <a href="#compact">Compact</a>
      <a href="#operations">Operations</a>
      <a href="#runtime">Runtime</a>
      <a href="#recovery">Recovery</a>
      <a href="#incidents">Incidents</a>
      <a href="#discord">Discord</a>
      <a href="#correlations">Correlations</a>
      <a href="#maintenance">Maintenance</a>
      <a href="#approvals">Approvals</a>
      <a href="#follow-ups">Follow-ups</a>
      <a href="#queue">Queue</a>
      <a href="#runs">Runs</a>
      <a href="#workflows">Workflows</a>
      <a href="#reviews">Reviews</a>
      <a href="#git">Git</a>
      <a href="#cleanup">Cleanup</a>
    </nav>
  </header>
  <main>
    ${renderCompactOverview(projection)}
    <div class="stats">
      ${stat("Attention", String(projection.operations.attention_total), `runs=${projection.operations.failed_runs + projection.operations.setup_required_runs}`)}
      ${stat("Schedule", projection.runtime.schedule.mode, `base=${projection.runtime.schedule.baseMode}`)}
      ${stat("Runtime", projection.runtime.runtimeLock.locked ? "locked" : "idle", projection.runtime.runtimeLock.stale ? "stale=true" : undefined)}
      ${stat("Queue Ready", String(projection.queue.ready), `failed=${projection.queue.failed}`)}
      ${stat("Approvals", String(projection.approvals.pending), "pending")}
      ${stat("Follow-ups", String(projection.follow_ups.pending), `running=${projection.follow_ups.running} snoozed=${projection.follow_ups.snoozed}`)}
      ${stat("Recovery", String(projection.runtime.recovery.targets), "targets")}
      ${stat("Incidents", String(projection.incidents.active), `total=${projection.incidents.total}`)}
      ${stat("Git Push", String(projection.git.transactions_requiring_approval), `approval required | pr=${projection.git.transactions_ready_for_pr}`)}
      ${stat("Discord", projection.discord.gateway?.status ?? "unknown", `audit=${projection.discord.notifications.total}/${projection.discord.decisions.total}`)}
      ${stat("Workflows", String(projection.workflows.total), `attention=${projection.workflows.attention}`)}
      ${stat("Correlations", String(projection.correlations.total), `attention=${projection.correlations.attention}`)}
    </div>
    ${renderOperations(projection.operations.priority)}
    ${renderIncidents(projection.incidents.recent)}
    <div class="section-group">
      ${renderRuntime(projection)}
      ${renderRecovery(projection)}
      ${renderMaintenance(projection.maintenance.latest_daily_report)}
    </div>
    ${renderDiscord(projection.discord.notifications, projection.discord.decisions)}
    ${renderCorrelations(projection.correlations.recent)}
    ${renderApprovals(projection.approvals.recent, options.remoteReadOnly === true)}
    ${renderFollowUps(projection.follow_ups.recent, options.remoteReadOnly === true)}
    ${renderQueue(projection.queue.recent)}
    ${renderWorkflows(projection.workflows.recent)}
    ${renderRuns(projection.runs.recent)}
    ${renderTasks(projection.tasks.recent)}
    ${renderReviews(projection.reviews.recent_loops, projection.reviews.recent_results)}
    ${renderGitTransactions(projection.git.recent_transactions, options.remoteReadOnly === true)}
    ${renderCleanup(projection.cleanup.recent)}
  </main>
</body>
</html>`;
}

function renderIncidents(incidents: BoardIncidentSummary[]): string {
  return section(
    "Incidents",
    [
      "Incident",
      "Status",
      "Severity",
      "Title",
      "Resources",
      "Recurrence",
      "Correlation",
      "Timeline",
      "Updated"
    ],
    incidents.map((incident) => [
      `<a id="incident-${escapeAttribute(incident.incident_id)}" href="#incident-${escapeAttribute(incident.incident_id)}"><code>${escapeHtml(incident.incident_id)}</code></a>`,
      text(incident.status),
      text(incident.severity),
      text(incident.title),
      text(`${incident.active_resources}/${incident.resource_count} active`),
      text(String(incident.recurrence_count)),
      code(incident.correlation_id),
      incident.timeline.length === 0
        ? text(undefined)
        : incident.timeline
            .map(
              (event) =>
                `<div>${escapeHtml(event.event)}${event.resource_id === undefined ? "" : ` <code>${escapeHtml(event.resource_id)}</code>`}: ${escapeHtml(event.status)}</div>`
            )
            .join(""),
      text(incident.updated_at)
    ]),
    "incidents"
  );
}

function renderCorrelations(correlations: BoardCorrelationSummary[]): string {
  return section(
    "Correlation Timeline",
    ["Correlation", "Status", "Approval", "Discord", "Follow-up", "Workflow", "Members", "Timeline", "Updated"],
    correlations.map((correlation) => [
      `<a id="correlation-${escapeAttribute(correlation.correlation_id)}" href="#correlation-${escapeAttribute(correlation.correlation_id)}"><code>${escapeHtml(correlation.correlation_id)}</code></a>`,
      text(correlation.status),
      code(correlation.approval_id),
      code(correlation.discord_message_id),
      code(correlation.follow_up_id),
      code(correlation.workflow_id),
      text(String(correlation.member_count)),
      correlation.timeline.length === 0
        ? text(undefined)
        : correlation.timeline
            .map(
              (event) =>
                `<div>${escapeHtml(event.kind)} <code>${escapeHtml(event.member_id)}</code>: ${escapeHtml(event.action)} -> ${escapeHtml(event.status)}</div>`
            )
            .join(""),
      text(correlation.updated_at)
    ]),
    "correlations"
  );
}

function stat(label: string, value: string, subvalue?: string): string {
  return `<div class="stat"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div>${subvalue === undefined ? "" : `<div class="subvalue">${escapeHtml(subvalue)}</div>`}</div>`;
}

function renderCompactOverview(projection: BoardProjection): string {
  const daemonStatus = projection.runtime.daemonHealth?.status ?? "unknown";
  const daemonSeverity = daemonCompactSeverity(projection);
  const runAttention =
    projection.operations.failed_runs + projection.operations.setup_required_runs;
  const cards = [
    compactCard(
      "Attention",
      String(projection.operations.attention_total),
      "operations needing review",
      projection.operations.attention_total > 0 ? "high" : "ok",
      "#operations"
    ),
    compactCard(
      "Approvals",
      String(projection.operations.pending_approvals),
      "pending",
      projection.operations.pending_approvals > 0 ? "high" : "ok",
      "#approvals"
    ),
    compactCard(
      "Runs",
      String(runAttention),
      `failed=${projection.operations.failed_runs} setup=${projection.operations.setup_required_runs}`,
      runAttention > 0 ? "high" : "ok",
      "#runs"
    ),
    compactCard(
      "Recovery",
      String(projection.operations.recovery_targets),
      "targets",
      projection.operations.recovery_targets > 0 ? "high" : "ok",
      "#recovery"
    ),
    compactCard(
      "Daemon",
      daemonStatus,
      daemonCompactDetail(projection),
      daemonSeverity,
      "#runtime"
    ),
    compactCard(
      "Git Push",
      String(projection.operations.git_transactions_requiring_approval),
      `approval required | pr=${projection.git.transactions_ready_for_pr}`,
      projection.operations.git_transactions_requiring_approval > 0 ? "high" : "ok",
      "#git"
    )
  ];
  const priorityItems = projection.operations.priority.slice(0, 5);
  const priorityList =
    priorityItems.length === 0
      ? `<div class="empty">No compact priority items</div>`
      : `<ul class="compact-priority-list">${priorityItems
          .map(
            (item) =>
              `<li><span class="compact-pill">${escapeHtml(item.kind)}</span><span class="compact-target"><a href="${escapeHtml(item.anchor)}">${escapeHtml(item.id)}</a><span class="subvalue">${escapeHtml(item.label)} | ${escapeHtml(item.status)}</span></span><a class="compact-action" href="${escapeHtml(item.anchor)}">Open</a></li>`
          )
          .join("")}</ul>`;

  return `<section id="compact" data-kairon-section="compact-overview" data-kairon-mobile="true" data-kairon-daemon-status="${escapeAttribute(daemonStatus)}" data-kairon-compact-priority-count="${escapeAttribute(String(priorityItems.length))}"><h2>Compact Overview</h2><div class="compact-overview"><div class="compact-grid">${cards.join("")}</div>${priorityList}</div></section>`;
}

function compactCard(
  label: string,
  value: string,
  detail: string,
  severity: "high" | "medium" | "ok",
  anchor: string
): string {
  return `<a class="compact-card compact-status-${severity}" href="${escapeHtml(anchor)}"><span class="label">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><span class="subvalue">${escapeHtml(detail)}</span></a>`;
}

function daemonCompactSeverity(projection: BoardProjection): "high" | "medium" | "ok" {
  const health = projection.runtime.daemonHealth;
  if (
    projection.runtime.runtimeLock.stale === true ||
    health?.status === "fatal_error" ||
    health?.status === "stale_lock" ||
    health?.stale_lock_suspected === true ||
    (health?.fatal_errors ?? 0) > 0
  ) {
    return "high";
  }

  return health?.status === "unknown" ? "medium" : "ok";
}

function daemonCompactDetail(projection: BoardProjection): string {
  const health = projection.runtime.daemonHealth;
  if (health?.last_error?.message !== undefined) {
    return health.last_error.message;
  }

  if (health?.stop_reason !== undefined) {
    return `stop=${health.stop_reason}`;
  }

  if (health?.last_action !== undefined) {
    return `last=${health.last_action}`;
  }

  return projection.runtime.runtimeLock.locked ? "lock active" : "no daemon log";
}

function renderOperations(items: BoardOperationPriorityItem[]): string {
  return section(
    "Operations Priority",
    ["Severity", "Kind", "Target", "Status", "Detail"],
    items.map((item) => [
      `<span class="severity-${escapeAttribute(item.severity)}">${escapeHtml(item.severity)}</span>`,
      text(item.kind),
      `<a href="${escapeHtml(item.anchor)}">${escapeHtml(item.id)}</a><div class="subvalue">${escapeHtml(item.label)}</div>`,
      text(item.status),
      text(item.detail)
    ]),
    "operations",
    {
      dataKaironSection: "operations-priority",
      dataKaironPriorityCount: items.length,
      emptyText: "No priority operations"
    }
  );
}

function renderRuntime(projection: BoardProjection): string {
  return section(
    "Runtime",
    ["Key", "Value"],
    [
      ["schedule.mode", text(projection.runtime.schedule.mode)],
      ["schedule.activeWorkClosed", text(String(projection.runtime.schedule.activeWorkClosed))],
      ["runtime.locked", text(String(projection.runtime.runtimeLock.locked))],
      ["runtime.mode", text(projection.runtime.runtimeLock.mode)],
      ["runtime.heartbeatAt", text(projection.runtime.runtimeLock.heartbeat_at)],
      ["runtime.tickCount", text(optionalNumber(projection.runtime.runtimeLock.tick_count))],
      ["runtime.nextTickAt", text(projection.runtime.runtimeLock.next_tick_at)],
      ["sessions.ready", text(optionalNumber(projection.runtime.sessions?.ready))]
    ].map(([key, value]) => [code(key), value]),
    "runtime"
  );
}

function renderRecovery(projection: BoardProjection): string {
  const recovery = projection.runtime.recovery;
  return section(
    "Recovery",
    ["Key", "Count"],
    [
      ["targets", recovery.targets],
      ["staleLocks", recovery.stale_locks],
      ["expiredClaims", recovery.expired_claims],
      ["runIssues", recovery.run_issues],
      ["gatewayIssues", recovery.gateway_issues],
      ["gitTransactionIssues", recovery.git_transaction_issues],
      ["resolvedTargets", recovery.resolved_targets]
    ].map(([key, value]) => [code(String(key)), text(String(value))]),
    "recovery"
  );
}

function renderMaintenance(report: BoardDailyReportSummary | undefined): string {
  if (report === undefined) {
    return section("Maintenance", ["Key", "Value"], [], "maintenance");
  }

  return section(
    "Maintenance",
    ["Key", "Value"],
    [
      ["date", text(report.date)],
      ["report", code(report.report_path)],
      ["completedRuns", text(optionalNumber(report.completed_runs))],
      ["failedRuns", text(optionalNumber(report.failed_runs))],
      ["setupRequiredRuns", text(optionalNumber(report.setup_required_runs))],
      ["pendingApprovals", text(optionalNumber(report.pending_approvals))],
      ["failedNotifications", text(optionalNumber(report.failed_notifications))],
      ["gitTransactionsReadyForPr", text(optionalNumber(report.git_transactions_ready_for_pr))],
      ["gitTransactionsRequiringApproval", text(optionalNumber(report.git_transactions_requiring_approval))]
    ].map(([key, value]) => [code(String(key)), value]),
    "maintenance"
  );
}

function renderDiscord(
  notifications: BoardDiscordAuditSummary,
  decisions: BoardDiscordDecisionAuditSummary
): string {
  const summaryRows = [
    ["notifications.total", notifications.total],
    ...Object.entries(notifications.by_status).map(([status, count]) => [
      `notifications.${status}`,
      count
    ]),
    ["decision_audit.status", decisions.status],
    ...(decisions.next_action === undefined
      ? []
      : [["decision_audit.next_action", decisions.next_action]]),
    ["decisions.total", decisions.total],
    ...Object.entries(decisions.by_status).map(([status, count]) => [
      `decisions.status.${status}`,
      count
    ]),
    ...Object.entries(decisions.by_decision).map(([decision, count]) => [
      `decisions.action.${decision}`,
      count
    ])
  ].map(([key, value]) => [code(String(key)), text(String(value))]);

  const notificationRows = notifications.recent.map((record) => [
    text(record.approval_id),
    text(record.status),
    text(record.decision_status),
    text(record.message_id),
    record.board_url === undefined
      ? text(record.board_anchor)
      : `<a href="${escapeHtml(record.board_url)}">${escapeHtml(record.board_anchor ?? "Open Board")}</a>`,
    text(record.reason),
    text(record.next_action),
    text(record.recorded_at ?? record.updated_at ?? record.sent_at)
  ]);
  const decisionRows = decisions.recent.map((record) => [
    text(record.approval_id),
    text(record.decision),
    text(record.status),
    text(record.actor_hash),
    text(record.message_id),
    text(record.command_status),
    text(record.message_update_status),
    text(record.message_update_reason),
    text(record.recorded_at)
  ]);

  return `<div id="discord">${section("Discord Summary", ["Key", "Value"], summaryRows)}
${section("Discord Notification Audit", ["Approval", "Status", "Decision", "Message", "Board", "Reason", "Next Action", "Recorded"], notificationRows)}
${section("Discord Decision Audit", ["Approval", "Decision", "Status", "Actor", "Message", "Command", "Update", "Update Reason", "Recorded"], decisionRows)}</div>`;
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
    ]),
    "queue"
  );
}

function renderWorkflows(workflows: BoardWorkflowSummary[]): string {
  return section(
    "Workflows",
    [
      "Workflow",
      "Status",
      "Current Node",
      "Progress",
      "Blocker",
      "Approval",
      "Retries",
      "Last Event",
      "Timeline",
      "Updated"
    ],
    workflows.map((workflow) => [
      `<a id="workflow-${escapeAttribute(workflow.workflow_id)}" href="#workflow-${escapeAttribute(workflow.workflow_id)}"><code>${escapeHtml(workflow.workflow_id)}</code></a>`,
      text(`${workflow.status} / ${workflow.control_mode}`),
      text(workflow.current_node),
      text(`${workflow.progress_completed}/${workflow.progress_total}`),
      text(workflow.blocker),
      text(workflow.approval_id),
      text(String(workflow.retry_count)),
      text(
        workflow.last_event === undefined
          ? undefined
          : `${workflow.last_event.action} (${workflow.last_event.status_after})`
      ),
      workflow.timeline.length === 0
        ? text(undefined)
        : workflow.timeline
            .map(
              (event) =>
                `<div><code>${escapeHtml(event.event_id)}</code>: ${escapeHtml(event.action)} -> ${escapeHtml(event.status_after)}</div>`
            )
            .join(""),
      text(workflow.updated_at)
    ]),
    "workflows"
  );
}

function renderApprovals(
  approvals: BoardApprovalSummary[],
  remoteReadOnly: boolean
): string {
  const summaryHeaders = remoteReadOnly
    ? ["ID", "Status", "Risk", "Type", "Title", "Confirmation", "Updated"]
    : ["ID", "Status", "Risk", "Type", "Title", "Confirmation", "Next Action", "Updated"];
  const summary = section(
    "Approvals",
    summaryHeaders,
    approvals.map((approval) => {
      const row = [
      `<a id="${approvalAnchor(approval.id)}" href="#${approvalAnchor(approval.id)}">${escapeHtml(approval.id)}</a>`,
      text(approval.status),
      text(approval.risk_level),
      text(approval.type),
      text(approval.title),
      text(approvalConfirmationSummary(approval))
      ];
      if (!remoteReadOnly) {
        row.push(
          approval.local_command_hint === undefined
            ? text(undefined)
            : `<a href="#${approvalDetailAnchor(approval.id)}">${escapeHtml(approval.local_command_hint)}</a>`
        );
      }
      row.push(text(approval.updated_at ?? approval.created_at));
      return row;
    }),
    "approvals"
  );

  const detailHeaders = remoteReadOnly
    ? ["Approval", "Scope", "Related Artifacts", "Checks"]
    : ["Approval", "Scope", "Related Artifacts", "Checks", "Rollback", "Local CLI"];
  const details = section(
    "Approval Details",
    detailHeaders,
    approvals.map((approval) => {
      const row = [
      `<a id="${approvalDetailAnchor(approval.id)}" href="#${approvalDetailAnchor(approval.id)}"><code>${escapeHtml(approval.id)}</code></a><div class="subvalue">${escapeHtml(approval.status)}</div>`,
      formatApprovalScope(approval),
      formatApprovalRelatedArtifacts(approval.related_artifacts),
      formatApprovalChecks(approval.checks_summary, approval.required_approvals)
      ];
      if (!remoteReadOnly) {
        row.push(text(approval.rollback_hint), text(approval.local_command_hint));
      }
      return row;
    }),
    "approval-details"
  );

  return `${summary}\n${details}`;
}

function approvalConfirmationSummary(approval: BoardApprovalSummary): string | undefined {
  const parts = [
    approval.confirmation_status,
    approval.confirmation_action,
    approval.confirmation_required_by
  ].filter((part): part is string => part !== undefined && part.length > 0);
  return parts.length === 0 ? undefined : parts.join(" / ");
}

function formatApprovalScope(approval: BoardApprovalSummary): string {
  return detailLines([
    ["task", approval.task_id],
    ["run", approval.run_id],
    ["operation", approval.operation],
    ["required_for", approval.approval_required_for],
    ["source", approval.source_branch],
    ["target", approval.target_branch],
    ["environment", approval.environment],
    ["commit_range", approval.commit_range],
    ["dry_run", optionalBoolean(approval.dry_run)],
    ["execution_allowed", optionalBoolean(approval.execution_allowed)],
    ["confirmation", approvalConfirmationSummary(approval)],
    ["confirmation_reason", approval.confirmation_reason],
    ["artifact", approval.artifact_path]
  ]);
}

function formatApprovalRelatedArtifacts(
  artifacts: BoardApprovalRelatedArtifact[] | undefined
): string {
  if (artifacts === undefined || artifacts.length === 0) {
    return text(undefined);
  }

  return artifacts
    .map((artifact) => {
      const label = [artifact.kind, artifact.id].filter(Boolean).join(":");
      const linked =
        artifact.anchor === undefined
          ? escapeHtml(label)
          : `<a href="${escapeHtml(artifact.anchor)}">${escapeHtml(label)}</a>`;
      const status =
        artifact.status === undefined
          ? ""
          : `<span class="subvalue"> ${escapeHtml(artifact.status)}</span>`;
      const artifactPath =
        artifact.path === undefined
          ? ""
          : `<div class="subvalue"><code>${escapeHtml(artifact.path)}</code></div>`;
      return `<div>${linked}${status}${artifactPath}</div>`;
    })
    .join("");
}

function formatApprovalChecks(
  checks: BoardApprovalCheckSummary[] | undefined,
  requiredApprovals: BoardApprovalRequiredApprovalSummary[] | undefined
): string {
  const checkHtml =
    checks
      ?.map(
        (check) =>
          `<div><code>${escapeHtml(check.name)}</code>: ${escapeHtml(check.status)}${check.detail === undefined ? "" : ` <span class="subvalue">${escapeHtml(check.detail)}</span>`}</div>`
      )
      .join("") ?? "";
  const requiredHtml =
    requiredApprovals
      ?.map((approval) => {
        const parts = [
          approval.type,
          approval.required_by,
          approval.present === undefined ? undefined : approval.present ? "present" : "missing"
        ].filter((part): part is string => part !== undefined && part.length > 0);
        return `<div><code>required</code>: ${escapeHtml(parts.join(" / "))}</div>`;
      })
      .join("") ?? "";
  return checkHtml.length === 0 && requiredHtml.length === 0
    ? text(undefined)
    : `${checkHtml}${requiredHtml}`;
}

function renderFollowUps(
  followUps: BoardApprovalFollowUpSummary[],
  remoteReadOnly: boolean
): string {
  return section(
    "Follow-ups",
    remoteReadOnly
      ? ["ID", "Status", "Action", "Approval", "Risk", "Updated"]
      : ["ID", "Status", "Action", "Approval", "Risk", "Hint", "Updated"],
    followUps.map((followUp) => {
      const row = [
      `<a id="${followUpAnchor(followUp.id)}" href="#${followUpAnchor(followUp.id)}"><code>${escapeHtml(followUp.id)}</code></a>`,
      text(followUp.status),
      text(followUp.action_type),
      text(followUp.approval_id),
      text(followUp.risk_level)
      ];
      if (!remoteReadOnly) {
        row.push(text(followUp.command_hint));
      }
      row.push(text(followUp.updated_at ?? followUp.created_at));
      return row;
    }),
    "follow-ups"
  );
}

function renderRuns(runs: BoardRunSummary[]): string {
  return section(
    "Runs",
    ["Run", "Task", "Agent", "Status", "Exit", "Finished"],
    runs.map((run) => [
      `<a id="${runAnchor(run.run_id)}" href="#${runAnchor(run.run_id)}"><code>${escapeHtml(run.run_id)}</code></a>`,
      text(run.task_id),
      text(run.agent),
      text(run.status ?? run.outbox_status),
      text(run.exit_code === undefined ? undefined : String(run.exit_code)),
      text(run.finished_at ?? run.created_at)
    ]),
    "runs"
  );
}

function renderReviews(
  loops: BoardReviewLoopSummary[],
  results: BoardReviewResultSummary[]
): string {
  const loopRows = loops.map((loop) => [
    `<a id="${reviewLoopAnchor(loop.loop_id)}" href="#${reviewLoopAnchor(loop.loop_id)}"><code>${escapeHtml(loop.loop_id)}</code></a>`,
    text(loop.task_id),
    text(loop.status),
    text(loop.iteration === undefined ? undefined : String(loop.iteration)),
    text(loop.updated_at ?? loop.created_at)
  ]);
  const resultRows = results.map((result) => [
    `<a id="${reviewResultAnchor(result.review_id)}" href="#${reviewResultAnchor(result.review_id)}"><code>${escapeHtml(result.review_id)}</code></a>`,
    text(result.run_id),
    text(result.status),
    text(result.score === undefined ? undefined : String(result.score)),
    text(result.highest_severity),
    text(result.created_at)
  ]);

  return `<div id="reviews">${section("Review Loops", ["Loop", "Task", "Status", "Iteration", "Updated"], loopRows)}
${section("Review Results", ["Review", "Run", "Status", "Score", "Highest Severity", "Created"], resultRows)}</div>`;
}

function renderGitTransactions(
  transactions: BoardGitTransactionSummary[],
  remoteReadOnly: boolean
): string {
  return section(
    "Git Transactions",
    remoteReadOnly
      ? ["Transaction", "Status", "Task", "Branch", "PR", "Remote Ref", "Approval", "Updated"]
      : ["Transaction", "Status", "Task", "Branch", "PR", "Remote Ref", "Approval", "Rollback", "Updated"],
    transactions.map((transaction) => {
      const row = [
      `<a id="${gitTransactionAnchor(transaction.transaction_id)}" href="#${gitTransactionAnchor(transaction.transaction_id)}"><code>${escapeHtml(transaction.transaction_id)}</code></a>`,
      text(transaction.status),
      text(transaction.task_id),
      text(transaction.branch),
      `${text(transaction.pr_status)}<div class="subvalue">${escapeHtml(transaction.pr_base ?? "-")} &larr; ${escapeHtml(transaction.pr_head ?? "-")}</div>`,
      text(transaction.remote_ref ?? undefined),
      text(transaction.approval_id)
      ];
      if (!remoteReadOnly) {
        row.push(`${text(transaction.rollback_strategy)}<div class="subvalue">${escapeHtml(transaction.rollback_hint ?? "-")}</div>`);
      }
      row.push(text(transaction.updated_at ?? transaction.created_at));
      return row;
    }),
    "git"
  );
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
    ]),
    "cleanup"
  );
}

type SectionOptions = {
  dataKaironSection?: string;
  dataKaironPriorityCount?: number;
  emptyText?: string;
};

function section(
  title: string,
  headers: string[],
  rows: string[][],
  id?: string,
  options: SectionOptions = {}
): string {
  const attributes = [
    id === undefined ? undefined : `id="${escapeAttribute(id)}"`,
    options.dataKaironSection === undefined
      ? undefined
      : `data-kairon-section="${escapeAttribute(options.dataKaironSection)}"`,
    options.dataKaironPriorityCount === undefined
      ? undefined
      : `data-kairon-priority-count="${escapeAttribute(String(options.dataKaironPriorityCount))}"`
  ]
    .filter((attribute): attribute is string => attribute !== undefined)
    .join(" ");
  const attributeText = attributes.length === 0 ? "" : ` ${attributes}`;

  if (rows.length === 0) {
    return `<section${attributeText}><h2>${escapeHtml(title)}</h2><div class="empty">${escapeHtml(options.emptyText ?? "No items")}</div></section>`;
  }

  return `<section${attributeText}><h2>${escapeHtml(title)}</h2><div class="table-wrap"><table><thead><tr>${headers
    .map((header) => `<th>${escapeHtml(header)}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div></section>`;
}

function text(value: string | undefined): string {
  return escapeHtml(value ?? "-");
}

function code(value: string | undefined): string {
  return `<code>${escapeHtml(value ?? "-")}</code>`;
}

function optionalNumber(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function optionalBoolean(value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function detailLines(lines: Array<[string, string | undefined]>): string {
  const rows = lines.filter(([, value]) => value !== undefined && value.length > 0);
  if (rows.length === 0) {
    return text(undefined);
  }

  return rows
    .map(([key, value]) => `<div><code>${escapeHtml(key)}</code>: ${escapeHtml(value ?? "")}</div>`)
    .join("");
}

function approvalAnchor(approvalId: string): string {
  return `approval-${escapeAttribute(approvalId)}`;
}

function approvalDetailAnchor(approvalId: string): string {
  return `approval-detail-${escapeAttribute(approvalId)}`;
}

function runAnchor(runId: string): string {
  return `run-${escapeAttribute(runId)}`;
}

function reviewLoopAnchor(loopId: string): string {
  return `review-loop-${escapeAttribute(loopId)}`;
}

function reviewResultAnchor(reviewId: string): string {
  return `review-result-${escapeAttribute(reviewId)}`;
}

function gitTransactionAnchor(transactionId: string): string {
  return `git-transaction-${escapeAttribute(transactionId)}`;
}

function followUpAnchor(followUpId: string): string {
  return `follow-up-${escapeAttribute(followUpId)}`;
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
