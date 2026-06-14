# GitHub Branch Protection Sandbox v0

## 目的

Kairon の `git.branch_protection` doctor は GitHub REST API で対象repositoryのbranch protectionを確認する。
個人アカウントのprivate repositoryでは、Branch protection ruleをUI上で設定していても、GitHub側のプランや権限条件によりAPIが403になる場合がある。

この場合、Kaironの実装不具合として扱わず、public sandbox repositoryでlive API疎通を確認する。
T67の運用テストでは `goodaymmm/14Forge` をpublic sandboxとして使い、`api_status=ok`、`branch_protection=enabled`、`required_pull_request_reviews=present`、`required_status_checks=present` を確認した。

## 使う場面

- 対象projectがprivate repositoryで、`kairon doctor` の `git.branch_protection` が403になる。
- GitHub branch protection診断のlive API疎通を、課金やorganization化なしで確認したい。
- fine-grained PATの権限が正しく効くかを、実repositoryで確認したい。

## 前提

- public sandbox repositoryを1つ用意する。
- sandbox repositoryのdefault branchを `main` にする。
- sandbox repositoryの `main` にBranch protection ruleを設定する。
- fine-grained PATを使う場合、対象sandbox repositoryをRepository accessに含める。
- PATのRepository permissionsで `Administration: Read-only` を付与する。

Kaironは `GH_TOKEN` を優先し、未設定の場合に `GITHUB_TOKEN` を参照する。
両方を同時に設定している場合、意図しないtokenを使わないように `GH_TOKEN` を明示する。

## GitHub側の設定

### Branch protection rule

public sandbox repositoryで次を設定する。

```text
Repository Settings
  -> Branches
  -> Branch protection rules
  -> Add branch protection rule
```

推奨設定:

```text
Branch name pattern: main
Require a pull request before merging: enabled
Require approvals: enabled
Require status checks to pass before merging: enabled
```

required status checksは、対象repositoryで一度CIを走らせてcheck名を作ってから選択する。
CIを使わないsandboxでは、手動でbranch protection API検証用の最小workflowを追加するか、次回のharness化で専用fixtureを使う。

### Fine-grained PAT

```text
GitHub Settings
  -> Developer settings
  -> Personal access tokens
  -> Fine-grained tokens
```

設定:

```text
Repository access: Only select repositories
Selected repositories: <public sandbox repository>
Repository permissions:
  Administration: Read-only
```

token値はコマンドログ、Markdown、`.kairon/` artifactに保存しない。

## Harnessでの実行

T80以降はoperation test harnessから実行できる。

```powershell
cd C:\Users\hikar\Documents\AutoRunner

.\scripts\kairon-operation-test.ps1 `
  -KaironRoot "C:\Users\hikar\Documents\AutoRunner" `
  -TargetRoot "M:\EnglishApp" `
  -Test BranchProtectionPublicSandbox `
  -BranchProtectionSandboxRoot "$env:TEMP\kairon-branch-protection-sandbox" `
  -BranchProtectionSandboxRepoUrl "https://github.com/goodaymmm/14Forge.git" `
  -BranchProtectionSandboxBranch main `
  -BranchProtectionRequireToken
```

このprofileは一時workspaceを作成して `git init`、`git remote add origin`、`kairon init`、`kairon doctor` を実行する。
token未設定、403、404、required gate未設定は `SETUP_REQUIRED` としてsummaryに記録する。

## 手動実行手順

PowerShellで一時workspaceを作成する。

```powershell
$KAIRON = "C:\Users\hikar\Documents\AutoRunner"
$SANDBOX = Join-Path $env:TEMP "kairon-t67-public-repo-test"

if (Test-Path $SANDBOX) {
  Remove-Item $SANDBOX -Recurse -Force
}

New-Item -ItemType Directory $SANDBOX | Out-Null
cd $SANDBOX
git init
git branch -M main
git remote add origin "https://github.com/goodaymmm/14Forge.git"
```

tokenを現在のPowerShell sessionだけに設定する。

```powershell
$env:GH_TOKEN = "<fine-grained PAT>"
```

Kaironを初期化して診断する。

```powershell
cd $KAIRON
npm run build
npm link

cd $SANDBOX
kairon init
kairon doctor |
  Select-String -Pattern "doctor.ok|git.branch_protection|repository=|branch=|api_status=|branch_protection=|required_status_checks|pull_request_reviews|auth=|network_check=|http_status="
```

期待する結果:

```text
doctor.ok=true
PASS git.branch_protection GitHub branch protection
  - repository=goodaymmm/14Forge
  - branch=main
  - auth=present
  - network_check=completed
  - api_status=ok
  - branch_protection=enabled
  - required_pull_request_reviews=present
  - required_status_checks=present
```

## 判定

| 結果 | 扱い |
| --- | --- |
| `api_status=ok` かつ `branch_protection=enabled` | live API確認PASS |
| `auth=missing` | token未設定。`GH_TOKEN` または `GITHUB_TOKEN` を設定する |
| `http_status=403` | token権限不足、repository access不足、またはGitHub側のprivate repository / plan制約 |
| `http_status=404` | repository名、remote URL、tokenのrepository accessを確認する |
| `required_pull_request_reviews=missing` | Branch protection ruleでpull request review要求を有効にする |
| `required_status_checks=missing` | Branch protection ruleでrequired status checksを有効にする |

private repositoryで403になっても、public sandboxで上記PASSが取れるなら、Kaironのbranch protection API実装はlive疎通済みとして扱う。

## ログ方針

- token値は出力しない。
- `Get-ChildItem Env:*TOKEN*` の値は貼らない。
- doctor出力は `present` / `missing`、`api_status`、`http_status` だけを記録する。
- public sandbox repository名は記録してよい。

## 後続

今後はpublic sandbox repository自体をfixture化するか、CI側のbranch protection検証と連携させる。
