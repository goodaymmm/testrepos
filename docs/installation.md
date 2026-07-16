# Kairon Local Beta Installation

## Scope

Kairon local betaはpublic npm registryへpublishせず、`npm pack`で生成したtarballとSHA-256 manifestを使ってWindowsへ配布します。packageは`private: true`と`license=UNLICENSED`を維持します。

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
```

packageには`dist/`、local beta lifecycle scripts、本文書、README、package metadataだけを含めます。`src/`、`tests/`、`.kairon/`、`operation-test-results/`、credential-like path、local-only docsは含めません。

配布前に再検証できます。

```powershell
kairon release verify .\release-artifacts\0.1.0\kairon-0.1.0.tgz
```

## First Install

tarballとmanifestを同じdirectoryへ配置します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-local-beta.ps1 `
  -Package .\kairon-0.1.0.tgz `
  -DryRun

powershell -NoProfile -ExecutionPolicy Bypass -File .\install-local-beta.ps1 `
  -Package .\kairon-0.1.0.tgz
```

scriptはdependency、filename binding、size、SHA-256を確認してから`npm install --global`を実行し、install後に`kairon release verify`と`kairon --version`を確認します。既にKaironが存在する場合はinstallを拒否するため、update scriptを使います。

## Update And Rollback

Kairon project rootで実行します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\update-local-beta.ps1 `
  -Package .\kairon-0.1.1.tgz `
  -ProjectRoot M:\EnglishApp `
  -DryRun

powershell -NoProfile -ExecutionPolicy Bypass -File .\update-local-beta.ps1 `
  -Package .\kairon-0.1.1.tgz `
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
