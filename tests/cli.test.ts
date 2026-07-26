import { describe, expect, it } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createProgram,
  isCliEntrypoint,
  resolveStateSnapshotRestoreCliOptions
} from "../src/cli/main.js";
import { resolveAllowInteractiveAgents } from "../src/cli/commands/task.js";

describe("createProgram", () => {
  it("registers the documented top-level commands", () => {
    const commandNames = createProgram()
      .commands.map((command) => command.name())
      .sort();

    expect(commandNames).toEqual([
      "agent",
      "approval",
      "board",
      "capability",
      "cleanup",
      "config",
      "daemon",
      "deploy",
      "discord",
      "docking",
      "doctor",
      "git",
      "incident",
      "init",
      "leave",
      "maintenance",
      "merge",
      "metrics",
      "migrate",
      "projects",
      "rag",
      "readiness",
      "recovery",
      "release",
      "remote",
      "review",
      "start",
      "state",
      "status",
      "stop",
      "support",
      "task",
      "test",
      "update",
      "watchdog",
      "workflow"
    ]);
  });

  it("registers stable remote profile and health commands", () => {
    const remote = createProgram().commands.find(
      (command) => command.name() === "remote"
    );
    const profile = remote?.commands.find(
      (command) => command.name() === "profile"
    );

    expect(remote?.commands.map((command) => command.name()).sort()).toEqual([
      "doctor",
      "profile",
      "status"
    ]);
    expect(profile?.commands.map((command) => command.name()).sort()).toEqual([
      "show",
      "validate"
    ]);
  });

  it("registers guarded schema migration plan and apply commands", () => {
    const migrate = createProgram().commands.find(
      (command) => command.name() === "migrate"
    );
    const apply = migrate?.commands.find(
      (command) => command.name() === "apply"
    );

    expect(migrate?.commands.map((command) => command.name()).sort()).toEqual([
      "apply",
      "plan"
    ]);
    expect(apply?.options.map((option) => option.long)).toContain("--confirm");
  });

  it("registers multi-project registry commands", () => {
    const projects = createProgram().commands.find(
      (command) => command.name() === "projects"
    );

    expect(projects?.commands.map((command) => command.name()).sort()).toEqual([
      "doctor",
      "list",
      "register",
      "show",
      "unregister"
    ]);
    for (const command of projects?.commands ?? []) {
      expect(command.options.map((option) => option.long)).toContain("--format");
    }
  });

  it("registers capability evaluate and explain commands", () => {
    const capability = createProgram().commands.find(
      (command) => command.name() === "capability"
    );
    const evaluate = capability?.commands.find(
      (command) => command.name() === "evaluate"
    );
    const explain = capability?.commands.find(
      (command) => command.name() === "explain"
    );

    expect(capability?.commands.map((command) => command.name()).sort()).toEqual([
      "evaluate",
      "explain"
    ]);
    expect(evaluate?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--task", "--agent", "--format"])
    );
    expect(explain?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--task", "--agent", "--format"])
    );
  });

  it("detects npm link entrypoints through their real path", () => {
    const realEntrypoint = path.resolve("repo", "dist", "cli", "main.js");
    const linkedEntrypoint = path.resolve(
      "global",
      "node_modules",
      "kairon",
      "dist",
      "cli",
      "main.js"
    );
    const realpath = (filePath: string) =>
      filePath === linkedEntrypoint ? realEntrypoint : filePath;

    expect(
      isCliEntrypoint(
        pathToFileURL(realEntrypoint).href,
        linkedEntrypoint,
        realpath
      )
    ).toBe(true);
  });

  it("registers approval follow-up tracking and execution commands", () => {
    const approval = createProgram().commands.find(
      (command) => command.name() === "approval"
    );
    const followUp = approval?.commands.find(
      (command) => command.name() === "follow-up"
    );
    const list = followUp?.commands.find((command) => command.name() === "list");
    const run = followUp?.commands.find((command) => command.name() === "run");

    expect(followUp?.commands.map((command) => command.name()).sort()).toEqual([
      "list",
      "run",
      "show"
    ]);
    expect(list?.options.map((option) => option.long)).toContain("--status");
    expect(run?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--dry-run", "--confirm"])
    );
    expect(run?.description()).toContain("explicitly execute");
  });

  it("registers guarded GitHub PR merge options", () => {
    const git = createProgram().commands.find((command) => command.name() === "git");
    const pr = git?.commands.find((command) => command.name() === "pr");
    const merge = pr?.commands.find((command) => command.name() === "merge");

    expect(merge?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining([
        "--dry-run",
        "--execute",
        "--follow-up-id",
        "--confirm",
        "--repository",
        "--method",
        "--token-env"
      ])
    );
    expect(merge?.description()).toContain("approved GitHub PR merge");
  });

  it("maps Commander --no-interactive-agents to task run dispatch options", () => {
    expect(
      resolveAllowInteractiveAgents({ interactiveAgents: false })
    ).toBe(false);
    expect(
      resolveAllowInteractiveAgents({ noInteractiveAgents: true })
    ).toBe(false);
    expect(resolveAllowInteractiveAgents({})).toBeUndefined();
  });

  it("registers maintenance RAG build option", () => {
    const maintenance = createProgram().commands.find(
      (command) => command.name() === "maintenance"
    );
    const run = maintenance?.commands.find((command) => command.name() === "run");

    expect(run?.options.map((option) => option.long)).toContain("--build-rag");
    expect(maintenance?.description()).toContain("operator artifacts");
    expect(run?.description()).toContain("daily report");
    expect(run?.description()).toContain("cleanup proposal");
    expect(run?.description()).toContain("recovery artifact");
  });

  it("registers cleanup retention planning modes", () => {
    const cleanup = createProgram().commands.find(
      (command) => command.name() === "cleanup"
    );
    const retention = cleanup?.commands.find(
      (command) => command.name() === "retention"
    );
    const plan = retention?.commands.find((command) => command.name() === "plan");

    expect(retention?.description()).toContain("retention");
    expect(plan?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--dry-run", "--write-proposal"])
    );
    expect(plan?.description()).toContain("without deleting");
  });

  it("documents status and recovery operational scope", () => {
    const program = createProgram();
    const status = program.commands.find((command) => command.name() === "status");
    const recovery = program.commands.find((command) => command.name() === "recovery");

    expect(status?.description()).toContain("artifact status");
    expect(recovery?.description()).toContain("Inspect and resolve");
  });

  it("registers doctor text and JSON output formats", () => {
    const doctor = createProgram().commands.find(
      (command) => command.name() === "doctor"
    );

    expect(doctor?.options.map((option) => option.long)).toContain("--format");
    expect(doctor?.options.find((option) => option.long === "--format")?.defaultValue).toBe(
      "text"
    );
  });

  it("registers daemon evidence, certification, and Windows task commands", () => {
    const daemon = createProgram().commands.find(
      (command) => command.name() === "daemon"
    );
    const report = daemon?.commands.find((command) => command.name() === "report");
    const certify = daemon?.commands.find((command) => command.name() === "certify");
    const task = daemon?.commands.find((command) => command.name() === "task");
    const taskCommands = task?.commands.map((command) => command.name());

    expect(daemon?.description()).toContain("daemon evidence");
    expect(report?.description()).toContain("long-run evidence report");
    expect(report?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining([
        "--since",
        "--format",
        "--output",
        "--heartbeat-gap-ms"
      ])
    );
    expect(certify?.description()).toContain("Certify daemon soak evidence");
    expect(certify?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining([
        "--since",
        "--format",
        "--output",
        "--expected-interval-ms",
        "--max-heartbeat-gap-ms",
        "--max-restart-gap-ms",
        "--max-fatal-errors",
        "--minimum-ticks"
      ])
    );
    expect(task?.description()).toContain("Windows Task Scheduler");
    expect(taskCommands).toEqual(
      expect.arrayContaining(["status", "install", "uninstall", "restart"])
    );
    expect(
      task?.commands
        .find((command) => command.name() === "install")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--dry-run", "--interval-ms", "--at-startup"]));
    expect(
      task?.commands
        .find((command) => command.name() === "uninstall")
        ?.options.map((option) => option.long)
    ).toContain("--dry-run");
  });

  it("registers runtime watchdog inspection and resolution commands", () => {
    const watchdog = createProgram().commands.find(
      (command) => command.name() === "watchdog"
    );
    const list = watchdog?.commands.find((command) => command.name() === "list");
    const resolve = watchdog?.commands.find(
      (command) => command.name() === "resolve"
    );

    expect(watchdog?.commands.map((command) => command.name()).sort()).toEqual([
      "check",
      "list",
      "resolve",
      "show"
    ]);
    expect(list?.options.map((option) => option.long)).toContain("--status");
    expect(resolve?.options.map((option) => option.long)).toContain("--reason");
    expect(resolve?.options.find((option) => option.long === "--reason")?.mandatory).toBe(
      true
    );
  });

  it("registers state integrity, backup, event compaction, and snapshot commands", () => {
    const state = createProgram().commands.find(
      (command) => command.name() === "state"
    );
    const check = state?.commands.find((command) => command.name() === "check");
    const snapshot = state?.commands.find(
      (command) => command.name() === "snapshot"
    );
    const restore = snapshot?.commands.find(
      (command) => command.name() === "restore"
    );
    const events = state?.commands.find((command) => command.name() === "events");
    const compact = events?.commands.find((command) => command.name() === "compact");
    const verify = events?.commands.find((command) => command.name() === "verify");
    const backup = state?.commands.find((command) => command.name() === "backup");
    const backupCreate = backup?.commands.find(
      (command) => command.name() === "create"
    );
    const backupRestore = backup?.commands.find(
      (command) => command.name() === "restore"
    );

    expect(state?.description()).toContain("file-based state integrity");
    expect(state?.commands.map((command) => command.name()).sort()).toEqual([
      "backup",
      "check",
      "events",
      "snapshot"
    ]);
    expect(check?.options.map((option) => option.long)).toContain("--format");
    expect(snapshot?.description()).toContain("safely plan or execute restores");
    expect(snapshot?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--dry-run", "--format"])
    );
    expect(restore?.description()).toContain("explicit confirmation");
    expect(restore?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--dry-run", "--confirm", "--format"])
    );
    expect(events?.commands.map((command) => command.name()).sort()).toEqual([
      "compact",
      "verify"
    ]);
    expect(compact?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--dry-run", "--confirm", "--format"])
    );
    expect(verify?.options.map((option) => option.long)).toContain("--format");
    expect(backup?.commands.map((command) => command.name()).sort()).toEqual([
      "create",
      "rehearse",
      "restore",
      "verify"
    ]);
    expect(backupCreate?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--dry-run", "--output", "--format"])
    );
    expect(backupRestore?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--confirm", "--source", "--format"])
    );
  });

  it("routes nested snapshot restore options to the restore action", async () => {
    const program = createProgram();
    const state = program.commands.find((command) => command.name() === "state")!;
    const snapshot = state.commands.find(
      (command) => command.name() === "snapshot"
    )!;
    const restore = snapshot.commands.find(
      (command) => command.name() === "restore"
    )!;
    let captured:
      | ReturnType<typeof resolveStateSnapshotRestoreCliOptions>
      | undefined;

    restore.action((_snapshotId: string, options) => {
      captured = resolveStateSnapshotRestoreCliOptions(options, snapshot.opts());
    });

    await program.parseAsync(
      ["state", "snapshot", "restore", "SNP-TEST", "--dry-run", "--format", "json"],
      { from: "user" }
    );

    expect(captured).toMatchObject({ dryRun: true, format: "json" });
  });

  it("keeps release bump --version scoped to the bump command", async () => {
    const program = createProgram();
    const release = program.commands.find(
      (command) => command.name() === "release"
    )!;
    const bump = release.commands.find((command) => command.name() === "bump")!;
    let captured: { version?: string; dryRun?: boolean } | undefined;

    bump.action((options) => {
      captured = options;
    });

    await program.parseAsync(
      ["release", "bump", "--version", "0.2.0", "--dry-run"],
      { from: "user" }
    );

    expect(captured).toMatchObject({ version: "0.2.0", dryRun: true });
  });

  it("registers board export, serve, and remote access commands", () => {
    const board = createProgram().commands.find((command) => command.name() === "board");

    expect(board?.commands.map((command) => command.name()).sort()).toEqual([
      "access",
      "export",
      "serve"
    ]);
    expect(
      board?.commands
        .find((command) => command.name() === "serve")
        ?.options.map((option) => option.long)
    ).toEqual(
      expect.arrayContaining([
        "--profile",
        "--host",
        "--port",
        "--recent",
        "--require-token",
        "--access-token-ttl-seconds",
        "--max-seconds"
      ])
    );
    const access = board?.commands.find((command) => command.name() === "access");
    expect(access?.commands.map((command) => command.name()).sort()).toEqual([
      "issue",
      "revoke"
    ]);
    expect(
      access?.commands
        .find((command) => command.name() === "issue")
        ?.options.map((option) => option.long)
    ).toContain("--ttl-minutes");
  });

  it("registers agent session commands", () => {
    const agent = createProgram().commands.find(
      (command) => command.name() === "agent"
    );
    const session = agent?.commands.find((command) => command.name() === "session");

    expect(agent?.commands.map((command) => command.name()).sort()).toEqual([
      "health",
      "resume",
      "session",
      "smoke",
      "suspend"
    ]);
    expect(session?.commands.map((command) => command.name()).sort()).toEqual([
      "budget",
      "compact",
      "list",
      "reset",
      "rotate",
      "show"
    ]);
    expect(
      session?.commands
        .find((command) => command.name() === "reset")
        ?.options.map((option) => option.long)
    ).toContain("--date");
  });

  it("registers cleanup proposal commands", () => {
    const cleanup = createProgram().commands.find(
      (command) => command.name() === "cleanup"
    );

    expect(cleanup?.commands.map((command) => command.name()).sort()).toEqual([
      "apply",
      "archive",
      "list",
      "retention",
      "show"
    ]);
    expect(
      cleanup?.commands
        .find((command) => command.name() === "apply")
        ?.options.map((option) => option.long)
    ).toContain("--dry-run");
  });

  it("registers runtime recovery target commands", () => {
    const recovery = createProgram().commands.find(
      (command) => command.name() === "recovery"
    );

    expect(recovery?.commands.map((command) => command.name()).sort()).toEqual([
      "acknowledge",
      "list",
      "resolve",
      "run",
      "self-healing",
      "show"
    ]);
    expect(
      recovery?.commands
        .find((command) => command.name() === "resolve")
        ?.options.map((option) => option.long)
    ).toContain("--reason");
    const selfHealing = recovery?.commands.find(
      (command) => command.name() === "self-healing"
    );
    expect(
      selfHealing?.commands.map((command) => command.name()).sort()
    ).toEqual(["inspect", "list", "plan", "run", "tick"]);
    expect(
      selfHealing?.commands
        .find((command) => command.name() === "run")
        ?.options.map((option) => option.long)
    ).toContain("--confirm");
  });

  it("registers incident lifecycle and guarded recovery commands", () => {
    const incident = createProgram().commands.find(
      (command) => command.name() === "incident"
    );

    expect(incident?.commands.map((command) => command.name())).toEqual([
      "list",
      "show",
      "acknowledge",
      "bundle",
      "recover",
      "resolve"
    ]);
    const recover = incident?.commands.find(
      (command) => command.name() === "recover"
    );
    expect(recover?.options.map((option) => option.long)).toEqual([
      "--dry-run",
      "--approval-id",
      "--confirm"
    ]);
  });

  it("registers operation test summary command", () => {
    const test = createProgram().commands.find((command) => command.name() === "test");
    const summarize = test?.commands.find((command) => command.name() === "summarize");
    const commands = test?.commands.find((command) => command.name() === "commands");
    const docs = test?.commands.find((command) => command.name() === "docs");

    expect(test?.description()).toContain("operation test results");
    expect(test?.commands.map((command) => command.name()).sort()).toEqual([
      "commands",
      "docs",
      "summarize"
    ]);
    expect(commands?.description()).toContain("Generate PowerShell commands");
    expect(commands?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--profile", "--range", "--format"])
    );
    expect(docs?.description()).toContain("Generate operation test list");
    expect(docs?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining([
        "--range",
        "--output-dir",
        "--name-prefix",
        "--overwrite",
        "--dry-run"
      ])
    );
    expect(summarize?.description()).toContain("optionally apply PASS updates");
    expect(summarize?.options.map((option) => option.long)).toContain("--result-root");
    expect(summarize?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining([
        "--test-list",
        "--suggest",
        "--json",
        "--patch-preview",
        "--apply-pass"
      ])
    );
  });

  it("registers production workflow and candidate commands", () => {
    const workflow = createProgram().commands.find(
      (command) => command.name() === "workflow"
    );
    const run = workflow?.commands.find((command) => command.name() === "run");
    const config = workflow?.commands.find(
      (command) => command.name() === "config"
    );
    const checkpoint = workflow?.commands.find(
      (command) => command.name() === "checkpoint"
    );

    expect(workflow?.description()).toContain("persistent Kairon workflows");
    expect(workflow?.commands.map((command) => command.name()).sort()).toEqual([
      "cancel",
      "checkpoint",
      "compensate",
      "config",
      "list",
      "pause",
      "recover",
      "resume",
      "retry",
      "run",
      "show",
      "validate"
    ]);
    expect(run?.description()).toContain("production workflow");
    expect(config?.commands.map((command) => command.name()).sort()).toEqual([
      "propose",
      "show"
    ]);
    expect(checkpoint?.commands.map((command) => command.name()).sort()).toEqual([
      "rebuild",
      "status",
      "verify"
    ]);
    expect(
      checkpoint?.commands
        .find((command) => command.name() === "rebuild")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--dry-run", "--confirm"]));
    expect(
      config?.commands
        .find((command) => command.name() === "propose")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--enable", "--disable"]));
    expect(run?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining([
        "--candidate",
        "--definition",
        "--dry-run",
        "--connect-queue",
        "--workflow-id",
        "--task-id",
        "--queue-item-id",
        "--approval-id",
        "--objective",
        "--resource-lock",
        "--retry-max-attempts",
        "--retry-backoff-seconds"
      ])
    );
    expect(
      workflow?.commands
        .find((command) => command.name() === "cancel")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--reason", "--approval-id"]));
    expect(
      workflow?.commands
        .find((command) => command.name() === "retry")
        ?.options.map((option) => option.long)
    ).toContain("--node");
    expect(
      workflow?.commands
        .find((command) => command.name() === "compensate")
        ?.options.map((option) => option.long)
    ).toEqual(
      expect.arrayContaining(["--dry-run", "--approval-id", "--confirm"])
    );
  });

  it("registers RAG index commands and query filters", () => {
    const rag = createProgram().commands.find((command) => command.name() === "rag");

    expect(rag?.commands.map((command) => command.name()).sort()).toEqual([
      "compact",
      "evaluate",
      "provider",
      "query",
      "rebuild",
      "refresh",
      "stats",
      "status",
      "vector",
      "verify"
    ]);
    expect(
      rag?.commands
        .find((command) => command.name() === "provider")
        ?.commands.map((command) => command.name())
    ).toEqual(["status"]);
    expect(
      rag?.commands
        .find((command) => command.name() === "vector")
        ?.commands.find((command) => command.name() === "build")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--dry-run", "--execute", "--confirm"]));
    expect(
      rag?.commands
        .find((command) => command.name() === "refresh")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--compact", "--max-artifact-age-days"]));
    expect(
      rag?.commands
        .find((command) => command.name() === "compact")
        ?.options.map((option) => option.long)
    ).toContain("--max-artifact-age-days");
    expect(
      rag?.commands
        .find((command) => command.name() === "rebuild")
        ?.options.map((option) => option.long)
    ).toEqual(
      expect.arrayContaining(["--dry-run", "--compare", "--execute", "--confirm"])
    );
    expect(
      rag?.commands
        .find((command) => command.name() === "stats")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--duplicates", "--context-budget"]));
    expect(
      rag?.commands
        .find((command) => command.name() === "query")
        ?.options.map((option) => option.long)
    ).toEqual(
      expect.arrayContaining([
        "--type",
        "--collection",
        "--limit",
        "--task-id",
        "--run-id",
        "--approval-id",
        "--review-id",
        "--review-loop-id",
        "--date",
        "--severity",
        "--mode",
        "--explain"
      ])
    );
  });

  it("registers release helper commands", () => {
    const release = createProgram().commands.find(
      (command) => command.name() === "release"
    );

    expect(release?.commands.map((command) => command.name()).sort()).toEqual([
      "bump",
      "check",
      "github",
      "manifest",
      "notes",
      "pack",
      "provenance",
      "sbom",
      "validate",
      "verify"
    ]);
    expect(
      release?.commands.find((command) => command.name() === "validate")?.description()
    ).toContain("Validate synchronized versions");
    expect(
      release?.commands
        .find((command) => command.name() === "manifest")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--package", "--manifest", "--output"]));
    expect(
      release?.commands
        .find((command) => command.name() === "verify")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--manifest", "--release-manifest"]));
    expect(
      release?.commands
        .find((command) => command.name() === "notes")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--since", "--dry-run", "--write"]));
    expect(
      release?.commands
        .find((command) => command.name() === "bump")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--type", "--version", "--dry-run", "--write"]));
    const github = release?.commands.find((command) => command.name() === "github");
    expect(github?.commands.map((command) => command.name()).sort()).toEqual([
      "plan",
      "promote",
      "publish",
      "verify"
    ]);
    expect(
      github?.commands
        .find((command) => command.name() === "plan")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining([
      "--version",
      "--repository",
      "--base-branch",
      "--artifact-dir",
      "--stable",
      "--token-env"
    ]));
    expect(
      github?.commands
        .find((command) => command.name() === "publish")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--approval-id", "--confirm", "--token-env"]));
    const promote = github?.commands.find((command) => command.name() === "promote");
    expect(promote?.commands.map((command) => command.name()).sort()).toEqual([
      "apply",
      "plan"
    ]);
    expect(
      promote?.commands
        .find((command) => command.name() === "plan")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining([
      "--version",
      "--repository",
      "--base-branch",
      "--artifact-dir",
      "--expires-in-minutes",
      "--token-env"
    ]));
    expect(
      promote?.commands
        .find((command) => command.name() === "apply")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining([
      "--approval-id",
      "--confirm",
      "--token-env"
    ]));
  });

  it("registers Beta and Release Candidate readiness commands", () => {
    const readiness = createProgram().commands.find(
      (command) => command.name() === "readiness"
    );
    const manifest = readiness?.commands.find((command) => command.name() === "manifest");
    const check = readiness?.commands.find((command) => command.name() === "check");
    const report = readiness?.commands.find((command) => command.name() === "report");
    const rc = readiness?.commands.find((command) => command.name() === "rc");

    expect(readiness?.commands.map((command) => command.name()).sort()).toEqual([
      "check",
      "manifest",
      "rc",
      "report"
    ]);
    expect(manifest?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--evidence", "--output"])
    );
    expect(check?.options.map((option) => option.long)).toContain("--manifest");
    expect(report?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--manifest", "--format", "--output"])
    );
    expect(rc?.commands.map((command) => command.name()).sort()).toEqual([
      "check",
      "manifest",
      "report"
    ]);
    expect(
      rc?.commands
        .find((command) => command.name() === "manifest")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--evidence", "--output"]));
    expect(
      rc?.commands
        .find((command) => command.name() === "check")
        ?.options.map((option) => option.long)
    ).toContain("--manifest");
    expect(
      rc?.commands
        .find((command) => command.name() === "report")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--manifest", "--format", "--output"]));
  });

  it("registers verified update channel and lifecycle commands", () => {
    const update = createProgram().commands.find((command) => command.name() === "update");
    expect(update?.commands.map((command) => command.name()).sort()).toEqual([
      "apply",
      "channel",
      "check",
      "download",
      "rollback"
    ]);
    const channel = update?.commands.find((command) => command.name() === "channel");
    expect(channel?.commands.map((command) => command.name()).sort()).toEqual([
      "set",
      "show"
    ]);
    expect(
      channel?.commands
        .find((command) => command.name() === "set")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining([
      "--repository",
      "--base-branch",
      "--version",
      "--dry-run",
      "--write",
      "--confirm"
    ]));
    expect(
      update?.commands
        .find((command) => command.name() === "apply")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--confirm", "--dry-run", "--timeout-ms"]));
    expect(
      update?.commands
        .find((command) => command.name() === "rollback")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--to", "--confirm", "--dry-run"]));
  });

  it("registers merge and deploy dry-run approval commands", () => {
    const program = createProgram();
    const merge = program.commands.find((command) => command.name() === "merge");
    const deploy = program.commands.find((command) => command.name() === "deploy");

    expect(merge?.commands.map((command) => command.name()).sort()).toEqual([
      "dry-run",
      "execute"
    ]);
    expect(deploy?.commands.map((command) => command.name()).sort()).toEqual([
      "dry-run",
      "execute",
      "status"
    ]);
    expect(
      merge?.commands
        .find((command) => command.name() === "dry-run")
        ?.options.map((option) => option.long)
    ).toEqual(
      expect.arrayContaining([
        "--source",
        "--target",
        "--commit-range",
        "--check",
        "--rollback-hint",
        "--reason"
      ])
    );
    expect(
      deploy?.commands
        .find((command) => command.name() === "dry-run")
        ?.options.map((option) => option.long)
    ).toEqual(
      expect.arrayContaining([
        "--target",
        "--environment",
        "--provider",
        "--commit-range",
        "--check",
        "--rollback-hint",
        "--reason"
      ])
    );
    expect(
      merge?.commands
        .find((command) => command.name() === "execute")
        ?.options.map((option) => option.long)
    ).toEqual(
      expect.arrayContaining([
        "--dry-run-artifact",
        "--preflight",
        "--execute",
        "--expected-head-sha",
        "--actual-head-sha",
        "--required-check",
        "--approval-id",
        "--confirm"
      ])
    );
    expect(
      deploy?.commands
        .find((command) => command.name() === "execute")
        ?.options.map((option) => option.long)
    ).toEqual(
      expect.arrayContaining([
        "--dry-run-artifact",
        "--preflight",
        "--execute",
        "--provider",
        "--expected-head-sha",
        "--actual-head-sha",
        "--required-check",
        "--approval-id",
        "--confirm"
      ])
    );
  });

  it("registers git PR candidate commands", () => {
    const git = createProgram().commands.find((command) => command.name() === "git");
    const pr = git?.commands.find((command) => command.name() === "pr");

    expect(git?.description()).toContain("git artifacts");
    expect(pr?.commands.map((command) => command.name()).sort()).toEqual([
      "create",
      "list",
      "merge",
      "show"
    ]);
    expect(
      pr?.commands
        .find((command) => command.name() === "create")
        ?.options.map((option) => option.long)
    ).toEqual(
      expect.arrayContaining([
        "--dry-run",
        "--execute",
        "--approval-id",
        "--follow-up-id",
        "--confirm",
        "--repository",
        "--draft",
        "--token-env"
      ])
    );
  });

  it("registers Discord HTTP interactions server command", () => {
    const discord = createProgram().commands.find(
      (command) => command.name() === "discord"
    );
    const http = discord?.commands.find((command) => command.name() === "http");
    const start = http?.commands.find((command) => command.name() === "start");

    expect(discord?.description()).toContain("Discord integration");
    expect(http?.description()).toContain("HTTP Interactions");
    expect(http?.commands.map((command) => command.name()).sort()).toEqual([
      "start",
      "status"
    ]);
    expect(start?.description()).toContain("loopback-bound");
    expect(start?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining([
        "--profile",
        "--host",
        "--port",
        "--timestamp-tolerance-seconds",
        "--replay-ttl-seconds",
        "--max-seconds"
      ])
    );
  });
});
