export type OperationTestCommandProfile = {
  id: string;
  title: string;
  task_ids: string[];
  description: string;
  required_env: string[];
  setup: string[];
  commands: OperationTestCommandStep[];
  expected_evidence: string[];
};

export type OperationTestCommandStep =
  | {
      kind: "powershell";
      lines: string[];
    }
  | {
      kind: "node_script";
      variable: string;
      file_name: string;
      script: string;
      args: string[];
    };

export type OperationTestCommandProfileSelection = {
  profiles?: string[];
  range?: string;
  format?: "powershell" | "json";
};

export type OperationTestCommandProfileResolution = {
  profiles: OperationTestCommandProfile[];
  unknown_profiles: string[];
  selected_tasks: string[];
};

const profiles: OperationTestCommandProfile[] = [
  {
    id: "t116-alias",
    title: "T116 operation test summary alias preview",
    task_ids: ["T116"],
    description:
      "Generate a local summary/list fixture and run kairon test summarize with alias-aware patch preview.",
    required_env: [],
    setup: [
      "Run from the Kairon repository root after npm run build / npm link.",
      "The generated fixture is written below $RESULT_ROOT and contains no secrets."
    ],
    commands: [
      {
        kind: "powershell",
        lines: [
          "$T116_ALIAS_LOG = Join-Path $RESULT_ROOT \"t116-alias-log.txt\"",
          "$T116_ALIAS_LIST = Join-Path $RESULT_ROOT \"t116-alias-list.md\""
        ]
      },
      {
        kind: "node_script",
        variable: "T116_ALIAS_SCRIPT",
        file_name: "t116-alias-fixture.mjs",
        args: ["$RESULT_ROOT"],
        script: [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "",
          "const [resultRoot] = process.argv.slice(2);",
          "if (!resultRoot) {",
          "  throw new Error('Missing resultRoot argument.');",
          "}",
          "",
          "mkdirSync(resultRoot, { recursive: true });",
          "writeFileSync(",
          "  join(resultRoot, 't116-alias-log.txt'),",
          "  [",
          "    'PASS git.branch_protection GitHub branch protection',",
          "    'Kairon task run failed.',",
          "    'status=failed'",
          "  ].join('\\n') + '\\n',",
          "  'utf8'",
          ");",
          "writeFileSync(",
          "  join(resultRoot, 't116-alias-list.md'),",
          "  [",
          "    '<!-- kairon:alias GIT_BRANCH_PROTECTION=OT-T116-01-01 -->',",
          "    '<!-- kairon:alias KAIRON_TASK_RUN=RET-T116-01-02 -->',",
          "    '| ID | Task | Check | Result | Notes |',",
          "    '|---|---|---|---|---|',",
          "    '| OT-T116-01-01 | T116 | Branch protection | NOT_RUN | pending |',",
          "    '| RET-T116-01-02 | T116 | Task run | NOT_RUN | pending |'",
          "  ].join('\\n') + '\\n',",
          "  'utf8'",
          ");"
        ].join("\n")
      },
      {
        kind: "powershell",
        lines: [
          "kairon test summarize $T116_ALIAS_LOG `",
          "  --test-list $T116_ALIAS_LIST `",
          "  --suggest `",
          "  --patch-preview"
        ]
      }
    ],
    expected_evidence: [
      "aliases.total=2",
      "candidates.pass_update=1",
      "candidates.unpassed=1",
      "candidates.missing_from_list=0"
    ]
  },
  {
    id: "t117-command-profiles-unit",
    title: "T117 command profile unit checks",
    task_ids: ["T117"],
    description:
      "Build Kairon and run command profile / CLI registration tests for the generator itself.",
    required_env: [],
    setup: ["Run from the Kairon repository root."],
    commands: [
      {
        kind: "powershell",
        lines: [
          "npm run build",
          "npx vitest run tests\\operation-test-command-profiles.test.ts tests\\cli.test.ts",
          "kairon test commands --profile t116-alias --format powershell"
        ]
      }
    ],
    expected_evidence: [
      "build passes",
      "operation-test-command-profiles.test.ts passes",
      "generated command contains .mjs and does not use node -e"
    ]
  },
  {
    id: "branch-protection-public-sandbox",
    title: "Branch protection public sandbox operation test",
    task_ids: ["T118"],
    description:
      "Run the public sandbox branch protection profile without printing GitHub token values.",
    required_env: ["GH_TOKEN or GITHUB_TOKEN"],
    setup: [
      "Use a public sandbox repository with branch protection enabled.",
      "Set GH_TOKEN or GITHUB_TOKEN in the current PowerShell process before running."
    ],
    commands: [
      {
        kind: "powershell",
        lines: [
          ".\\scripts\\kairon-operation-test.ps1 `",
          "  -KaironRoot $KAIRON `",
          "  -TargetRoot $TARGET `",
          "  -OutputRoot $RESULT_ROOT `",
          "  -Test BranchProtectionPublicSandbox `",
          "  -BranchProtectionSandboxRoot (Join-Path $env:TEMP \"kairon-branch-protection-sandbox\") `",
          "  -BranchProtectionSandboxFixture Goodaymmm14Forge `",
          "  -BranchProtectionSandboxBranch main `",
          "  -BranchProtectionRequireToken"
        ]
      }
    ],
    expected_evidence: [
      "api_status=ok",
      "branch_protection=enabled",
      "required_pull_request_reviews=present",
      "required_status_checks=present"
    ]
  }
];

export function listOperationTestCommandProfiles(): OperationTestCommandProfile[] {
  return profiles.map(cloneProfile);
}

export function resolveOperationTestCommandProfiles(
  selection: OperationTestCommandProfileSelection = {}
): OperationTestCommandProfileResolution {
  const requestedProfiles = normalizeProfileIds(selection.profiles ?? []);
  const selectedTasks = parseTaskSelection(selection.range);
  const selectedTaskSet = new Set(selectedTasks);
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const unknownProfiles = requestedProfiles.filter((id) => !profileById.has(id));

  let selected = profiles;
  if (requestedProfiles.length > 0) {
    selected = requestedProfiles.flatMap((id) => {
      const profile = profileById.get(id);
      return profile === undefined ? [] : [profile];
    });
  }

  if (selectedTaskSet.size > 0) {
    selected = selected.filter((profile) =>
      profile.task_ids.some((taskId) => selectedTaskSet.has(taskId))
    );
  }

  return {
    profiles: selected.map(cloneProfile),
    unknown_profiles: unknownProfiles,
    selected_tasks: selectedTasks
  };
}

export function formatOperationTestCommandProfiles(
  resolution: OperationTestCommandProfileResolution,
  format: "powershell" | "json" = "powershell"
): string {
  if (format === "json") {
    return `${JSON.stringify(resolution, null, 2)}\n`;
  }

  if (resolution.unknown_profiles.length > 0) {
    throw new Error(
      `Unknown operation test command profile: ${resolution.unknown_profiles.join(", ")}`
    );
  }

  const lines = [
    "# Kairon operation test commands",
    "# Generated by: kairon test commands",
    `$KAIRON = if ([string]::IsNullOrWhiteSpace($env:KAIRON_ROOT)) { (Get-Location).Path } else { $env:KAIRON_ROOT }`,
    `$TARGET = if ([string]::IsNullOrWhiteSpace($env:KAIRON_TARGET_ROOT)) { $KAIRON } else { $env:KAIRON_TARGET_ROOT }`,
    "$RUN_STAMP = Get-Date -Format yyyyMMddHHmmss",
    `$RESULT_ROOT = Join-Path $KAIRON "operation-test-results\\manual-command-profiles-$RUN_STAMP"`,
    "New-Item -ItemType Directory -Force $RESULT_ROOT | Out-Null",
    "cd $KAIRON",
    ""
  ];

  for (const profile of resolution.profiles) {
    lines.push(...formatPowerShellProfile(profile), "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function formatPowerShellProfile(profile: OperationTestCommandProfile): string[] {
  const lines = [
    `# Profile: ${profile.id}`,
    `# Title: ${profile.title}`,
    `# Tasks: ${profile.task_ids.join(", ")}`,
    `# Description: ${profile.description}`
  ];

  if (profile.required_env.length > 0) {
    lines.push(`# Required env: ${profile.required_env.join(", ")}`);
  }

  for (const setup of profile.setup) {
    lines.push(`# Setup: ${setup}`);
  }

  lines.push("");

  for (const step of profile.commands) {
    if (step.kind === "powershell") {
      lines.push(...step.lines, "");
      continue;
    }

    lines.push(
      `$${step.variable} = Join-Path $RESULT_ROOT "${step.file_name}"`,
      "@'",
      step.script,
      `'@ | Set-Content -LiteralPath $${step.variable} -Encoding UTF8`,
      `node $${step.variable} ${step.args.join(" ")}`.trim(),
      ""
    );
  }

  if (profile.expected_evidence.length > 0) {
    lines.push("# Expected evidence:");
    for (const evidence of profile.expected_evidence) {
      lines.push(`# - ${evidence}`);
    }
  }

  return lines;
}

function normalizeProfileIds(profileIds: string[]): string[] {
  return profileIds
    .flatMap((value) => value.split(/[,\s]+/))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseTaskSelection(range: string | undefined): string[] {
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

function cloneProfile(profile: OperationTestCommandProfile): OperationTestCommandProfile {
  return {
    ...profile,
    task_ids: [...profile.task_ids],
    required_env: [...profile.required_env],
    setup: [...profile.setup],
    commands: profile.commands.map((step) =>
      step.kind === "powershell"
        ? { ...step, lines: [...step.lines] }
        : { ...step, args: [...step.args] }
    ),
    expected_evidence: [...profile.expected_evidence]
  };
}
