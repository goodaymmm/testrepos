import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { toPosixPath } from "../core/fs/paths.js";

export type OperationTestDocGeneratorOptions = {
  range: string;
  outputDir?: string;
  namePrefix?: string;
  overwrite?: boolean;
  dryRun?: boolean;
};

export type OperationTestDocFile = {
  kind: "test_list" | "command_list";
  path: string;
  content: string;
  written: boolean;
  overwritten: boolean;
};

export type OperationTestDocGenerationResult = {
  schema_version: "0.1";
  range: string;
  output_dir: string;
  name_prefix: string;
  dry_run: boolean;
  files: OperationTestDocFile[];
};

type OperationTestTask = {
  id: string;
  title: string;
  purpose: string;
};

const taskCatalog = new Map<string, Omit<OperationTestTask, "id">>([
  [
    "T130",
    {
      title: "Operation Test PASS-only Safe Apply",
      purpose: "PASS候補だけを安全にテストリストへ反映できることを確認する"
    }
  ],
  [
    "T131",
    {
      title: "Operation Test Document Generator",
      purpose: "操作テストリストと実行コマンドリストをCLIで生成できることを確認する"
    }
  ],
  [
    "T132",
    {
      title: "Guarded State Snapshot Restore",
      purpose: "state snapshot restoreをdry-run / confirm付きで安全に扱えることを確認する"
    }
  ],
  [
    "T133",
    {
      title: "Approval Follow-up Execute Mode",
      purpose: "approval follow-upを追跡し、明示操作だけで実行できることを確認する"
    }
  ],
  [
    "T134",
    {
      title: "GitHub PR Live Execute Path",
      purpose: "PR candidateから安全条件を満たす場合だけlive PRを作成できることを確認する"
    }
  ],
  [
    "T135",
    {
      title: "Discord HTTP Hardening",
      purpose: "Discord HTTP interactionsの署名、timestamp、replay防止を確認する"
    }
  ],
  [
    "T136",
    {
      title: "Board Short-lived Read-only Access",
      purpose: "Boardの短時間read-only access tokenを安全に扱えることを確認する"
    }
  ],
  [
    "T137",
    {
      title: "Board Access Audit / Secret Scan",
      purpose: "Board閲覧auditとprojection secret scanを確認する"
    }
  ],
  [
    "T138",
    {
      title: "Workflow Runtime Queue Connection",
      purpose: "workflow runtime candidateをfeature flag配下でqueueへ接続できることを確認する"
    }
  ],
  [
    "T139",
    {
      title: "Windows Daemon Installer CLI",
      purpose: "Windows Task Scheduler操作をKairon CLIから安全に扱えることを確認する"
    }
  ],
  [
    "T140",
    {
      title: "Doctor Remediation Hints",
      purpose: "doctor warning / setup_requiredに次アクションが表示されることを確認する"
    }
  ],
  [
    "T141",
    {
      title: "RAG Incremental Refresh",
      purpose: "RAG indexの差分refresh、skip、prune理由を確認する"
    }
  ],
  [
    "T142",
    {
      title: "Release Version / Changelog Validation",
      purpose: "release versionとchangelogの整合性検証を確認する"
    }
  ],
  [
    "T143",
    {
      title: "Agent Session Health",
      purpose: "agent session health、setup_required履歴、retry backoffを確認する"
    }
  ]
]);

export function buildOperationTestDocs(
  projectRoot: string,
  options: OperationTestDocGeneratorOptions
): OperationTestDocGenerationResult {
  const tasks = resolveTasks(options.range);
  const rangeLabel = formatRangeLabel(tasks);
  const namePrefix = normalizeNamePrefix(options.namePrefix ?? defaultNamePrefix(tasks));
  const outputDir = resolveOutputDir(projectRoot, options.outputDir ?? "docs");
  const listPath = path.join(outputDir, `${namePrefix}-operation-test-list-v0.md`);
  const commandPath = path.join(outputDir, `${namePrefix}-operation-test-commands-v0.md`);

  return {
    schema_version: "0.1",
    range: rangeLabel,
    output_dir: toDisplayPath(projectRoot, outputDir),
    name_prefix: namePrefix,
    dry_run: options.dryRun === true,
    files: [
      {
        kind: "test_list",
        path: toDisplayPath(projectRoot, listPath),
        content: renderTestList(tasks, rangeLabel, namePrefix),
        written: false,
        overwritten: false
      },
      {
        kind: "command_list",
        path: toDisplayPath(projectRoot, commandPath),
        content: renderCommandList(tasks, rangeLabel, namePrefix),
        written: false,
        overwritten: false
      }
    ]
  };
}

export async function writeOperationTestDocs(
  projectRoot: string,
  options: OperationTestDocGeneratorOptions
): Promise<OperationTestDocGenerationResult> {
  const result = buildOperationTestDocs(projectRoot, options);
  if (options.dryRun === true) {
    return result;
  }

  const root = path.resolve(projectRoot);
  const absoluteOutputDir = resolveOutputDir(root, options.outputDir ?? "docs");
  await mkdir(absoluteOutputDir, { recursive: true });

  const files = await Promise.all(
    result.files.map(async (file) => {
      const absolutePath = resolveInsideRoot(root, file.path);
      const exists = await fileExists(absolutePath);
      if (exists && options.overwrite !== true) {
        throw new Error(
          `Operation test doc already exists: ${file.path}. Pass --overwrite to replace it.`
        );
      }

      await writeFile(absolutePath, file.content, "utf8");
      return {
        ...file,
        written: true,
        overwritten: exists
      };
    })
  );

  return {
    ...result,
    files
  };
}

export function formatOperationTestDocGenerationResult(
  result: OperationTestDocGenerationResult
): string {
  return [
    "Kairon operation test docs generated.",
    `range=${result.range}`,
    `output_dir=${result.output_dir}`,
    `name_prefix=${result.name_prefix}`,
    `dry_run=${result.dry_run}`,
    ...result.files.flatMap((file) => [
      `${file.kind}=${file.path}`,
      `${file.kind}.written=${file.written}`,
      `${file.kind}.overwritten=${file.overwritten}`
    ])
  ].join("\n");
}

function renderTestList(
  tasks: OperationTestTask[],
  rangeLabel: string,
  namePrefix: string
): string {
  const lines = [
    `# ${rangeLabel} 操作テストリスト v0`,
    "",
    "## 位置づけ",
    "",
    `- 対象: ${tasks[0]?.id} から ${tasks[tasks.length - 1]?.id} までの実装内容`,
    "- 目的: 各実装タスクのCLI、artifact、安全境界、secret redactionを操作テストで確認する",
    "- この文書はローカル保持用であり、Push / commit 対象外",
    `- 実行コマンドは \`docs/${namePrefix}-operation-test-commands-v0.md\` を参照する`,
    "",
    "## 判定ルール",
    "",
    "- `PASS`: 期待結果を満たした",
    "- `FAIL`: 期待結果を満たさない、または例外終了した",
    "- `SETUP_REQUIRED`: 外部認証、Discord / GitHub権限、CLI login、public sandbox設定など環境準備が不足",
    "- `OPTIONAL`: live操作や外部サービス依存のため、省略可能",
    "- `NOT_RUN`: 未実施",
    "",
    "## 結果記入欄",
    "",
    "| ID | Task | 観点 | 結果 | 備考 |",
    "|---|---|---|---|---|",
    ...tasks.map(
      (task) =>
        `| OT-${task.id}-01 | ${task.id} | ${escapeTableCell(task.title)} | NOT_RUN | pending |`
    ),
    "",
    "## 共通前提",
    "",
    "- Kairon repo: `C:\\Users\\hikar\\Documents\\AutoRunner`",
    "- Target repo: `M:\\EnglishApp`",
    "- Windows PowerShellで実行する",
    "- `main` は対象範囲の直前までmerge済みの最新状態",
    "- `npm run build` が成功する",
    "- 必要な外部tokenは環境変数名だけを記録し、値はログに出さない",
    "- `operation-test-results/` とこのテスト資料はPush / commitしない",
    "",
    ...tasks.flatMap(renderTaskTestSection),
    "## Final Summary",
    "",
    "| ID | 観点 | 手順 | 期待結果 | 結果 |",
    "|---|---|---|---|---|",
    `| OT-${compactRangeId(tasks)}-FINAL-01 | Build | \`npm run build\` | TypeScript buildが成功する | NOT_RUN |`,
    `| OT-${compactRangeId(tasks)}-FINAL-02 | Unit | 対象unit testを実行 | 対象範囲のunit testがPASSする | NOT_RUN |`,
    `| OT-${compactRangeId(tasks)}-FINAL-03 | Summary | \`kairon test summarize --result-root ... --test-list ... --suggest\` | PASS候補、未PASS、SETUP_REQUIREDを分類できる | NOT_RUN |`
  ];

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderTaskTestSection(task: OperationTestTask): string[] {
  return [
    `## ${task.id} ${task.title}`,
    "",
    `- 目的: ${task.purpose}`,
    "",
    "| ID | 観点 | 手順 | 期待結果 | 結果 |",
    "|---|---|---|---|---|",
    `| OT-${task.id}-01-01 | Unit | 関連unit testを実行 | ${task.id}関連unitがPASSする | NOT_RUN |`,
    `| OT-${task.id}-01-02 | CLI | 関連CLIをdry-runまたはlocal modeで実行 | 期待されるsummary / artifactが出力される | NOT_RUN |`,
    `| OT-${task.id}-01-03 | Artifact | 生成artifactを確認 | schema、status、pathが期待通りでsecret値を含まない | NOT_RUN |`,
    `| OT-${task.id}-01-04 | Guardrail | token missing、confirm missing、権限不足などを確認 | FAILではなくSETUP_REQUIREDまたは安全な拒否になる | NOT_RUN |`,
    `| OT-${task.id}-01-05 | Secret safety | stdout、stderr、artifact、summaryを確認 | raw token、secret-like値、Bearer値が出ない | NOT_RUN |`,
    ""
  ];
}

function renderCommandList(
  tasks: OperationTestTask[],
  rangeLabel: string,
  namePrefix: string
): string {
  const lines = [
    `# ${rangeLabel} 操作テスト実行コマンド v0`,
    "",
    "## 位置づけ",
    "",
    `- 対象: \`docs/${namePrefix}-operation-test-list-v0.md\``,
    "- この文書はローカル保持用であり、Push / commit 対象外",
    "- Windows PowerShellで実行する前提",
    "- Discord / GitHub token の値はログに出さない",
    "- live外部依存は環境が揃わない場合 `SETUP_REQUIRED` として記録する",
    "",
    "## 0. 共通変数とヘルパー",
    "",
    "```powershell",
    "$KAIRON = \"C:\\Users\\hikar\\Documents\\AutoRunner\"",
    "$TARGET = \"M:\\EnglishApp\"",
    "$TARGET_JS = ($TARGET -replace \"\\\\\", \"/\")",
    "$RUN_STAMP = Get-Date -Format yyyyMMddHHmmss",
    `$RESULT_ROOT = Join-Path $KAIRON "operation-test-results\\manual-${namePrefix}-$RUN_STAMP"`,
    "New-Item -ItemType Directory -Force $RESULT_ROOT | Out-Null",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "",
    "function Save-ManualEvidence {",
    "  param(",
    "    [Parameter(Mandatory=$true)][string]$Name,",
    "    [Parameter(Mandatory=$true)][scriptblock]$Command",
    "  )",
    "",
    "  $path = Join-Path $RESULT_ROOT $Name",
    "  & $Command 2>&1 | Tee-Object -FilePath $path",
    "  Write-Host \"evidence=$path\"",
    "}",
    "",
    "function Get-KaironEnvPresence {",
    "  $names = @(",
    "    \"GH_TOKEN\",",
    "    \"GITHUB_TOKEN\",",
    "    \"KAIRON_DISCORD_BOT_TOKEN\",",
    "    \"KAIRON_DISCORD_APPLICATION_ID\",",
    "    \"KAIRON_DISCORD_GUILD_ID\",",
    "    \"KAIRON_DISCORD_APPROVAL_CHANNEL_ID\",",
    "    \"KAIRON_DISCORD_OWNER_USER_ID\",",
    "    \"KAIRON_DISCORD_ALLOWED_USER_IDS\",",
    "    \"KAIRON_DISCORD_PUBLIC_KEY\"",
    "  )",
    "",
    "  $names | ForEach-Object {",
    "    $value = [Environment]::GetEnvironmentVariable($_)",
    "    [PSCustomObject]@{",
    "      Name = $_",
    "      Present = -not [string]::IsNullOrWhiteSpace($value)",
    "    }",
    "  }",
    "}",
    "```",
    "",
    "## 1. Baseline",
    "",
    "```powershell",
    "cd $KAIRON",
    "git switch main",
    "git fetch origin main",
    "git merge --ff-only origin/main",
    "npm run build",
    "npm test",
    "npm link",
    "",
    "Save-ManualEvidence \"baseline-env-presence.txt\" {",
    "  Get-KaironEnvPresence",
    "}",
    "",
    "cd $TARGET",
    "kairon --help",
    "kairon status",
    "kairon doctor | Select-String -Pattern \"doctor.ok|summary.|warning|error|setup_required|secret|token\"",
    "```",
    "",
    "## 2. Target `.kairon` バックアップ",
    "",
    "```powershell",
    "cd $TARGET",
    "$STATE_BACKUP = Join-Path $RESULT_ROOT \"target-kairon-state-backup\"",
    "if (Test-Path .kairon) {",
    "  Copy-Item .kairon $STATE_BACKUP -Recurse -Force",
    "}",
    "Write-Host \"state_backup=$STATE_BACKUP\"",
    "```",
    "",
    ...tasks.flatMap((task, index) => renderTaskCommandSection(task, index + 3)),
    "## Result summary候補生成",
    "",
    "```powershell",
    "cd $KAIRON",
    `Save-ManualEvidence "${namePrefix}-summary-suggest.txt" {`,
    "  kairon test summarize `",
    "    --result-root $RESULT_ROOT `",
    `    --test-list docs\\${namePrefix}-operation-test-list-v0.md \``,
    "    --suggest",
    "}",
    "",
    `Save-ManualEvidence "${namePrefix}-summary-patch-preview.txt" {`,
    "  kairon test summarize `",
    "    --result-root $RESULT_ROOT `",
    `    --test-list docs\\${namePrefix}-operation-test-list-v0.md \``,
    "    --patch-preview",
    "}",
    "```"
  ];

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderTaskCommandSection(task: OperationTestTask, section: number): string[] {
  const testFile = `tests\\${task.id.toLowerCase()}-operation-placeholder.test.ts`;
  return [
    `## ${section}. ${task.id} ${task.title}`,
    "",
    "```powershell",
    "cd $KAIRON",
    `Save-ManualEvidence "${task.id.toLowerCase()}-unit.txt" {`,
    "  npm run build",
    `  if (Test-Path ${JSON.stringify(testFile)}) {`,
    `    npx vitest run ${testFile}`,
    "  } else {",
    `    "${task.id} dedicated unit placeholder: check related unit test names before execution."`,
    "  }",
    "}",
    "",
    `Save-ManualEvidence "${task.id.toLowerCase()}-manual-check.txt" {`,
    `  "[OT-${task.id}-01-02] NOT_RUN ${task.title}"`,
    `  "[OT-${task.id}-01-03] NOT_RUN artifact check pending"`,
    `  "[OT-${task.id}-01-04] NOT_RUN guardrail check pending"`,
    `  "[OT-${task.id}-01-05] NOT_RUN secret safety check pending"`,
    "}",
    "```",
    ""
  ];
}

function resolveTasks(range: string): OperationTestTask[] {
  const parsed = parseTaskRange(range);
  if (parsed.length === 0) {
    throw new Error("Specify at least one task range such as --range T130-T143.");
  }

  return parsed.map((id) => {
    const known = taskCatalog.get(id);
    return {
      id,
      title: known?.title ?? `${id} Operation Test`,
      purpose: known?.purpose ?? `${id}の実装内容を操作テストで確認する`
    };
  });
}

function parseTaskRange(range: string | undefined): string[] {
  if (range === undefined || range.trim().length === 0) {
    return [];
  }

  const tasks = new Set<string>();
  for (const token of range.split(/[,\s]+/)) {
    const normalized = token.trim().toUpperCase();
    if (normalized.length === 0) {
      continue;
    }

    const rangeMatch = normalized.match(/^T(\d+)-T(\d+)$/);
    if (rangeMatch !== null) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      const lower = Math.min(start, end);
      const upper = Math.max(start, end);
      for (let task = lower; task <= upper; task += 1) {
        tasks.add(`T${task}`);
      }
      continue;
    }

    if (/^T\d+$/.test(normalized)) {
      tasks.add(normalized);
    }
  }

  return [...tasks].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
}

function formatRangeLabel(tasks: OperationTestTask[]): string {
  if (tasks.length === 1) {
    return tasks[0].id;
  }

  const first = Number(tasks[0].id.slice(1));
  const last = Number(tasks[tasks.length - 1].id.slice(1));
  const consecutive = tasks.every((task, index) => Number(task.id.slice(1)) === first + index);
  return consecutive ? `${tasks[0].id}-${tasks[tasks.length - 1].id}` : tasks.map((task) => task.id).join(",");
}

function defaultNamePrefix(tasks: OperationTestTask[]): string {
  return formatRangeLabel(tasks).toLowerCase().replaceAll(",", "-");
}

function compactRangeId(tasks: OperationTestTask[]): string {
  if (tasks.length === 1) {
    return tasks[0].id;
  }

  return `${tasks[0].id}${tasks[tasks.length - 1].id}`;
}

function normalizeNamePrefix(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new Error(
      `Invalid --name-prefix: ${value}. Use only letters, numbers, dots, underscores, and hyphens.`
    );
  }

  return normalized;
}

function resolveOutputDir(projectRoot: string, outputDir: string): string {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, outputDir);
  return resolveInsideRoot(root, resolved);
}

function resolveInsideRoot(projectRoot: string, filePath: string): string {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, filePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path must stay inside the project root: ${filePath}`);
  }

  return resolved;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toDisplayPath(projectRoot: string, filePath: string): string {
  const absolutePath = path.resolve(projectRoot, filePath);
  const relative = path.relative(projectRoot, absolutePath);
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? toPosixPath(absolutePath)
    : toPosixPath(relative);
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|");
}
