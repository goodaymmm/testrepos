# Kairon Local Beta Installation

## Scope

Kairon local betaはpublic npm registryへpublishせず、`npm pack`で生成したtarballとSHA-256 manifestを使ってWindowsへ配布します。packageは`private: true`と`license=UNLICENSED`を維持します。

<!-- kairon:t161-package-baseline -->
現在の`0.2.0` packageはT159までの検証済み機能を収録するLocal Betaです。version番号は`package.json`、`package-lock.json`、`src/index.ts`を一次情報とし、release manifestでsource commitとartifactを結び付けます。

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
release-manifest.json
```

packageには`dist/`、local beta lifecycle scripts、本文書、README、package metadataだけを含めます。`src/`、`tests/`、`.kairon/`、`operation-test-results/`、credential-like path、local-only docsは含めません。

配布前に再検証できます。

```powershell
kairon release manifest `
  --package .\release-artifacts\0.2.0\kairon-0.2.0.tgz `
  --manifest .\release-artifacts\0.2.0\kairon-0.2.0.tgz.sha256.json

kairon release verify .\release-artifacts\0.2.0\kairon-0.2.0.tgz `
  --manifest .\release-artifacts\0.2.0\kairon-0.2.0.tgz.sha256.json `
  --release-manifest .\release-artifacts\0.2.0\release-manifest.json
```

release manifestはtracked worktreeがcleanな場合だけ生成でき、Git commit SHA、runtime support、tarballとchecksum manifestのhash、sorted package inventoryを記録します。npm tar metadataの時刻差は許容し、同じsource commitから同じinventoryと検証可能metadataを得られることを再現性の基準とします。

GitHub Releaseから取得する場合も、`.tgz`、`.sha256.json`、`release-manifest.json`の3ファイルを同じdirectoryへdownloadします。配布担当者は承認済みの`kairon release github publish`だけを使い、利用前にremote artifactを再検証します。

```powershell
kairon release github verify --version 0.2.0 --repository owner/repo
kairon release verify .\kairon-0.2.0.tgz `
  --manifest .\kairon-0.2.0.tgz.sha256.json `
  --release-manifest .\release-manifest.json
```

GitHub Releaseの既定channelはprereleaseです。stable releaseを利用する場合は、配布側のplan / verifyで`--stable`が明示され、tag SHAとmanifestのsource commitが一致していることを確認します。

## First Install

tarballとmanifestを同じdirectoryへ配置します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-local-beta.ps1 `
  -Package .\kairon-0.2.0.tgz `
  -DryRun

powershell -NoProfile -ExecutionPolicy Bypass -File .\install-local-beta.ps1 `
  -Package .\kairon-0.2.0.tgz
```

scriptはdependency、filename binding、size、SHA-256を確認してから`npm install --global`を実行し、install後に`kairon release verify`と`kairon --version`を確認します。既にKaironが存在する場合はinstallを拒否するため、update scriptを使います。

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
kairon update download 0.2.0
kairon update apply UPD-0001 --confirm UPD-0001 --dry-run
kairon update apply UPD-0001 --confirm UPD-0001
```

`update check`はremote metadataをmemory上で検証するだけで、filesystemを変更しません。`update download`は3つのrelease assetを`%LOCALAPPDATA%\Kairon\updates`へpartial downloadし、package / checksum / release manifestとtag SHAが一致した場合だけcacheを確定します。token値はchannel、download metadata、registryへ保存しません。

rollback先も事前に同じchannelでdownloadしておきます。

```powershell
kairon update download 0.1.0
kairon update rollback --to 0.1.0 --confirm 0.1.0 --dry-run
kairon update rollback --to 0.1.0 --confirm 0.1.0
```

`apply`と`rollback`はcache済みartifactを毎回再検証し、次の既存PowerShell lifecycleを呼び出します。成功後だけ`.kairon/update/registry.json`を更新し、失敗時はinstalled / previous / last successful versionを成功扱いにしません。channelを設定してもbackground auto-update、silent update、schedulerは開始しません。

local package pathを手動指定する従来経路も維持しています。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\update-local-beta.ps1 `
  -Package .\kairon-0.2.0.tgz `
  -Manifest .\kairon-0.2.0.tgz.sha256.json `
  -ReleaseManifest .\release-manifest.json `
  -ProjectRoot M:\EnglishApp `
  -DryRun

powershell -NoProfile -ExecutionPolicy Bypass -File .\update-local-beta.ps1 `
  -Package .\kairon-0.2.0.tgz `
  -Manifest .\kairon-0.2.0.tgz.sha256.json `
  -ReleaseManifest .\release-manifest.json `
  -ProjectRoot M:\EnglishApp
```

update順序は次の通りです。

1. dependencyとchecksumを検証する
2. 現在のglobal Kairon packageをrollback tarballとして保存する
3. 初期化済みprojectでは`kairon state backup create`を実行する
4. 新packageをglobal installする
5. package verify、`kairon migrate`、`kairon doctor`、version確認を実行する
6. 失敗時は旧packageをinstallし直し、state backupをrestoreする
7. rollback結果とsanitized errorをdiagnostic bundleへ保存する

`kairon doctor`がagent CLI未導入や未loginを含むerrorを返した場合も、updateは不完全と判定してrollbackします。update前に`kairon doctor`を実行し、`doctor.ok=true`を確認してください。

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
kairon migrate
kairon doctor
```

続いて旧packageから新packageへのupdate、意図的なdoctor failure時のrollback、uninstall後の`.kairon`保持を確認します。operation test結果やdiagnostic bundleはpackageへ再同梱しません。

Windows Sandboxでは、`0.1.0` rollback packageと`0.2.0` package、各checksum manifest、`0.2.0` release manifestを同じ共有directoryへ配置します。install前後で`kairon --version`、update失敗時の`rollback_package_restored`、uninstall後のglobal command不在とproject `.kairon/`保持を確認します。rollback packageとstate backupは確認完了まで削除しません。
