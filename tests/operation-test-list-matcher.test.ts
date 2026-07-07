import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { summarizeOperationTestsCommand } from "../src/cli/commands/test-summary.js";
import type { OperationTestSummary } from "../src/operation-test/result-summary.js";
import {
  createOperationTestUpdateSuggestions,
  formatOperationTestUpdateSuggestions,
  parseOperationTestListAliases,
  parseOperationTestListMarkdown
} from "../src/operation-test/test-list-matcher.js";
import { createTempProject } from "./test-utils.js";

describe("operation test list matcher", () => {
  it("parses operation test Markdown rows and current result statuses", () => {
    const cases = parseOperationTestListMarkdown(
      [
        "| ID | Task | 観点 | 結果 | 備考 |",
        "|---|---|---|---|---|",
        "| OT-T88-01-01 | T88 | Log summary | NOT_RUN | pending |",
        "| OT-T88-01-02 | T88 | Existing pass | PASS | done |",
        "| OT-T88-01-03 | T88 | Japanese status | 未PASS | needs fix |",
        "| OT-T88-01-04 | T88 | Setup | SETUP_REQUIRED | env |",
        "| OT-T88-01-05 | T88 | Optional | OPTIONAL | live |",
        "| OT-T88-01-06 | T88 | Skipped | SKIP | out of scope |"
      ].join("\n")
    );

    expect(cases.map((testCase) => testCase.id)).toEqual([
      "OT-T88-01-01",
      "OT-T88-01-02",
      "OT-T88-01-03",
      "OT-T88-01-04",
      "OT-T88-01-05",
      "OT-T88-01-06"
    ]);
    expect(cases.map((testCase) => testCase.current_status)).toEqual([
      "NOT_RUN",
      "PASS",
      "UNPASSED",
      "SETUP_REQUIRED",
      "OPTIONAL",
      "SKIP"
    ]);
    expect(cases[0].task_id).toBe("T88");
    expect(cases[0].line).toBe(3);
  });

  it("parses test list aliases for loose summary result ids", () => {
    const aliases = parseOperationTestListAliases(
      [
        "<!-- kairon:alias git.branch_protection=OT-T116-01-01 -->",
        "<!-- kairon:alias KAIRON_TASK_RUN=RET-T116-01-02 -->"
      ].join("\n")
    );

    expect(aliases).toEqual([
      {
        source_id: "GIT_BRANCH_PROTECTION",
        target_id: "OT-T116-01-01",
        line: 1
      },
      {
        source_id: "KAIRON_TASK_RUN",
        target_id: "RET-T116-01-02",
        line: 2
      }
    ]);
  });

  it("creates non-destructive PASS and unpassed update candidates", () => {
    const summary: OperationTestSummary = {
      schema_version: "0.1",
      sources: ["operation-test-results/run-001/summary.json"],
      summary: {
        pass: 3,
        fail: 1,
        setup_required: 1,
        optional: 1,
        total: 6,
        source_files: 1
      },
      pass_ids: ["OT-T88-01-01", "OT-T88-01-02", "OT-T88-01-06"],
      fail_ids: ["OT-T88-01-03"],
      setup_required_ids: ["OT-T88-01-04"],
      optional_ids: ["OT-T88-01-05"],
      results: [
        {
          id: "OT-T88-01-01",
          status: "PASS",
          source: "operation-test-results/run-001/summary.json",
          details: "token=SHOULD_NOT_LEAK"
        },
        {
          id: "OT-T88-01-02",
          status: "PASS",
          source: "operation-test-results/run-001/summary.json"
        },
        {
          id: "OT-T88-01-03",
          status: "FAIL",
          source: "operation-test-results/run-001/summary.json"
        },
        {
          id: "OT-T88-01-04",
          status: "SETUP_REQUIRED",
          source: "operation-test-results/run-001/summary.json"
        },
        {
          id: "OT-T88-01-05",
          status: "OPTIONAL",
          source: "operation-test-results/run-001/summary.json"
        },
        {
          id: "OT-T88-01-06",
          status: "PASS",
          source: "operation-test-results/run-001/summary.json"
        },
        {
          id: "OT-T88-99-99",
          status: "PASS",
          source: "operation-test-results/run-001/summary.json"
        }
      ],
      warnings: []
    };

    const suggestions = createOperationTestUpdateSuggestions({
      projectRoot: "C:\\repo",
      testListPath: "C:\\repo\\docs\\operation-test-list.md",
      testListMarkdown: [
        "| ID | Task | 観点 | 結果 | 備考 |",
        "|---|---|---|---|---|",
        "| OT-T88-01-01 | T88 | Log summary | NOT_RUN | pending |",
        "| OT-T88-01-02 | T88 | Existing pass | PASS | done |",
        "| OT-T88-01-03 | T88 | Failure | NOT_RUN | pending |",
        "| OT-T88-01-04 | T88 | Setup | 未PASS | env |",
        "| OT-T88-01-05 | T88 | Optional | NOT_RUN | live |",
        "| OT-T88-01-06 | T88 | Unknown |  | blank |"
      ].join("\n"),
      summary,
      patchPreview: true
    });
    const output = formatOperationTestUpdateSuggestions(suggestions, {
      patchPreview: true
    });

    expect(suggestions.counts).toMatchObject({
      pass_update: 1,
      unpassed: 1,
      setup_required: 1,
      optional: 1,
      already_pass: 1,
      unknown_status: 1,
      missing_from_list: 1,
      total: 7
    });
    expect(output).toContain("candidate.id=OT-T88-01-01");
    expect(output).toContain("kind=pass_update");
    expect(output).toContain("patch_preview.after=| OT-T88-01-01 | T88 | Log summary | PASS | pending |");
    expect(output).toContain("candidate.id=OT-T88-99-99");
    expect(output).toContain("kind=missing_from_list");
    expect(output).not.toContain("SHOULD_NOT_LEAK");
    expect(output).toContain("token=[redacted]");
  });

  it("prints suggestions from the CLI command without editing the test list", async () => {
    const root = await createTempProject();
    const logPath = path.join(root, "summary.md");
    const testListPath = path.join(root, "operation-test-list.md");
    const originalList = [
      "| ID | Task | 観点 | 結果 | 備考 |",
      "|---|---|---|---|---|",
      "| OT-T88-01-01 | T88 | Summary | NOT_RUN | pending |",
      "| OT-T88-01-02 | T88 | Failure | NOT_RUN | pending |"
    ].join("\n");

    await writeFile(
      logPath,
      [
        "| ID | Name | Status | Details |",
        "|---|---|---|---|",
        "| OT-T88-01-01 | Summary | PASS | api_key=SHOULD_NOT_LEAK |",
        "| OT-T88-01-02 | Failure | FAIL | failed |"
      ].join("\n"),
      "utf8"
    );
    await writeFile(testListPath, originalList, "utf8");

    const output = await summarizeOperationTestsCommand(root, "summary.md", {
      testList: "operation-test-list.md",
      suggest: true,
      patchPreview: true
    });
    const jsonOutput = await summarizeOperationTestsCommand(root, "summary.md", {
      testList: "operation-test-list.md",
      suggest: true,
      json: true
    });

    expect(output).toContain("Kairon operation test update suggestions.");
    expect(output).toContain("candidates.pass_update=1");
    expect(output).toContain("candidates.unpassed=1");
    expect(output).toContain("patch_preview.after=| OT-T88-01-01 | T88 | Summary | PASS | pending |");
    expect(output).not.toContain("SHOULD_NOT_LEAK");
    expect(await readFile(testListPath, "utf8")).toBe(originalList);

    const parsed = JSON.parse(jsonOutput) as { counts: { pass_update: number } };
    expect(parsed.counts.pass_update).toBe(1);
  });

  it("prints suggestions for loose CLI summary results", async () => {
    const root = await createTempProject();
    const logPath = path.join(root, "manual-cli-log.txt");
    const testListPath = path.join(root, "operation-test-list.md");
    const originalList = [
      "| ID | Task | 観点 | 結果 | 備考 |",
      "|---|---|---|---|---|",
      "| GIT_BRANCH_PROTECTION | T99 | Branch protection | NOT_RUN | pending |",
      "| KAIRON_TASK_RUN | T102 | Task run | NOT_RUN | pending |"
    ].join("\n");

    await writeFile(
      logPath,
      [
        "PASS git.branch_protection GitHub branch protection",
        "Kairon task run failed.",
        "status=failed",
        "api_token=SHOULD_NOT_LEAK"
      ].join("\n"),
      "utf8"
    );
    await writeFile(testListPath, originalList, "utf8");

    const output = await summarizeOperationTestsCommand(root, "manual-cli-log.txt", {
      testList: "operation-test-list.md",
      suggest: true,
      patchPreview: true
    });

    expect(output).toContain("candidates.total=2");
    expect(output).toContain("candidates.missing_from_list=2");
    expect(output).toContain("candidate.id=GIT_BRANCH_PROTECTION");
    expect(output).toContain("candidate.id=KAIRON_TASK_RUN");
    expect(output).toContain("kind=missing_from_list");
    expect(output).toContain("patch_preview=(none)");
    expect(output).not.toContain("SHOULD_NOT_LEAK");
    expect(await readFile(testListPath, "utf8")).toBe(originalList);
  });

  it("maps loose CLI summary results through aliases before creating patch previews", async () => {
    const root = await createTempProject();
    const logPath = path.join(root, "manual-cli-log.txt");
    const testListPath = path.join(root, "operation-test-list.md");
    const originalList = [
      "<!-- kairon:alias GIT_BRANCH_PROTECTION=OT-T116-01-01 -->",
      "<!-- kairon:alias KAIRON_TASK_RUN=RET-T116-01-02 -->",
      "| ID | Task | 観点 | 結果 | 備考 |",
      "|---|---|---|---|---|",
      "| OT-T116-01-01 | T116 | Branch protection | NOT_RUN | pending |",
      "| RET-T116-01-02 | T116 | Task run | NOT_RUN | pending |"
    ].join("\n");

    await writeFile(
      logPath,
      [
        "PASS git.branch_protection GitHub branch protection",
        "Kairon task run failed.",
        "status=failed",
        "api_token=SHOULD_NOT_LEAK"
      ].join("\n"),
      "utf8"
    );
    await writeFile(testListPath, originalList, "utf8");

    const output = await summarizeOperationTestsCommand(root, "manual-cli-log.txt", {
      testList: "operation-test-list.md",
      suggest: true,
      patchPreview: true
    });
    const jsonOutput = await summarizeOperationTestsCommand(root, "manual-cli-log.txt", {
      testList: "operation-test-list.md",
      suggest: true,
      json: true
    });

    expect(output).toContain("aliases.total=2");
    expect(output).toContain("candidates.total=2");
    expect(output).toContain("candidates.pass_update=1");
    expect(output).toContain("candidates.unpassed=1");
    expect(output).toContain("candidates.missing_from_list=0");
    expect(output).toContain("candidate.id=OT-T116-01-01 original_id=GIT_BRANCH_PROTECTION");
    expect(output).toContain("candidate.id=RET-T116-01-02 original_id=KAIRON_TASK_RUN");
    expect(output).toContain("patch_preview.after=| OT-T116-01-01 | T116 | Branch protection | PASS | pending |");
    expect(output).not.toContain("SHOULD_NOT_LEAK");
    expect(await readFile(testListPath, "utf8")).toBe(originalList);

    const parsed = JSON.parse(jsonOutput) as {
      alias_count: number;
      counts: { pass_update: number; missing_from_list: number };
      candidates: Array<{ id: string; original_id?: string }>;
    };
    expect(parsed.alias_count).toBe(2);
    expect(parsed.counts.pass_update).toBe(1);
    expect(parsed.counts.missing_from_list).toBe(0);
    expect(parsed.candidates[0]).toMatchObject({
      id: "OT-T116-01-01",
      original_id: "GIT_BRANCH_PROTECTION"
    });
  });

  it("keeps unresolved aliases as missing candidates with the original summary id", async () => {
    const root = await createTempProject();
    const logPath = path.join(root, "manual-cli-log.txt");
    const testListPath = path.join(root, "operation-test-list.md");
    const originalList = [
      "<!-- kairon:alias GIT_BRANCH_PROTECTION=OT-T116-99-99 -->",
      "| ID | Task | 観点 | 結果 | 備考 |",
      "|---|---|---|---|---|",
      "| OT-T116-01-01 | T116 | Branch protection | NOT_RUN | pending |"
    ].join("\n");

    await writeFile(
      logPath,
      "PASS git.branch_protection GitHub branch protection\n",
      "utf8"
    );
    await writeFile(testListPath, originalList, "utf8");

    const output = await summarizeOperationTestsCommand(root, "manual-cli-log.txt", {
      testList: "operation-test-list.md",
      suggest: true,
      patchPreview: true
    });

    expect(output).toContain("candidate.id=OT-T116-99-99 original_id=GIT_BRANCH_PROTECTION");
    expect(output).toContain("kind=missing_from_list");
    expect(output).toContain("patch_preview=(none)");
  });

  it("uses the latest conflicting alias and reports an alias warning", async () => {
    const root = await createTempProject();
    const logPath = path.join(root, "manual-cli-log.txt");
    const testListPath = path.join(root, "operation-test-list.md");
    const originalList = [
      "<!-- kairon:alias GIT_BRANCH_PROTECTION=OT-T116-01-00 -->",
      "<!-- kairon:alias GIT_BRANCH_PROTECTION=OT-T116-01-01 -->",
      "| ID | Task | 観点 | 結果 | 備考 |",
      "|---|---|---|---|---|",
      "| OT-T116-01-01 | T116 | Branch protection | NOT_RUN | pending |"
    ].join("\n");

    await writeFile(
      logPath,
      "PASS git.branch_protection GitHub branch protection\n",
      "utf8"
    );
    await writeFile(testListPath, originalList, "utf8");

    const output = await summarizeOperationTestsCommand(root, "manual-cli-log.txt", {
      testList: "operation-test-list.md",
      suggest: true,
      patchPreview: true
    });

    expect(output).toContain("aliases.total=1");
    expect(output).toContain("alias_warning=Alias GIT_BRANCH_PROTECTION redefined from OT-T116-01-00 to OT-T116-01-01 at line 2; using latest.");
    expect(output).toContain("candidate.id=OT-T116-01-01 original_id=GIT_BRANCH_PROTECTION");
    expect(output).toContain("kind=pass_update");
  });
});
