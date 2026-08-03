# Kairon Local Package Installation

## Scope

Kaironはpublic npm registryへpublishせず、`npm pack`で生成したtarballとSHA-256 manifestを使ってWindowsへ配布します。packageは`private: true`と`license=UNLICENSED`を維持します。

<!-- kairon:t192-stable-distribution -->
現在の`0.3.0` packageはT160-T191を収録した個人運用向けStable Local Releaseです。
artifactはcurrent source commitから生成し、package、checksum manifest、CycloneDX SBOM、
local build provenance、release manifestを相互検証します。GitHub Releaseへのpublishと
Stable昇格はreadiness判定から分離したapproval-bound操作です。version番号は
`package.json`、`package-lock.json`、`src/index.ts`を一次情報とし、release manifestで
source commitとartifactを結び付けます。

`Stable Local Release`はpublic npm registryへのpublishを意味しません。利用側のupdateも
backgroundで自動適用せず、`check`、`download`、`apply`を分離し、applyにはexact confirmと
transactional health gateを要求します。

0.3.x patchを準備する場合は、`kairon release patch plan --version <next-patch>`で
clean sourceとversion file digestを固定し、表示されたplan IDを
`kairon release patch prepare <plan-id> --confirm <plan-id>`へ完全一致で渡します。
prepare後は変更をreviewしてcommitし、artifact / SBOM / provenanceを生成してから
`release manifest --patch-plan <plan-id>`でpatch planへbindします。配布後はprevious
Stableからのupdate、rollback、reapply、Clean Windows canary、post-release health、
Stable promotion、resource cleanupの証跡を`release patch verify`へ渡します。
patch commandはGitHub publish、Stable昇格、update applyを自動実行しません。

## Requirements

- Windows 10 / 11またはWindows Server
- PowerShell 5.1以上
- Node.js 22以上
- npm
- Git
- install先userがnpm global packageを書き込めること
- 初期化済みprojectをupdateする場合は、`agents.json`で有効な公式agent CLIが同じPowerShell sessionから利用できること

環境のinstallに失敗した場合は、表示された`diagnostic_bundle`を保持してoperatorへ依頼してください。tokenやcredential値をログへ貼り付けないでください。

## Create Package

開発repositoryのtracked worktreeで次を実行します。

```powershell
npm ci
npm run release:pack
```

既定の出力は`release-artifacts/<version>/`です。

```text
kairon-<version>.tgz
kairon-<version>.tgz.sha256.json
sbom.cdx.json
provenance.json
release-manifest.json
```

packageには`dist/`、local package lifecycle scripts、本文書、README、package metadataだけを含めます。`src/`、`tests/`、`.kairon/`、`operation-test-results/`、credential-like path、local-only docsは含めません。

配布前に再検証できます。

```powershell
kairon release sbom `
  --manifest .\release-artifacts\0.3.0\kairon-0.3.0.tgz.sha256.json `
  --output .\release-artifacts\0.3.0\sbom.cdx.json

kairon release provenance `
  --package .\release-artifacts\0.3.0\kairon-0.3.0.tgz `
  --manifest .\release-artifacts\0.3.0\kairon-0.3.0.tgz.sha256.json `
  --sbom .\release-artifacts\0.3.0\sbom.cdx.json `
  --output .\release-artifacts\0.3.0\provenance.json

kairon release manifest `
  --package .\release-artifacts\0.3.0\kairon-0.3.0.tgz `
  --manifest .\release-artifacts\0.3.0\kairon-0.3.0.tgz.sha256.json `
  --sbom .\release-artifacts\0.3.0\sbom.cdx.json `
  --provenance .\release-artifacts\0.3.0\provenance.json

kairon release verify .\release-artifacts\0.3.0\kairon-0.3.0.tgz `
  --manifest .\release-artifacts\0.3.0\kairon-0.3.0.tgz.sha256.json `
  --release-manifest .\release-artifacts\0.3.0\release-manifest.json `
  --verification-context source
```

release manifestはtracked worktreeがcleanな場合だけ生成でき、Git commit SHA、runtime
support、tarballとchecksum manifestのhash、sorted package inventory、CycloneDX SBOMと
local build provenanceのhashを記録します。npm tar metadataの時刻差は許容し、同じsource
commitから同じinventoryと検証可能metadataを得られることを再現性の基準とします。
詳細は`docs/release-provenance-v0.md`を参照します。

GitHub Release publication contractはattestation付きmanifestでSBOM/provenanceを含む
5ファイルを同じreleaseへ配置します。配布担当者は承認済みの
`kairon release github publish`だけを使い、利用前にremote artifactを再検証します。

```powershell
kairon release github verify --version 0.3.0 --repository owner/repo
kairon release verify .\kairon-0.3.0.tgz `
  --manifest .\kairon-0.3.0.tgz.sha256.json `
  --release-manifest .\release-manifest.json `
  --verification-context consumer
```

GitHub Releaseの既定channelはprereleaseです。既存prereleaseをStableへ昇格する場合は
`kairon release github promote plan`と`promote apply`を使い、昇格後のverifyへ`--stable`を
指定します。promotionは既存assetを差し替えず、tag SHA、manifest source commit、5 assetの
ID / digestがplanと一致する場合だけ実行されます。

## First Install

tarballとmanifestを同じdirectoryへ配置します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-local-beta.ps1 `
  -Package .\kairon-0.3.0.tgz `
  -DryRun

powershell -NoProfile -ExecutionPolicy Bypass -File .\install-local-beta.ps1 `
  -Package .\kairon-0.3.0.tgz
```

scriptはdependency、filename binding、size、SHA-256を確認し、user-local staging prefixで`kairon release verify`と`kairon --version`を通してから`npm install --global`を実行します。既にKaironが存在する場合はinstallを拒否するため、update scriptを使います。

## Update And Rollback

Kairon project rootで実行します。

GitHub Releaseを利用する場合は、最初にmanual channelを設定します。設定変更は既定でdry-runであり、write時はchannel名の完全一致確認が必要です。

```powershell
$env:GH_TOKEN = "<fine-grained PAT>"

kairon update channel set beta `
  --repository owner/repo `
  --dry-run

kairon update channel set beta `
  --repository owner/repo `
  --write `
  --confirm beta

kairon update check
kairon update download 0.3.0
kairon update apply UPD-0001 --confirm UPD-0001 --dry-run
kairon update apply UPD-0001 --confirm UPD-0001
```

`update check`はremote metadataをmemory上で検証するだけで、filesystemを変更しません。`update download`は3つのrelease assetを`%LOCALAPPDATA%\Kairon\updates`へpartial downloadし、package / checksum / release manifestとtag SHAが一致した場合だけcacheを確定します。token値はchannel、download metadata、registryへ保存しません。

定期確認は既定で無効です。Windows Task Schedulerへread-only checkだけを登録する場合は、管理者PowerShellから明示的にinstallします。

```powershell
kairon update schedule install `
  --interval-hours 24 `
  --timeout-ms 60000 `
  --cooldown-hours 24

kairon update schedule status
kairon update schedule run
kairon update schedule uninstall
```

Taskにはproject root、Kairon command、実行間隔だけを保存します。GitHub tokenは実行時に`GH_TOKEN`、`GITHUB_TOKEN`、またはWindows Credential Managerから解決し、Task引数やresultへ値を保存しません。`run`は`new_release`、`current`、`pinned_mismatch`、`remote_unavailable`のいずれかを記録し、新release時も手動の`kairon update download <version>`を表示するだけです。同一release通知はdeduplicateし、quiet hours、maintenance window、daily budget、cooldownを既存alert policyで評価します。

Task Scheduler権限不足、token不足、remote障害は`setup_required`または`remote_unavailable`として記録します。自動download、apply、rollback、restartは行いません。

rollback先も事前に同じchannelでdownloadしておきます。

```powershell
kairon update download 0.2.0
kairon update rollback --to 0.2.0 --confirm 0.2.0 --dry-run
kairon update rollback --to 0.2.0 --confirm 0.2.0
```

`apply`と`rollback`はcache済みartifactを毎回再検証し、transactional PowerShell lifecycleを呼び出します。`.kairon/update/transactions/UTX-*.json`にはpreflight、staging、switch、post-check、rollbackのstatusとdigestだけを記録し、raw command outputやtokenは保存しません。成功後だけ`.kairon/update/registry.json`を同じtransaction IDで更新し、失敗時はinstalled / previous / last successful versionを成功扱いにしません。channelを設定しただけではbackground check、silent update、schedulerは開始しません。

local package pathを手動指定する従来経路も維持しています。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\update-local-beta.ps1 `
  -Package .\kairon-0.3.0.tgz `
  -Manifest .\kairon-0.3.0.tgz.sha256.json `
  -ReleaseManifest .\release-manifest.json `
  -ProjectRoot M:\EnglishApp `
  -DryRun

powershell -NoProfile -ExecutionPolicy Bypass -File .\update-local-beta.ps1 `
  -Package .\kairon-0.3.0.tgz `
  -Manifest .\kairon-0.3.0.tgz.sha256.json `
  -ReleaseManifest .\release-manifest.json `
  -ProjectRoot M:\EnglishApp `
  -ApproveSchemaMigration
```

update順序は次の通りです。

1. runtime停止、Node/npm、disk空き容量、state integrity、verified downloadをpreflightする
2. 現在のglobal Kairon packageをrollback tarballとして保存し、SHA-256と現在versionを固定する
3. 初期化済みprojectでは`kairon state backup create`を実行する
4. `%LOCALAPPDATA%\Kairon\update-staging`配下へ新packageをinstallする
5. staged CLIでversion、package/release manifest、state integrityを確認する
6. staging healthが成功した場合だけ新packageをglobal installしてactive packageを切り替える
7. runtimeを停止し、`kairon migrate plan`でschema driftを検査する
8. migrationが必要な場合は`-ApproveSchemaMigration`指定時だけexact confirm付きapplyを実行する
9. package verify、`kairon doctor`、version、state integrityをpost-checkする
10. 失敗時は事前検証済み旧packageとstate backupへ1回だけrollbackする
11. rollback結果とsanitized error codeをtransaction artifactとdiagnostic bundleへ保存する

`-ReleaseManifest`を指定したupdateはstagingとswitch後の両方で
`--verification-context consumer`を使います。consumer projectのGit commitをKairon build
sourceとは比較せず、release manifestとprovenanceのsource SHA、package、checksum、
inventory、SBOM、provenanceの相互bindingを検証します。通常のrelease作成・GitHub publish側は
既定の`source`を使い、current clean tracked sourceとの一致を維持します。

schema migrationが必要なのに`-ApproveSchemaMigration`がない場合、updateはconfigを書き換えず
失敗し、既存rollback処理へ移る。migration apply自身もfresh state backupを作成し、
post-check失敗時は`.kairon/migrations/in-progress.json`へ復旧手順を残す。

`kairon doctor`がagent CLI未導入や未loginを含むerrorを返した場合も、updateは不完全と判定してrollbackします。update前に`kairon doctor`を実行し、`doctor.ok=true`を確認してください。

処理中断またはrollback失敗時は`.kairon/update/in-progress.json`を残し、`kairon recovery list`へhigh severity targetを表示します。rollback失敗はcritical incidentも作成し、active packageとstateを手動確認するまで次のapply / rollbackを拒否します。自動再試行はしません。

rollback artifactとstate backupは自動削除しません。検証が終わるまで保持してください。

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-local-beta.ps1 `
  -ProjectRoot M:\EnglishApp `
  -DryRun

powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-local-beta.ps1 `
  -ProjectRoot M:\EnglishApp
```

uninstallは`npm uninstall --global kairon`だけを実行します。project内の`.kairon/`、config、state、run、approval、backupは削除しません。

## Clean Windows Verification

global installの影響を受けないWindows user/profileで次を確認します。

```powershell
kairon --version
kairon release verify <package.tgz>
cd <initialized-project>
kairon stop
kairon migrate plan
kairon migrate apply <plan-id> --confirm <plan-id>
kairon doctor
```

続いて旧packageから新packageへのupdate、意図的なdoctor failure時のrollback、uninstall後の`.kairon`保持を確認します。operation test結果やdiagnostic bundleはpackageへ再同梱しません。

Windows Sandboxでは、`0.2.0` rollback packageと`0.3.0` package、各checksum manifest、`0.3.0` release manifestを同じ共有directoryへ配置します。install前後で`kairon --version`、update失敗時の`rollback_package_restored`、uninstall後のglobal command不在とproject `.kairon/`保持を確認します。rollback packageとstate backupは確認完了まで削除しません。

公開済みStable packageのsource-free canaryにはT195 profileを使用します。事前に
`kairon release stable verify`が`PASS`したfresh artifactを用意し、Kairon source rootで
build後に次を実行します。

```powershell
.\scripts\kairon-stable-canary.ps1 `
  -ProjectRoot "C:\Users\hikar\Documents\AutoRunner" `
  -TimeoutSeconds 1800
```

scriptは現在のNode.js runtimeとGit runtimeをread-onlyでWindows Sandboxへmapしますが、
Kairon source checkout、`node_modules`、global Kairon installはmapしません。Sandboxは
published Stable assetをdownloadしてconsumer verificationを行い、Sandbox内のuser-local
npm prefixへinstallします。fixture projectの`doctor --format json`、`state check --format json`、
`status`を確認した後にuninstallし、`.kairon/project.json`が保持されたことをresultへ記録します。
`ProjectRoot`はStable verificationを保持するKairon repository rootであり、実際の
production projectをcanary対象として変更する引数ではありません。

既存Windows Sandboxが起動している場合、scriptはunknown instanceを終了せず
`SETUP_REQUIRED`で停止します。timeout時も強制終了しません。成功/失敗resultは
`.kairon/release/stable-canaries/<canary-id>/`へ保存され、credential値やnative command
outputは含みません。
