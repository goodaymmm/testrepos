import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { summarizeOperationTestsCommand } from "../src/cli/commands/test-summary.js";
import {
  formatOperationTestSummary,
  summarizeOperationTestResults
} from "../src/operation-test/result-summary.js";
import { createTempProject } from "./test-utils.js";

describe("operation test result summary", () => {
  it("extracts statuses from pasted PowerShell text and Markdown tables", async () => {
    const root = await createTempProject();
    const logPath = path.join(root, "pasted-result.txt");
    await writeFile(
      logPath,
      [
        "[OT-T88-01-01] PASS",
        "[DISCORD_LIVE_READY] SETUP_REQUIRED missing token=secret-token-for-test",
        "| ID | Name | Status | Details |",
        "|---|---|---|---|",
        "| OT-T88-01-02 | Smoke | FAIL | Bearer abc.def.ghi was rejected |",
        "| OPTIONAL_CASE | Manual | OPTIONAL | secret: hidden-value |"
      ].join("\n"),
      "utf8"
    );

    const summary = await summarizeOperationTestResults({
      projectRoot: root,
      logFile: logPath
    });
    const output = formatOperationTestSummary(summary);

    expect(summary.pass_ids).toEqual(["OT-T88-01-01"]);
    expect(summary.fail_ids).toEqual(["OT-T88-01-02"]);
    expect(summary.setup_required_ids).toEqual(["DISCORD_LIVE_READY"]);
    expect(summary.optional_ids).toEqual(["OPTIONAL_CASE"]);
    expect(output).toContain("pass_ids=OT-T88-01-01");
    expect(output).toContain("fail_ids=OT-T88-01-02");
    expect(output).toContain("setup_required_ids=DISCORD_LIVE_READY");
    expect(output).not.toContain("secret-token-for-test");
    expect(output).not.toContain("abc.def.ghi");
    expect(output).not.toContain("hidden-value");
    expect(output).toContain("token=[redacted]");
    expect(output).toContain("Bearer [redacted]");
    expect(output).toContain("secret=[redacted]");
  });

  it("summarizes operation-test-results roots without emitting raw evidence", async () => {
    const root = await createTempProject();
    const runRoot = path.join(root, "operation-test-results", "run-001");
    await mkdir(runRoot, { recursive: true });
    await writeFile(
      path.join(runRoot, "summary.json"),
      JSON.stringify(
        {
          schema_version: "0.1",
          results: [
            {
              id: "BUILD",
              name: "Build",
              status: "PASS",
              details: "passed",
              evidence: "token=SHOULD_NOT_LEAK"
            },
            {
              id: "DOCTOR",
              name: "Doctor",
              status: "FAIL",
              details: "api_key=SHOULD_NOT_LEAK failed"
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      path.join(runRoot, "summary.md"),
      [
        "| ID | Name | Status | Details |",
        "|---|---|---|---|",
        "| DISCORD_SETUP_ERROR | Discord setup | SETUP_REQUIRED | password=SHOULD_NOT_LEAK |"
      ].join("\n"),
      "utf8"
    );

    const output = await summarizeOperationTestsCommand(root, undefined, {
      resultRoot: "operation-test-results"
    });

    expect(output).toContain("sources=2");
    expect(output).toContain("total=3");
    expect(output).toContain("pass_ids=BUILD");
    expect(output).toContain("fail_ids=DOCTOR");
    expect(output).toContain("setup_required_ids=DISCORD_SETUP_ERROR");
    expect(output).toContain(
      "evidence_paths=operation-test-results/run-001/summary.json,operation-test-results/run-001/summary.md"
    );
    expect(output).not.toContain("SHOULD_NOT_LEAK");
    expect(output).toContain("api_key=[redacted]");
    expect(output).toContain("password=[redacted]");
  });

  it("ignores backed-up Kairon state and non-summary logs inside result roots", async () => {
    const root = await createTempProject();
    const resultRoot = path.join(root, "operation-test-results", "manual-run");
    const currentRunRoot = path.join(resultRoot, "20260620-112253");
    const backupRunRoot = path.join(
      resultRoot,
      "target-kairon-state-backup",
      "tmp",
      "2026-06-13",
      "operation-test-results",
      "old-run",
      "20260612-190014"
    );
    await mkdir(currentRunRoot, { recursive: true });
    await mkdir(backupRunRoot, { recursive: true });

    await writeFile(
      path.join(currentRunRoot, "summary.json"),
      JSON.stringify(
        {
          schema_version: "0.1",
          results: [
            {
              id: "CURRENT_RESULT",
              name: "Current result",
              status: "PASS",
              details: "passed"
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      path.join(backupRunRoot, "summary.md"),
      [
        "| ID | Name | Status | Details |",
        "|---|---|---|---|",
        "| STALE_BACKUP_RESULT | Old failure | FAIL | stale backup should be ignored |"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(resultRoot, "pasted-log.txt"),
      "[LOG_ONLY_RESULT] FAIL this non-summary log should be ignored for result roots\n",
      "utf8"
    );

    const output = await summarizeOperationTestsCommand(root, undefined, {
      resultRoot: path.join("operation-test-results", "manual-run")
    });

    expect(output).toContain("sources=1");
    expect(output).toContain("total=1");
    expect(output).toContain("pass_ids=CURRENT_RESULT");
    expect(output).toContain("fail_ids=(none)");
    expect(output).not.toContain("STALE_BACKUP_RESULT");
    expect(output).not.toContain("LOG_ONLY_RESULT");
    expect(output).not.toContain("target-kairon-state-backup");
    expect(output).not.toContain("pasted-log.txt");
  });

  it("requires either a log file or a result root", async () => {
    const root = await createTempProject();

    await expect(
      summarizeOperationTestResults({ projectRoot: root })
    ).rejects.toThrow("Specify a log file or --result-root.");
  });
});
