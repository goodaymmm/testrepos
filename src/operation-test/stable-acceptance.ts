import { createHash } from "node:crypto";
import path from "node:path";
import { toPosixPath } from "../core/fs/paths.js";

export type StableAcceptanceClassification = "required" | "external_required";

export type StableAcceptanceCheckpoint =
  | "automated"
  | "windows_sandbox"
  | "separate_terminal"
  | "discord_visual"
  | "smartphone_visual"
  | "windows_reboot"
  | "cleanup";

export type StableAcceptanceScenario = {
  test_id: string;
  task_id: string;
  alias: string;
  title: string;
  classification: StableAcceptanceClassification;
  checkpoint: StableAcceptanceCheckpoint;
  evidence_alias: string;
  test_files: string[];
  expected: string;
};

export type StableAcceptanceManifestScenario = StableAcceptanceScenario & {
  status:
    | "NOT_RUN"
    | "PASS"
    | "UNPASSED"
    | "SETUP_REQUIRED"
    | "OPTIONAL"
    | "UNKNOWN";
  carried_from_previous: boolean;
  evidence_paths: string[];
};

export type StableAcceptanceEvidenceManifest = {
  schema_version: "0.1";
  kind: "stable_acceptance_evidence_manifest";
  run_id: string;
  status: "planned" | "completed" | "incomplete";
  source_commit: string;
  result_root: string;
  previous_result_root: string | null;
  selected_test_ids: string[];
  carried_pass_ids: string[];
  documents: Array<{
    alias: string;
    path: string;
    sha256: string;
  }>;
  scenarios: StableAcceptanceManifestScenario[];
  cleanup_plan_path: string;
  generated_at: string;
  completed_at?: string;
};

export type StableAcceptanceCleanupResourceType =
  | "github_release"
  | "github_tag"
  | "temporary_credential"
  | "scheduled_task"
  | "tunnel_process"
  | "windows_sandbox"
  | "temporary_directory";

export type StableAcceptanceCleanupPlan = {
  schema_version: "0.1";
  kind: "stable_acceptance_cleanup_plan";
  run_id: string;
  source_commit: string;
  status: "planned" | "completed";
  confirmation: string;
  safety: {
    exact_ids_only: true;
    created_by_harness_only: true;
    missing_id_action: "skip";
  };
  resources: Array<{
    alias: string;
    type: StableAcceptanceCleanupResourceType;
    exact_id: string | null;
    created_by_harness: true;
    cleanup_status: "not_created" | "deleted" | "verified_absent";
  }>;
  generated_at: string;
};

export type StableAcceptanceBundleOptions = {
  outputDir?: string;
  resultRoot: string;
  namePrefix?: string;
  sourceCommit: string;
  generatedAt?: Date;
  previousResultRoot?: string;
  previousPassIds?: string[];
};

export type StableAcceptanceBundleFile = {
  kind: "test_list" | "command_list" | "evidence_manifest" | "cleanup_plan";
  path: string;
  content: string;
};

export type StableAcceptanceBundle = {
  range: "T176-T189";
  name_prefix: string;
  output_dir: string;
  result_root: string;
  run_id: string;
  source_commit: string;
  selected_test_ids: string[];
  carried_pass_ids: string[];
  files: StableAcceptanceBundleFile[];
};

const stableAcceptanceScenarios: StableAcceptanceScenario[] = [
  scenario("T176", "01-01", "STABLE_BASELINE_DOCS", "RC baseline documentation", "required", "automated",
    ["tests/documentation-inventory.test.ts", "tests/pr-release-docs.test.ts", "tests/cli.test.ts"],
    "T175 RC baseline、14 gate、現行CLIの文書整合性がPASSする"),
  scenario("T177", "01-01", "STABLE_RELEASE_ARTIFACT", "Reproducible 0.3.0 package", "required", "automated",
    ["tests/release-command.test.ts", "tests/release-manifest.test.ts", "tests/local-beta-package.test.ts"],
    "clean sourceにbindされた0.3.0 packageをpack / verifyできる"),
  scenario("T178", "01-01", "STABLE_RELEASE_PROVENANCE", "SBOM and provenance", "required", "automated",
    ["tests/release-sbom.test.ts", "tests/release-provenance.test.ts", "tests/release-manifest.test.ts"],
    "SBOM、provenance、release manifestのdigestを相互検証できる"),
  scenario("T179", "01-01", "STABLE_PROMOTION_LIVE", "GitHub Stable promotion", "external_required", "separate_terminal",
    ["tests/github-release-command.test.ts", "tests/github-release-client.test.ts", "tests/update-channel.test.ts"],
    "test prereleaseを同一assetのままStableへ昇格し、作成release / tagをcleanupする"),
  scenario("T180", "01-01", "STABLE_SCHEMA_MIGRATION", "Config and state migration", "required", "automated",
    ["tests/migrate-config.test.ts", "tests/schema-evolution.test.ts", "tests/state-integrity.test.ts"],
    "0.2.0 fixtureをbackup付きで移行し、再実行がidempotentになる"),
  scenario("T181", "01-01", "STABLE_TRANSACTIONAL_UPDATE", "Transactional update and rollback", "external_required", "windows_sandbox",
    ["tests/update-transaction.test.ts", "tests/update-command.test.ts", "tests/update-registry.test.ts"],
    "Clean Windowsで0.2.0から0.3.0へ更新し、rollback後に再updateできる"),
  scenario("T182", "01-01", "STABLE_OBSERVABILITY_SLO", "Runtime metrics and SLO", "required", "automated",
    ["tests/runtime-metrics.test.ts", "tests/slo.test.ts", "tests/runtime-loop.test.ts"],
    "local metrics、daily rollup、SLO分類をsecretなしで生成できる"),
  scenario("T183", "01-01", "STABLE_ALERT_POLICY_LIVE", "Discord alert escalation", "external_required", "discord_visual",
    ["tests/alert-policy.test.ts", "tests/runtime-watchdog.test.ts"],
    "open / escalate / defer / resolve通知がDiscordへ重複せず到達する"),
  scenario("T184", "01-01", "STABLE_SELF_HEALING", "Bounded self-healing", "required", "automated",
    ["tests/self-healing.test.ts", "tests/runtime-recovery.test.ts", "tests/incident-lifecycle.test.ts"],
    "allowlist actionだけをbudget内で実行し、危険操作を拒否する"),
  scenario("T185", "01-01", "STABLE_MULTI_PROJECT_SCHEDULE", "Scheduled multi-project health", "required", "separate_terminal",
    ["tests/project-scheduled-health.test.ts", "tests/project-supervisor.test.ts", "tests/windows-daemon-task.test.ts"],
    "2 projectをread-only scanし、temporary scheduled taskをexact nameで解除する"),
  scenario("T186", "01-01", "STABLE_OFF_DEVICE_DR", "Off-device DR rehearsal", "external_required", "separate_terminal",
    ["tests/disaster-recovery.test.ts", "tests/state-backup.test.ts", "tests/state-integrity.test.ts"],
    "project外backupだけからisolated rehearsalを完了する"),
  scenario("T187", "01-01", "STABLE_PERFORMANCE_BUDGET", "Performance regression budget", "required", "automated",
    ["tests/performance-budget.test.ts", "tests/work-queue.test.ts", "tests/workflow-checkpoint-store.test.ts"],
    "representative benchmarkが絶対値budgetとbaseline比を満たす"),
  scenario("T188", "01-01", "STABLE_SECURITY_BASELINE", "Offline security baseline", "required", "automated",
    ["tests/security-baseline.test.ts", "tests/support-bundle.test.ts", "tests/discord-http-server.test.ts"],
    "offline security baselineにhigh / critical findingとsecret exposureがない"),
  scenario("T188", "01-02", "STABLE_DEPENDENCY_AUDIT", "Network dependency audit", "external_required", "separate_terminal",
    ["tests/security-baseline.test.ts"],
    "timestamp付きnpm audit evidenceでhigh / critical findingが0になる"),
  scenario("T189", "01-01", "STABLE_WORKFLOW_STACK", "Workflow, session, capability, and hybrid RAG", "required", "automated",
    ["tests/workflow-runtime.test.ts", "tests/session-budget.test.ts", "tests/capability-policy.test.ts", "tests/rag-retriever.test.ts"],
    "branch / join / checkpoint rebuild、session rotation、capability deny、hybrid RAGがPASSする"),
  scenario("T189", "01-02", "STABLE_REMOTE_IDENTITY", "Discord decision and remote Board identity", "external_required", "smartphone_visual",
    ["tests/discord-http-interactions.test.ts", "tests/board-server.test.ts", "tests/remote-profile.test.ts"],
    "Discord decision、stable remote Board、未許可identity拒否を実端末で確認する"),
  scenario("T189", "01-03", "STABLE_REBOOT_RESUME", "Windows reboot resume", "external_required", "windows_reboot",
    ["tests/windows-daemon-task.test.ts", "tests/runtime-recovery.test.ts"],
    "OS再起動後にdaemon、checkpoint、監視状態を安全に再開できる"),
  scenario("T189", "01-04", "STABLE_ACCEPTANCE_CLEANUP", "Exact resource cleanup", "required", "cleanup",
    ["tests/operation-test-harness.test.ts", "tests/operation-test-doc-generator.test.ts"],
    "harnessが作成したexact IDのresourceだけを削除し、残存resourceが0になる")
];

const cleanupResourceTemplates: Array<{
  alias: string;
  type: StableAcceptanceCleanupResourceType;
}> = [
  { alias: "TEST_GITHUB_RELEASE", type: "github_release" },
  { alias: "TEST_GITHUB_TAG", type: "github_tag" },
  { alias: "TEST_TEMPORARY_CREDENTIAL", type: "temporary_credential" },
  { alias: "TEST_SCHEDULED_TASK", type: "scheduled_task" },
  { alias: "TEST_TUNNEL_PROCESS", type: "tunnel_process" },
  { alias: "TEST_WINDOWS_SANDBOX", type: "windows_sandbox" },
  { alias: "TEST_TEMPORARY_DIRECTORY", type: "temporary_directory" }
];

export function listStableAcceptanceScenarios(): StableAcceptanceScenario[] {
  return stableAcceptanceScenarios.map((entry) => ({
    ...entry,
    test_files: [...entry.test_files]
  }));
}

export function buildStableAcceptanceBundle(
  projectRoot: string,
  options: StableAcceptanceBundleOptions
): StableAcceptanceBundle {
  const root = path.resolve(projectRoot);
  const sourceCommit = normalizeSourceCommit(options.sourceCommit);
  const generatedAt = options.generatedAt ?? new Date();
  const runId = `STABLE-${formatTimestamp(generatedAt)}`;
  const namePrefix = normalizeNamePrefix(options.namePrefix ?? "t176-t189-stable-acceptance");
  const outputDir = resolveInsideRoot(root, options.outputDir ?? "docs");
  const resultRoot = resolveInsideRoot(root, options.resultRoot);
  const previousResultRoot =
    options.previousResultRoot === undefined
      ? null
      : toDisplayPath(root, resolveInsideRoot(root, options.previousResultRoot));
  if (
    previousResultRoot !== null &&
    path.resolve(root, previousResultRoot) === resultRoot
  ) {
    throw new Error(
      "Stable acceptance rerun must use a new result root and preserve previous evidence."
    );
  }
  const knownIds = new Set(stableAcceptanceScenarios.map((entry) => entry.test_id));
  const carriedPassIds = [...new Set(options.previousPassIds ?? [])]
    .map((id) => id.trim().toUpperCase())
    .filter((id) => knownIds.has(id))
    .sort();
  const carriedPassSet = new Set(carriedPassIds);
  const selectedTestIds = stableAcceptanceScenarios
    .map((entry) => entry.test_id)
    .filter((id) => !carriedPassSet.has(id));
  const listPath = path.join(outputDir, `${namePrefix}-test-list-v0.md`);
  const commandPath = path.join(outputDir, `${namePrefix}-commands-v0.md`);
  const manifestPath = path.join(resultRoot, "evidence-manifest.json");
  const cleanupPath = path.join(resultRoot, "cleanup-plan.json");
  const generatedAtText = generatedAt.toISOString();
  const cleanupPlan: StableAcceptanceCleanupPlan = {
    schema_version: "0.1",
    kind: "stable_acceptance_cleanup_plan",
    run_id: runId,
    source_commit: sourceCommit,
    status: "planned",
    confirmation: runId,
    safety: {
      exact_ids_only: true,
      created_by_harness_only: true,
      missing_id_action: "skip"
    },
    resources: cleanupResourceTemplates.map((resource) => ({
      ...resource,
      exact_id: null,
      created_by_harness: true,
      cleanup_status: "not_created"
    })),
    generated_at: generatedAtText
  };
  const cleanupContent = toJson(cleanupPlan);
  const listContent = renderStableTestList(namePrefix);
  const commandContent = renderStableCommandList({
    resultRoot: toDisplayPath(root, resultRoot),
    testListPath: toDisplayPath(root, listPath),
    manifestPath: toDisplayPath(root, manifestPath),
    cleanupPath: toDisplayPath(root, cleanupPath)
  });
  const documents = [
    documentBinding("TEST_LIST", root, listPath, listContent),
    documentBinding("COMMAND_LIST", root, commandPath, commandContent),
    documentBinding("CLEANUP_PLAN", root, cleanupPath, cleanupContent)
  ];
  const manifest: StableAcceptanceEvidenceManifest = {
    schema_version: "0.1",
    kind: "stable_acceptance_evidence_manifest",
    run_id: runId,
    status: "planned",
    source_commit: sourceCommit,
    result_root: toDisplayPath(root, resultRoot),
    previous_result_root: previousResultRoot,
    selected_test_ids: selectedTestIds,
    carried_pass_ids: carriedPassIds,
    documents,
    scenarios: stableAcceptanceScenarios.map((entry) => ({
      ...entry,
      test_files: [...entry.test_files],
      status: carriedPassSet.has(entry.test_id) ? "PASS" : "NOT_RUN",
      carried_from_previous: carriedPassSet.has(entry.test_id),
      evidence_paths: []
    })),
    cleanup_plan_path: toDisplayPath(root, cleanupPath),
    generated_at: generatedAtText
  };

  return {
    range: "T176-T189",
    name_prefix: namePrefix,
    output_dir: toDisplayPath(root, outputDir),
    result_root: toDisplayPath(root, resultRoot),
    run_id: runId,
    source_commit: sourceCommit,
    selected_test_ids: selectedTestIds,
    carried_pass_ids: carriedPassIds,
    files: [
      { kind: "test_list", path: toDisplayPath(root, listPath), content: listContent },
      { kind: "command_list", path: toDisplayPath(root, commandPath), content: commandContent },
      { kind: "evidence_manifest", path: toDisplayPath(root, manifestPath), content: toJson(manifest) },
      { kind: "cleanup_plan", path: toDisplayPath(root, cleanupPath), content: cleanupContent }
    ]
  };
}

function scenario(
  taskId: string,
  suffix: string,
  alias: string,
  title: string,
  classification: StableAcceptanceClassification,
  checkpoint: StableAcceptanceCheckpoint,
  testFiles: string[],
  expected: string
): StableAcceptanceScenario {
  return {
    test_id: `OT-${taskId}-${suffix}`,
    task_id: taskId,
    alias,
    title,
    classification,
    checkpoint,
    evidence_alias: `${alias}_EVIDENCE`,
    test_files: testFiles,
    expected
  };
}

function renderStableTestList(namePrefix: string): string {
  return `${[
    "# T176-T189 Stable End-to-End Acceptance テストリスト v0",
    "",
    "## 位置づけ",
    "",
    "- T176-T188の成果とT189のcross-system境界をStable判定前に再検証する。",
    `- 実行コマンド: \`docs/${namePrefix}-commands-v0.md\``,
    "- この生成文書とoperation-test-resultsはローカル保持用であり、commit / Pushしない。",
    "- `external_required`は外部環境不足時に`SETUP_REQUIRED`とし、自動PASSへ変更しない。",
    "- credential値、Discord / GitHub token、Authorization headerを証跡へ記録しない。",
    "",
    "## Summary alias",
    "",
    ...stableAcceptanceScenarios.map(
      (entry) => `<!-- kairon:alias ${entry.alias}=${entry.test_id} -->`
    ),
    "<!-- kairon:alias STABLE_ACCEPTANCE_MANIFEST=OT-T189-01-04 -->",
    "",
    "## テスト一覧",
    "",
    "| ID | Task | 分類 | Checkpoint | 観点 | 期待結果 | 結果 |",
    "|---|---|---|---|---|---|---|",
    ...stableAcceptanceScenarios.map(
      (entry) =>
        `| ${entry.test_id} | ${entry.task_id} | ${entry.classification} | ${entry.checkpoint} | ${escapeTableCell(entry.title)} | ${escapeTableCell(entry.expected)} | NOT_RUN |`
    ),
    "",
    "## 判定ルール",
    "",
    "- `PASS`: 対応するfresh evidenceがsource commitへbindされ、期待結果を満たす。",
    "- `FAIL`: 実装または操作結果が期待結果を満たさない。",
    "- `SETUP_REQUIRED`: token、外部service、別端末、再起動などの前提が不足している。",
    "- rerunではprevious result rootのPASSを参照し、新しいresult rootへ再実行対象だけを生成する。",
    "- cleanup完了まではStable acceptance全体を完了扱いにしない。"
  ].join("\n")}\n`;
}

function renderStableCommandList(input: {
  resultRoot: string;
  testListPath: string;
  manifestPath: string;
  cleanupPath: string;
}): string {
  const automated = stableAcceptanceScenarios.filter(
    (entry) => entry.checkpoint === "automated"
  );
  const external = stableAcceptanceScenarios.filter(
    (entry) => entry.classification === "external_required"
  );
  const lines = [
    "# T176-T189 Stable End-to-End Acceptance 実行コマンド v0",
    "",
    "- Windows PowerShellで実行する。",
    "- 各groupは独立したcode blockで、別terminal / reboot checkpointを混在させない。",
    "- credentialは環境変数またはWindows Credential Managerから解決し、値を表示しない。",
    "",
    "<!-- command-group: COMMON -->",
    "```powershell",
    "$KAIRON = \"C:\\Users\\hikar\\Documents\\AutoRunner\"",
    "$TARGET = \"M:\\EnglishApp\"",
    `$RESULT_ROOT = Join-Path $KAIRON ${psString(input.resultRoot)}`,
    `$STABLE_MANIFEST = Join-Path $KAIRON ${psString(input.manifestPath)}`,
    `$STABLE_CLEANUP_PLAN = Join-Path $KAIRON ${psString(input.cleanupPath)}`,
    "$ErrorActionPreference = \"Stop\"",
    "New-Item -ItemType Directory -Force (Join-Path $RESULT_ROOT \"results\") | Out-Null",
    "$manifest = Get-Content $STABLE_MANIFEST -Raw -Encoding UTF8 | ConvertFrom-Json",
    "$SELECTED_TEST_IDS = @($manifest.selected_test_ids)",
    "$currentCommit = (git -C $KAIRON rev-parse HEAD).Trim().ToLowerInvariant()",
    "if ($LASTEXITCODE -ne 0 -or $currentCommit -ne $manifest.source_commit) {",
    "  throw \"source commit drift: regenerate the Stable acceptance bundle from a clean checkout\"",
    "}",
    "$trackedStatus = @(git -C $KAIRON status --porcelain --untracked-files=no)",
    "if ($LASTEXITCODE -ne 0 -or $trackedStatus.Count -gt 0) {",
    "  throw \"tracked source is dirty: Stable acceptance requires a clean checkout\"",
    "}",
    "foreach ($binding in $manifest.documents) {",
    "  $bindingPath = Join-Path $KAIRON $binding.path",
    "  if (-not (Test-Path -LiteralPath $bindingPath -PathType Leaf)) {",
    "    throw \"bound acceptance document is missing: $($binding.alias)\"",
    "  }",
    "  $observedDigest = (Get-FileHash -LiteralPath $bindingPath -Algorithm SHA256).Hash.ToLowerInvariant()",
    "  if ($observedDigest -ne $binding.sha256) {",
    "    throw \"bound acceptance document digest drift: $($binding.alias)\"",
    "  }",
    "}",
    "",
    "function Test-StableSelected {",
    "  param([Parameter(Mandatory=$true)][string]$TestId)",
    "  return $SELECTED_TEST_IDS -contains $TestId",
    "}",
    "",
    "function Write-StableResult {",
    "  param(",
    "    [Parameter(Mandatory=$true)][string]$TestId,",
    "    [Parameter(Mandatory=$true)][ValidateSet(\"PASS\",\"FAIL\",\"SETUP_REQUIRED\",\"OPTIONAL\")][string]$Status,",
    "    [Parameter(Mandatory=$true)][string]$Name,",
    "    [Parameter(Mandatory=$true)][string]$Details",
    "  )",
    "  if ($Details -match '(?i)(Bearer\\s+\\S+|token\\s*[:=]\\s*\\S+|secret\\s*[:=]\\s*\\S+)') {",
    "    throw \"secret-like value was found in result details\"",
    "  }",
    "  $record = [ordered]@{ id=$TestId; status=$Status; name=$Name; details=$Details }",
    "  $json = $record | ConvertTo-Json -Depth 10",
    "  [IO.File]::WriteAllText((Join-Path $RESULT_ROOT \"results\\$TestId.json\"), $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))",
    "  \"[$TestId] $Status $Details\"",
    "}",
    "",
    "function Invoke-StableVitest {",
    "  param([string]$TestId,[string]$Name,[string[]]$Files)",
    "  if (-not (Test-StableSelected $TestId)) { return }",
    "  cd $KAIRON",
    "  $log = Join-Path $RESULT_ROOT \"results\\$TestId.log\"",
    "  & npx vitest run @Files 2>&1 | Tee-Object -FilePath $log",
    "  $exitCode = $LASTEXITCODE",
    "  if ($exitCode -eq 0) {",
    "    Write-StableResult $TestId PASS $Name \"targeted tests passed\"",
    "  } else {",
    "    Write-StableResult $TestId FAIL $Name \"targeted tests failed with exit code $exitCode\"",
    "  }",
    "}",
    "",
    "[PSCustomObject]@{",
    "  source_commit = $manifest.source_commit",
    "  selected_tests = $SELECTED_TEST_IDS.Count",
    "  carried_pass = @($manifest.carried_pass_ids).Count",
    "  gh_auth_present = (-not [string]::IsNullOrWhiteSpace($env:GH_TOKEN) -or -not [string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN))",
    "  discord_public_key_present = -not [string]::IsNullOrWhiteSpace($env:KAIRON_DISCORD_PUBLIC_KEY)",
    "} | Format-List",
    "```",
    "",
    "<!-- command-group: AUTOMATED_REQUIRED -->",
    "```powershell",
    "cd $KAIRON",
    "npm run build",
    ...automated.flatMap((entry) => [
      `Invoke-StableVitest ${psString(entry.test_id)} ${psString(entry.title)} @(${entry.test_files.map(psString).join(",")})`
    ]),
    "```",
    "",
    "<!-- command-group: WINDOWS_SANDBOX -->",
    "```powershell",
    "# 別terminalでWindows Sandboxを起動し、0.2.0 install -> 0.3.0 update -> rollback -> updateを実行する。",
    "# Sandbox終了やtimeoutはDiscord / reboot checkpointと分離して記録する。",
    "if (Test-StableSelected \"OT-T181-01-01\") {",
    "  Write-StableResult \"OT-T181-01-01\" SETUP_REQUIRED \"Transactional update and rollback\" \"Windows Sandbox evidence is required\"",
    "}",
    "```",
    "",
    "<!-- command-group: SEPARATE_TERMINAL_LOCAL -->",
    "```powershell",
    "# T185はisolated user-local registryへ2 projectを登録し、scan / schedule verify / unregisterを別terminalで実施する。",
    "if (Test-StableSelected \"OT-T185-01-01\") {",
    "  cd $KAIRON",
    "  npx vitest run tests\\project-scheduled-health.test.ts tests\\project-supervisor.test.ts tests\\windows-daemon-task.test.ts",
    "  if ($LASTEXITCODE -ne 0) {",
    "    Write-StableResult \"OT-T185-01-01\" FAIL \"Scheduled multi-project health\" \"targeted tests failed\"",
    "  } else {",
    "    Write-StableResult \"OT-T185-01-01\" SETUP_REQUIRED \"Scheduled multi-project health\" \"2-project scheduled scan and exact task cleanup evidence are required\"",
    "  }",
    "}",
    "# T186はproject外destinationへcopyし、source backupに依存せずrehearsalできることを別terminalで確認する。",
    "if (Test-StableSelected \"OT-T186-01-01\") {",
    "  cd $KAIRON",
    "  npx vitest run tests\\disaster-recovery.test.ts tests\\state-backup.test.ts tests\\state-integrity.test.ts",
    "  if ($LASTEXITCODE -ne 0) {",
    "    Write-StableResult \"OT-T186-01-01\" FAIL \"Off-device DR rehearsal\" \"targeted tests failed\"",
    "  } else {",
    "    Write-StableResult \"OT-T186-01-01\" SETUP_REQUIRED \"Off-device DR rehearsal\" \"off-device copy and isolated rehearsal evidence are required\"",
    "  }",
    "}",
    "```",
    "",
    "<!-- command-group: GITHUB_AND_DEPENDENCY_EXTERNAL -->",
    "```powershell",
    "if (Test-StableSelected \"OT-T179-01-01\") {",
    "  if ([string]::IsNullOrWhiteSpace($env:GH_TOKEN) -and [string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)) {",
    "    Write-StableResult \"OT-T179-01-01\" SETUP_REQUIRED \"GitHub Stable promotion\" \"GitHub credential is required\"",
    "  } else {",
    "    Write-StableResult \"OT-T179-01-01\" SETUP_REQUIRED \"GitHub Stable promotion\" \"live prerelease promotion and exact cleanup are required\"",
    "  }",
    "}",
    "if (Test-StableSelected \"OT-T188-01-02\") {",
    "  cd $KAIRON",
    "  $auditPath = Join-Path $RESULT_ROOT \"results\\npm-audit.json\"",
    "  npm audit --omit=dev --json | Set-Content -LiteralPath $auditPath -Encoding UTF8",
    "  if ($LASTEXITCODE -eq 0) {",
    "    Write-StableResult \"OT-T188-01-02\" PASS \"Network dependency audit\" \"npm audit completed without high or critical findings\"",
    "  } else {",
    "    Write-StableResult \"OT-T188-01-02\" FAIL \"Network dependency audit\" \"npm audit reported blocking findings\"",
    "  }",
    "}",
    "```",
    "",
    "<!-- command-group: DISCORD_SMARTPHONE -->",
    "```powershell",
    "# Discord、stable remote Board、smartphone identity rejectionを目視し、fresh artifactとmessage ID hashを記録する。",
    ...external
      .filter((entry) => ["discord_visual", "smartphone_visual"].includes(entry.checkpoint))
      .map(
        (entry) =>
          `if (Test-StableSelected ${psString(entry.test_id)}) { Write-StableResult ${psString(entry.test_id)} SETUP_REQUIRED ${psString(entry.title)} ${psString("live Discord / smartphone evidence is required")} }`
      ),
    "```",
    "",
    "<!-- command-group: WINDOWS_REBOOT_BEFORE -->",
    "```powershell",
    "# このblockだけを実行してreboot markerを保存し、OSを再起動する。",
    "if (Test-StableSelected \"OT-T189-01-03\") {",
    "  [IO.File]::WriteAllText((Join-Path $RESULT_ROOT \"reboot-before.txt\"), [DateTimeOffset]::UtcNow.ToString(\"o\"), [Text.UTF8Encoding]::new($false))",
    "  \"reboot checkpoint prepared\"",
    "}",
    "```",
    "",
    "<!-- command-group: WINDOWS_REBOOT_AFTER -->",
    "```powershell",
    "# OS再起動後の新しいPowerShellでCOMMONを再実行してから実行する。",
    "if (Test-StableSelected \"OT-T189-01-03\") {",
    "  if (-not (Test-Path (Join-Path $RESULT_ROOT \"reboot-before.txt\"))) {",
    "    Write-StableResult \"OT-T189-01-03\" FAIL \"Windows reboot resume\" \"pre-reboot marker is missing\"",
    "  } else {",
    "    cd $TARGET",
    "    kairon status | Tee-Object -FilePath (Join-Path $RESULT_ROOT \"results\\reboot-status.log\")",
    "    Write-StableResult \"OT-T189-01-03\" PASS \"Windows reboot resume\" \"post-reboot status was collected\"",
    "  }",
    "}",
    "```",
    "",
    "<!-- command-group: CLEANUP -->",
    "```powershell",
    "$cleanup = Get-Content $STABLE_CLEANUP_PLAN -Raw -Encoding UTF8 | ConvertFrom-Json",
    "if ($cleanup.confirmation -ne $manifest.run_id) { throw \"cleanup confirmation drift\" }",
    "$unsafe = @($cleanup.resources | Where-Object {",
    "  $_.cleanup_status -notin @(\"not_created\",\"deleted\",\"verified_absent\") -or",
    "  (($_.cleanup_status -eq \"deleted\") -and [string]::IsNullOrWhiteSpace($_.exact_id)) -or",
    "  -not $_.created_by_harness",
    "})",
    "if ($unsafe.Count -gt 0) {",
    "  Write-StableResult \"OT-T189-01-04\" FAIL \"Exact resource cleanup\" \"cleanup plan contains unresolved or unsafe resources\"",
    "} else {",
    "  $cleanup.status = \"completed\"",
    "  $cleanupJson = $cleanup | ConvertTo-Json -Depth 30",
    "  [IO.File]::WriteAllText($STABLE_CLEANUP_PLAN, $cleanupJson + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))",
    "  Write-StableResult \"OT-T189-01-04\" PASS \"Exact resource cleanup\" \"created resources are deleted or verified absent\"",
    "}",
    "```",
    "",
    "<!-- command-group: FINAL_SUMMARY -->",
    "```powershell",
    "$records = @(",
    "  Get-ChildItem (Join-Path $RESULT_ROOT \"results\") -Filter \"OT-*.json\" -File |",
    "    ForEach-Object { Get-Content $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json }",
    ")",
    "$carried = @($manifest.scenarios | Where-Object { $_.carried_from_previous -and $_.status -eq \"PASS\" } | ForEach-Object {",
    "  [pscustomobject]@{ id=$_.test_id; status=\"PASS\"; name=$_.title; details=\"carried from previous result root\" }",
    "})",
    "$summary = [ordered]@{",
    "  schema_version = \"0.1\"",
    "  source_commit = $manifest.source_commit",
    "  results = @($carried + $records | Sort-Object id -Unique)",
    "  cleanup_status = (Get-Content $STABLE_CLEANUP_PLAN -Raw -Encoding UTF8 | ConvertFrom-Json).status",
    "}",
    "$summaryJson = $summary | ConvertTo-Json -Depth 30",
    "$summaryPath = Join-Path $RESULT_ROOT \"summary.json\"",
    "[IO.File]::WriteAllText($summaryPath, $summaryJson + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))",
    "$resultById = @{}",
    "foreach ($record in @($carried + $records)) { $resultById[$record.id] = $record }",
    "foreach ($scenario in $manifest.scenarios) {",
    "  $record = $resultById[$scenario.test_id]",
    "  if ($null -eq $record) {",
    "    $scenario.status = \"UNKNOWN\"",
    "    $scenario.evidence_paths = @()",
    "    continue",
    "  }",
    "  $scenario.status = switch ([string]$record.status) {",
    "    \"PASS\" { \"PASS\" }",
    "    \"SETUP_REQUIRED\" { \"SETUP_REQUIRED\" }",
    "    \"OPTIONAL\" { \"OPTIONAL\" }",
    "    \"UNKNOWN\" { \"UNKNOWN\" }",
    "    default { \"UNPASSED\" }",
    "  }",
    "  $scenario.evidence_paths = if ($scenario.carried_from_previous) {",
    "    @($manifest.previous_result_root)",
    "  } else {",
    "    @(\"$(([string]$manifest.result_root).TrimEnd('/'))/results/$($scenario.test_id).json\")",
    "  }",
    "}",
    "$cleanup = Get-Content $STABLE_CLEANUP_PLAN -Raw -Encoding UTF8 | ConvertFrom-Json",
    "$manifest.status = if (",
    "  @($manifest.scenarios | Where-Object { $_.status -ne \"PASS\" }).Count -eq 0 -and",
    "  $cleanup.status -eq \"completed\"",
    ") { \"completed\" } else { \"incomplete\" }",
    "$manifest | Add-Member -NotePropertyName completed_at -NotePropertyValue ([DateTimeOffset]::UtcNow.ToString(\"o\")) -Force",
    "$bindings = @($manifest.documents)",
    "$cleanupBinding = @($bindings | Where-Object { $_.alias -eq \"CLEANUP_PLAN\" })[0]",
    "$cleanupBinding.sha256 = (Get-FileHash -LiteralPath $STABLE_CLEANUP_PLAN -Algorithm SHA256).Hash.ToLowerInvariant()",
    "$summaryBinding = @($bindings | Where-Object { $_.alias -eq \"SUMMARY\" })[0]",
    "$summaryDigest = (Get-FileHash -LiteralPath $summaryPath -Algorithm SHA256).Hash.ToLowerInvariant()",
    "if ($null -eq $summaryBinding) {",
    "  $bindings += [pscustomobject]@{ alias=\"SUMMARY\"; path=\"$(([string]$manifest.result_root).TrimEnd('/'))/summary.json\"; sha256=$summaryDigest }",
    "} else {",
    "  $summaryBinding.path = \"$(([string]$manifest.result_root).TrimEnd('/'))/summary.json\"",
    "  $summaryBinding.sha256 = $summaryDigest",
    "}",
    "$manifest.documents = @($bindings)",
    "$manifestJson = $manifest | ConvertTo-Json -Depth 50",
    "[IO.File]::WriteAllText($STABLE_MANIFEST, $manifestJson + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))",
    "cd $KAIRON",
    `kairon test summarize --result-root $RESULT_ROOT --test-list ${psString(input.testListPath)} --suggest`,
    "```"
  ];
  return `${lines.join("\n")}\n`;
}

function documentBinding(
  alias: string,
  projectRoot: string,
  filePath: string,
  content: string
): { alias: string; path: string; sha256: string } {
  return {
    alias,
    path: toDisplayPath(projectRoot, filePath),
    sha256: createHash("sha256").update(content, "utf8").digest("hex")
  };
}

function normalizeSourceCommit(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/u.test(normalized)) {
    throw new Error("Stable acceptance requires a valid source commit.");
  }
  return normalized;
}

function normalizeNamePrefix(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(normalized)) {
    throw new Error(`Invalid stable acceptance name prefix: ${value}.`);
  }
  return normalized;
}

function resolveInsideRoot(projectRoot: string, target: string): string {
  const resolved = path.resolve(projectRoot, target);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path must stay inside the project root: ${target}`);
  }
  return resolved;
}

function toDisplayPath(projectRoot: string, filePath: string): string {
  const relative = path.relative(projectRoot, path.resolve(filePath));
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? toPosixPath(path.resolve(filePath))
    : toPosixPath(relative);
}

function formatTimestamp(value: Date): string {
  return value.toISOString().replace(/\D/gu, "").slice(0, 14);
}

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function psString(value: string): string {
  return JSON.stringify(value.replaceAll("/", "\\"));
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|");
}
