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
      "Set GH_TOKEN or GITHUB_TOKEN in the current PowerShell process before running.",
      "Optional: set KAIRON_GITHUB_EXPECTED_STATUS_CHECKS to a comma-separated list for strict required check-name validation."
    ],
    commands: [
      {
        kind: "powershell",
        lines: [
          "$BRANCH_PROTECTION_EXPECTED_STATUS_CHECKS = @()",
          "if (-not [string]::IsNullOrWhiteSpace($env:KAIRON_GITHUB_EXPECTED_STATUS_CHECKS)) {",
          "  $BRANCH_PROTECTION_EXPECTED_STATUS_CHECKS = @($env:KAIRON_GITHUB_EXPECTED_STATUS_CHECKS.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })",
          "}",
          "$BRANCH_PROTECTION_ARGS = @(",
          "  \"-KaironRoot\", $KAIRON,",
          "  \"-TargetRoot\", $TARGET,",
          "  \"-OutputRoot\", $RESULT_ROOT,",
          "  \"-Test\", \"BranchProtectionPublicSandbox\",",
          "  \"-BranchProtectionSandboxRoot\", (Join-Path $env:TEMP \"kairon-branch-protection-sandbox\"),",
          "  \"-BranchProtectionSandboxFixture\", \"Goodaymmm14Forge\",",
          "  \"-BranchProtectionSandboxBranch\", \"main\",",
          "  \"-BranchProtectionRequireToken\"",
          ")",
          "if ($BRANCH_PROTECTION_EXPECTED_STATUS_CHECKS.Count -gt 0) {",
          "  $BRANCH_PROTECTION_ARGS += @(\"-BranchProtectionExpectedStatusChecks\", ($BRANCH_PROTECTION_EXPECTED_STATUS_CHECKS -join \",\"))",
          "}",
          ".\\scripts\\kairon-operation-test.ps1 @BRANCH_PROTECTION_ARGS"
        ]
      }
    ],
    expected_evidence: [
      "api_status=ok",
      "branch_protection=enabled",
      "required_pull_request_reviews=present",
      "required_status_checks=present",
      "missing_expected_status_checks=none when KAIRON_GITHUB_EXPECTED_STATUS_CHECKS is set"
    ]
  },
  {
    id: "stable-acceptance",
    title: "T176-T189 Stable end-to-end acceptance harness",
    task_ids: [
      "T176",
      "T177",
      "T178",
      "T179",
      "T180",
      "T181",
      "T182",
      "T183",
      "T184",
      "T185",
      "T186",
      "T187",
      "T188",
      "T189"
    ],
    description:
      "Generate a source-bound Stable acceptance test list, PowerShell groups, evidence manifest, and exact-id cleanup plan.",
    required_env: [],
    setup: [
      "Run from a clean Kairon source checkout.",
      "Set KAIRON_STABLE_PREVIOUS_RESULT_ROOT only when carrying forward PASS evidence.",
      "External checkpoints remain SETUP_REQUIRED until fresh live evidence is recorded."
    ],
    commands: [
      {
        kind: "powershell",
        lines: [
          "$STABLE_STAMP = Get-Date -Format yyyyMMddHHmmss",
          "$STABLE_RESULT_ROOT = \"operation-test-results\\stable-acceptance-$STABLE_STAMP\"",
          "$STABLE_ARGS = @(",
          "  \"test\", \"docs\",",
          "  \"--range\", \"T176-T189\",",
          "  \"--template\", \"stable-acceptance\",",
          "  \"--name-prefix\", \"t176-t189-stable-acceptance\",",
          "  \"--result-root\", $STABLE_RESULT_ROOT",
          ")",
          "if (-not [string]::IsNullOrWhiteSpace($env:KAIRON_STABLE_PREVIOUS_RESULT_ROOT)) {",
          "  $STABLE_ARGS += @(\"--previous-result-root\", $env:KAIRON_STABLE_PREVIOUS_RESULT_ROOT)",
          "}",
          "kairon @STABLE_ARGS"
        ]
      }
    ],
    expected_evidence: [
      "template=stable-acceptance",
      "source_commit is bound to Git HEAD",
      "selected_test_ids excludes carried PASS evidence",
      "evidence_manifest and cleanup_plan are generated before execution",
      "credential values are absent"
    ]
  },
  {
    id: "stable-canary",
    title: "T195 Clean Windows Stable canary",
    task_ids: ["T195"],
    description:
      "Prepare, launch, and finalize a source-free Stable package install canary in Windows Sandbox.",
    required_env: [],
    setup: [
      "Run on Windows with Windows Sandbox enabled and no existing WindowsSandbox instance.",
      "Run kairon release stable verify first; the latest fresh PASS artifact is used by default.",
      "The canary maps Node.js and Git read-only, and never maps the Kairon source checkout."
    ],
    commands: [
      {
        kind: "powershell",
        lines: [
          "$STABLE_CANARY_ARGS = @(",
          "  \"-ProjectRoot\", $KAIRON,",
          "  \"-TimeoutSeconds\", \"1800\"",
          ")",
          "if (-not [string]::IsNullOrWhiteSpace($env:KAIRON_STABLE_VERIFICATION_PATH)) {",
          "  $STABLE_CANARY_ARGS += @(\"-Verification\", $env:KAIRON_STABLE_VERIFICATION_PATH)",
          "}",
          "if (-not [string]::IsNullOrWhiteSpace($env:KAIRON_STABLE_CANARY_OUTPUT)) {",
          "  $STABLE_CANARY_ARGS += @(\"-OutputRoot\", $env:KAIRON_STABLE_CANARY_OUTPUT)",
          "}",
          ".\\scripts\\kairon-stable-canary.ps1 @STABLE_CANARY_ARGS"
        ]
      }
    ],
    expected_evidence: [
      "source verification status is PASS and unexpired",
      "Windows Sandbox profile maps runtime and result folders only",
      "download/install/version/doctor/state/read-only/uninstall checks pass",
      "project state is retained after uninstall",
      "unknown_sandbox_terminated=false",
      "credential and source checkout values are absent"
    ]
  },
  {
    id: "post-release-health",
    title: "T196 Post-release health and rollback decision",
    task_ids: ["T196"],
    description:
      "Bind Stable, canary, update, SLO, incident, security, and state evidence into a read-only rollout decision.",
    required_env: [
      "KAIRON_POST_RELEASE_VERIFICATION_PATH",
      "KAIRON_POST_RELEASE_CANARY_PATH",
      "KAIRON_POST_RELEASE_TRANSACTION"
    ],
    setup: [
      "Complete T194 Stable verification and T195 Clean Windows canary first.",
      "Retain the completed update transaction, verified rollback cache, fresh SLO summary, and security baseline.",
      "The command reports an exact rollback command but never executes or approves it."
    ],
    commands: [
      {
        kind: "powershell",
        lines: [
          "$POST_RELEASE_ARGS = @(",
          "  \"release\", \"health\", \"check\",",
          "  \"--release-verification\", $env:KAIRON_POST_RELEASE_VERIFICATION_PATH,",
          "  \"--canary\", $env:KAIRON_POST_RELEASE_CANARY_PATH,",
          "  \"--transaction\", $env:KAIRON_POST_RELEASE_TRANSACTION,",
          "  \"--format\", \"json\"",
          ")",
          "if (-not [string]::IsNullOrWhiteSpace($env:KAIRON_POST_RELEASE_SLO_PATH)) {",
          "  $POST_RELEASE_ARGS += @(\"--slo\", $env:KAIRON_POST_RELEASE_SLO_PATH)",
          "}",
          "if (-not [string]::IsNullOrWhiteSpace($env:KAIRON_POST_RELEASE_SECURITY_PATH)) {",
          "  $POST_RELEASE_ARGS += @(\"--security\", $env:KAIRON_POST_RELEASE_SECURITY_PATH)",
          "}",
          "kairon @POST_RELEASE_ARGS"
        ]
      }
    ],
    expected_evidence: [
      "decision is continue, hold, or rollback_required",
      "release ID, source commit, download, and update transaction are bound",
      "observation window, SLO, incidents, security, and state are classified",
      "rollback target uses a verified cache and requires explicit approval",
      "rollback_automatic=false and approval_automatic=false",
      "project and installed state digests are unchanged"
    ]
  },
  {
    id: "scheduled-update-check",
    title: "T197 Read-only scheduled update check",
    task_ids: ["T197"],
    description:
      "Install, run, verify, deduplicate, and remove one exact Windows scheduled update notification task.",
    required_env: ["GH_TOKEN or GITHUB_TOKEN"],
    setup: [
      "Run in Windows PowerShell as Administrator with the Stable update channel configured.",
      "Enable Discord only when live notification evidence is required.",
      "The scheduled task stores no token value and never downloads, applies, or restarts Kairon."
    ],
    commands: [
      {
        kind: "powershell",
        lines: [
          "$T197_TASK = \"Kairon T197 Update Check $RUN_STAMP\"",
          "kairon update schedule install `",
          "  --task-name $T197_TASK `",
          "  --interval-hours 24 `",
          "  --timeout-ms 60000 `",
          "  --cooldown-hours 24",
          "kairon update schedule run",
          "kairon update schedule run",
          "kairon update schedule status",
          "kairon update schedule uninstall",
          "kairon update schedule status"
        ]
      }
    ],
    expected_evidence: [
      "task_status=registered before execution and missing after uninstall",
      "new_release, current, pinned_mismatch, or remote_unavailable classification",
      "same repository/channel/version/release notification is deduplicated",
      "credential provider is reported without a credential value",
      "mutation_detected=false",
      "automatic_download=false, automatic_apply=false, and automatic_restart=false"
    ]
  },
  {
    id: "multi-project-rollout",
    title: "T198 Canary-first multi-project rollout planning",
    task_ids: ["T198"],
    description:
      "Create and revalidate a read-only rollout plan for two registered projects without applying an update.",
    required_env: [
      "KAIRON_T198_CANARY_ROOT",
      "KAIRON_T198_PRIMARY_ROOT",
      "KAIRON_T198_TARGET_VERSION"
    ],
    setup: [
      "Prepare two initialized Kairon projects and a current PASS Stable verification in KAIRON_TARGET_ROOT.",
      "Use disposable project fixtures because rollout groups are stored in the user-local registry.",
      "The profile creates plans only; run update download/apply manually when testing canary completion."
    ],
    commands: [
      {
        kind: "powershell",
        lines: [
          "$T198_REGISTRY = Join-Path $RESULT_ROOT \"t198-user-state\\projects.json\"",
          "$env:KAIRON_PROJECTS_REGISTRY_PATH = $T198_REGISTRY",
          "$T198_CANARY_ID = (Get-Content (Join-Path $env:KAIRON_T198_CANARY_ROOT \".kairon\\config\\project.json\") -Raw -Encoding UTF8 | ConvertFrom-Json).project_id",
          "$T198_PRIMARY_ID = (Get-Content (Join-Path $env:KAIRON_T198_PRIMARY_ROOT \".kairon\\config\\project.json\") -Raw -Encoding UTF8 | ConvertFrom-Json).project_id",
          "kairon projects register $env:KAIRON_T198_CANARY_ROOT",
          "kairon projects register $env:KAIRON_T198_PRIMARY_ROOT",
          "kairon projects rollout group $T198_CANARY_ID --set canary",
          "kairon projects rollout group $T198_PRIMARY_ID --set primary",
          "cd $TARGET",
          "$T198_PLAN_OUTPUT = kairon projects rollout plan --target-version $env:KAIRON_T198_TARGET_VERSION",
          "$T198_PLAN_OUTPUT",
          "$T198_PLAN_ID = [regex]::Match(($T198_PLAN_OUTPUT -join \"`n\"), \"plan_id=(RLP-[0-9]{14}-[a-f0-9]{12})\").Groups[1].Value",
          "if ([string]::IsNullOrWhiteSpace($T198_PLAN_ID)) { throw \"T198 rollout plan id was not emitted.\" }",
          "kairon projects rollout show $T198_PLAN_ID"
        ]
      }
    ],
    expected_evidence: [
      "canary is ready before the target update while primary is blocked by canary_not_completed",
      "after a manual canary update and passing health, a new plan marks canary completed and primary ready",
      "an old plan reports rollout_input_drift after project state changes",
      "runtime_active, state_integrity_error, installed_version_ahead, and project_root_unavailable block a project",
      "execution_performed=false and automatic_update=false",
      "no credential value, task body, approval body, package download, apply, or restart is recorded"
    ]
  },
  {
    id: "stable-soak-certification",
    title: "T199 Release-bound Stable soak certification",
    task_ids: ["T199"],
    description:
      "Start and inspect one release-bound 168-hour Stable soak without shortening the real-time gate.",
    required_env: ["KAIRON_T199_STABLE_VERIFICATION"],
    setup: [
      "Set KAIRON_T199_STABLE_VERIFICATION to a current PASS Stable release verification artifact in the target project.",
      "Keep the production daemon and observability metrics running for at least 168 real-time hours.",
      "Record planned maintenance or an OS reboot before the window with kairon daemon soak mark.",
      "Clock-injected fixtures remain SETUP_REQUIRED and are not accepted as real-time evidence."
    ],
    commands: [
      {
        kind: "powershell",
        lines: [
          "$T199_START = kairon daemon soak start `",
          "  --release-verification $env:KAIRON_T199_STABLE_VERIFICATION `",
          "  --minimum-hours 168",
          "$T199_START",
          "$T199_SOAK_ID = [regex]::Match(($T199_START -join \"`n\"), \"soak_id=(SSK-[0-9]{14}-[a-f0-9]{12})\").Groups[1].Value",
          "if ([string]::IsNullOrWhiteSpace($T199_SOAK_ID)) { throw \"T199 soak id was not emitted.\" }",
          "kairon daemon soak status $T199_SOAK_ID --format json",
          "kairon daemon soak report $T199_SOAK_ID --format markdown",
          "Write-Host \"After 168 real-time hours, run: kairon daemon soak certify $T199_SOAK_ID --format json\""
        ]
      }
    ],
    expected_evidence: [
      "manifest binds the Stable verification id, version, release id, target commit, state digest, and artifact digest",
      "elapsed_hours, coverage_ratio, daily rollup digests, SLO statuses, restart classification, and incident counts are reported",
      "less than 168 hours or simulated clock evidence is SETUP_REQUIRED",
      "release drift, unexplained gaps, fatal errors, critical incidents, or incomplete SLO evidence prevent PASS",
      "a PASS certificate is possible only after at least 168 real-time hours",
      "artifacts contain no host name, user name, raw task content, or credential value"
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
