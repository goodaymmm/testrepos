import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateOperationTestDocsCommand } from "../src/cli/commands/test-commands.js";
import {
  buildOperationTestDocs,
  writeOperationTestDocs
} from "../src/operation-test/test-doc-generator.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("operation test document generator", () => {
  it("builds operation test list and command documents from a task range", () => {
    const result = buildOperationTestDocs("/repo", {
      range: "T130-T131"
    });

    expect(result.range).toBe("T130-T131");
    expect(result.name_prefix).toBe("t130-t131");
    expect(result.files.map((file) => file.path)).toEqual([
      "docs/t130-t131-operation-test-list-v0.md",
      "docs/t130-t131-operation-test-commands-v0.md"
    ]);

    const testList = result.files.find((file) => file.kind === "test_list")?.content ?? "";
    const commands = result.files.find((file) => file.kind === "command_list")?.content ?? "";

    expect(testList).toContain("# T130-T131 操作テストリスト v0");
    expect(testList).toContain("Push / commit 対象外");
    expect(testList).toContain("| OT-T130-01 | T130 | Operation Test PASS-only Safe Apply | NOT_RUN | pending |");
    expect(testList).toContain("| OT-T131-01-05 | Secret safety |");
    expect(testList).toContain("OT-T130T131-FINAL-03");
    expect(commands).toContain("# T130-T131 操作テスト実行コマンド v0");
    expect(commands).toContain("$KAIRON = \"C:\\Users\\hikar\\Documents\\AutoRunner\"");
    expect(commands).toContain("function Save-ManualEvidence");
    expect(commands).toContain("kairon test summarize `");
    expect(commands).not.toContain("node -e");
    expect(commands).not.toContain("Bearer ");
    expect(commands).not.toContain("SHOULD_NOT_LEAK");
  });

  it("writes generated docs and refuses accidental overwrite", async () => {
    const root = await makeTemporaryProject();
    const first = await writeOperationTestDocs(root, {
      range: "T131",
      namePrefix: "manual-t131"
    });

    expect(first.files.every((file) => file.written)).toBe(true);
    expect(first.files.every((file) => file.overwritten === false)).toBe(true);

    const listPath = path.join(root, "docs", "manual-t131-operation-test-list-v0.md");
    await expect(readFile(listPath, "utf8")).resolves.toContain("# T131 操作テストリスト v0");
    await expect(
      writeOperationTestDocs(root, {
        range: "T131",
        namePrefix: "manual-t131"
      })
    ).rejects.toThrow("Pass --overwrite to replace it");

    const overwritten = await writeOperationTestDocs(root, {
      range: "T131",
      namePrefix: "manual-t131",
      overwrite: true
    });
    expect(overwritten.files.every((file) => file.overwritten)).toBe(true);
  });

  it("supports dry-run without writing files", async () => {
    const root = await makeTemporaryProject();
    const output = await generateOperationTestDocsCommand(root, {
      range: "T132-T133",
      dryRun: true
    });

    expect(output).toContain("Kairon operation test docs generated.");
    expect(output).toContain("range=T132-T133");
    expect(output).toContain("dry_run=true");
    expect(output).toContain("test_list.written=false");
    await expect(
      readFile(path.join(root, "docs", "t132-t133-operation-test-list-v0.md"), "utf8")
    ).rejects.toThrow();
  });

  it("builds a source-bound Stable acceptance bundle and carries only prior PASS", () => {
    const sourceCommit = "a".repeat(40);
    const result = buildOperationTestDocs("/repo", {
      range: "T176-T189",
      template: "stable-acceptance",
      resultRoot: "operation-test-results/stable-run",
      sourceCommit,
      generatedAt: new Date("2026-07-27T00:00:00.000Z"),
      previousResultRoot: "operation-test-results/previous-run",
      previousPassIds: ["OT-T176-01-01", "OT-T177-01-01", "UNKNOWN_CASE"]
    });

    expect(result.template).toBe("stable-acceptance");
    expect(result.range).toBe("T176-T189");
    expect(result.run_id).toBe("STABLE-20260727000000");
    expect(result.source_commit).toBe(sourceCommit);
    expect(result.files.map((file) => file.kind)).toEqual([
      "test_list",
      "command_list",
      "evidence_manifest",
      "cleanup_plan"
    ]);
    expect(result.carried_pass_ids).toEqual([
      "OT-T176-01-01",
      "OT-T177-01-01"
    ]);
    expect(result.selected_test_ids).not.toContain("OT-T176-01-01");
    expect(result.selected_test_ids).toContain("OT-T189-01-04");

    const testList =
      result.files.find((file) => file.kind === "test_list")?.content ?? "";
    const commands =
      result.files.find((file) => file.kind === "command_list")?.content ?? "";
    const manifest = JSON.parse(
      result.files.find((file) => file.kind === "evidence_manifest")?.content ?? "{}"
    ) as {
      kind: string;
      source_commit: string;
      documents: Array<{ sha256: string }>;
      scenarios: Array<{
        test_id: string;
        status: string;
        carried_from_previous: boolean;
      }>;
    };
    const cleanup = JSON.parse(
      result.files.find((file) => file.kind === "cleanup_plan")?.content ?? "{}"
    ) as {
      safety: { exact_ids_only: boolean; created_by_harness_only: boolean };
      resources: Array<{ exact_id: unknown; cleanup_status: string }>;
    };

    expect(testList).toContain(
      "<!-- kairon:alias STABLE_PROMOTION_LIVE=OT-T179-01-01 -->"
    );
    expect(testList).toContain(
      "<!-- kairon:alias STABLE_ACCEPTANCE_MANIFEST=OT-T189-01-04 -->"
    );
    expect(testList).toContain("external_required");
    expect(commands).toContain("<!-- command-group: WINDOWS_SANDBOX -->");
    expect(commands).toContain("<!-- command-group: WINDOWS_REBOOT_BEFORE -->");
    expect(commands).toContain("<!-- command-group: WINDOWS_REBOOT_AFTER -->");
    expect(commands).toContain("<!-- command-group: CLEANUP -->");
    expect(commands).not.toContain("Bearer ");
    expect(commands).not.toContain("Remove-Item *");
    expect(manifest.kind).toBe("stable_acceptance_evidence_manifest");
    expect(manifest.source_commit).toBe(sourceCommit);
    expect(manifest.documents.every((document) => /^[a-f0-9]{64}$/.test(document.sha256)))
      .toBe(true);
    expect(manifest.scenarios).toHaveLength(18);
    expect(
      manifest.scenarios.find((scenario) => scenario.test_id === "OT-T176-01-01")
    ).toMatchObject({
      status: "PASS",
      carried_from_previous: true
    });
    expect(cleanup.safety).toEqual({
      exact_ids_only: true,
      created_by_harness_only: true,
      missing_id_action: "skip"
    });
    expect(
      cleanup.resources.every(
        (resource) =>
          resource.exact_id === null && resource.cleanup_status === "not_created"
      )
    ).toBe(true);
  });

  it("writes Stable acceptance docs and result artifacts to separate roots", async () => {
    const root = await makeTemporaryProject();
    const result = await writeOperationTestDocs(root, {
      range: "T176-T189",
      template: "stable-acceptance",
      resultRoot: "operation-test-results/stable-run",
      sourceCommit: "b".repeat(40),
      generatedAt: new Date("2026-07-27T01:02:03.000Z")
    });

    expect(result.files.every((file) => file.written)).toBe(true);
    await expect(
      readFile(
        path.join(root, "operation-test-results", "stable-run", "evidence-manifest.json"),
        "utf8"
      )
    ).resolves.toContain('"kind": "stable_acceptance_evidence_manifest"');
    await expect(
      readFile(path.join(root, "operation-test-results", "stable-run", "cleanup-plan.json"), "utf8")
    ).resolves.toContain('"exact_ids_only": true');
  });

  it("rejects unsafe paths and invalid prefixes", async () => {
    expect(() =>
      buildOperationTestDocs("/repo", {
        range: "T131",
        namePrefix: "../bad"
      })
    ).toThrow("Invalid --name-prefix");

    expect(() =>
      buildOperationTestDocs("/repo", {
        range: "T131",
        outputDir: "../outside"
      })
    ).toThrow("Path must stay inside the project root");

    expect(() =>
      buildOperationTestDocs("/repo", {
        range: "T176-T189",
        template: "stable-acceptance",
        resultRoot: "../outside",
        sourceCommit: "a".repeat(40)
      })
    ).toThrow("Path must stay inside the project root");

    expect(() =>
      buildOperationTestDocs("/repo", {
        range: "T176-T188",
        template: "stable-acceptance",
        resultRoot: "operation-test-results/stable-run",
        sourceCommit: "a".repeat(40)
      })
    ).toThrow("requires the complete T176-T189 range");

    expect(() =>
      buildOperationTestDocs("/repo", {
        range: "T176-T189",
        template: "stable-acceptance",
        resultRoot: "operation-test-results/stable-run",
        previousResultRoot: "operation-test-results/stable-run",
        sourceCommit: "a".repeat(40)
      })
    ).toThrow("must use a new result root");
  });
});

async function makeTemporaryProject(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kairon-doc-generator-"));
  temporaryDirectories.push(directory);
  return directory;
}
