# Release Readiness Checklist v0

Kaironをreleaseできる状態か判断するためのchecklistです。PR作成時の確認は
`docs/pr-release-checklist-v0.md`、manual / operation testの記録は
`docs/manual-test-results-v0.md` を優先します。

## 目的

<!-- kairon:release-readiness -->
release判断では、コードがbuildできることだけでなく、ローカル運用で必要な
state、認証、manual evidence、README / docs、version表記が揃っていることを確認します。

## 前提

- `main` が `origin/main` と同期している。
- release対象のPRがmerge済みである。
- 作業ツリーにrelease対象外のtracked変更がない。
- `operation-test-results/`、`.kairon/` state、local-only docsは原則commitしない。
- tokenやsecret値をlog、PR本文、release notesへ出さない。

## 必須確認

```powershell
git switch main
git pull
git status --short
npm run build
npm test
```

必要に応じて、対象範囲のtargeted testも実行します。

```powershell
npx vitest run tests\pr-release-docs.test.ts
```

## Operation Test確認

release対象がCLI、runtime、Discord、GitHub、Board、RAG、cleanup、recovery、
agent runnerに関係する場合は、対象範囲に応じてoperation testを実行します。

```powershell
.\scripts\kairon-operation-test.ps1 `
  -KaironRoot "C:\Users\hikar\Documents\AutoRunner" `
  -TargetRoot "M:\EnglishApp"
```

長いlogを確認する場合はsummaryを作ります。docsは自動更新しません。

```powershell
kairon test summarize --result-root .\operation-test-results
```

外部依存のlive確認は、実行できない場合に `SETUP_REQUIRED` として扱えます。
ただしrelease判断では、代替確認または残課題として明記します。

## Beta Readiness Gate

各証跡を`GATE_ID=path`形式でmanifestへ登録し、証跡が現在commitに対応していることを確認します。

```powershell
kairon readiness manifest `
  --evidence BUILD_UNIT_INTEGRATION=.\operation-test-results\summary.json `
  --evidence CONFIG_MIGRATION_DOCTOR=.\.kairon\reports\doctor.json `
  --evidence PACKAGE_LIFECYCLE=.\release-artifacts\0.2.0\verification.json

kairon readiness check
kairon readiness report --format markdown
```

Beta配布の機械判定では、すべての必須gateが`PASS`の場合だけreadyです。`SETUP_REQUIRED`、`UNKNOWN`、`UNPASSED`はexit code 1となります。manifest作成後に証跡を変更した場合、証跡が期限切れの場合、またはsource commitが現在の`HEAD`と異なる場合は証跡を再生成します。

## Release Candidate Readiness Gate

T160-T174の証跡をRC gateへ登録し、現在commitに対する配布・更新・復旧・
workflow・Agent・RAG・複数project・stable remoteの成立を確認します。

```powershell
kairon readiness rc manifest `
  --evidence BASELINE_DOCS=.\operation-test-results\t160.json `
  --evidence RELEASE_ARTIFACT=.\operation-test-results\t161-release-verify.json `
  --evidence BUILD_UNIT_INTEGRATION=.\operation-test-results\full-test.json `
  --evidence SECURITY_INTEGRITY=.\operation-test-results\secret-scan.json

kairon readiness rc check
kairon readiness rc report --format json
kairon readiness rc report --format markdown
```

- canonical resultは`.kairon/readiness/rc-result.json`、operator viewは
  `.kairon/readiness/rc-report.md`へ出力する。
- `required`と`external_required`の全gateが`PASS`で、global blockerが0件の場合だけ
  `rc_ready=true`になる。
- GitHub配布、clean Windows update / rollback、hybrid RAG、stable remoteは
  `external_required`であり、環境未準備の`SETUP_REQUIRED`を`PASS`へ昇格しない。
- stale、改変、別commit、許可されないartifact kindを持つ証跡は再実行する。
- 未解決の`high` / `critical` incident、secret finding、source SHA mismatchが
  1件でもあればRC判定をblockする。手動overrideは行わない。

## Secret / Generated Artifact確認

<!-- kairon:release-evidence -->
secret値は存在確認だけを行い、値を表示しません。

```powershell
Get-ChildItem Env:GH_TOKEN,Env:GITHUB_TOKEN,Env:KAIRON_DISCORD_BOT_TOKEN `
  -ErrorAction SilentlyContinue |
  Select-Object Name,@{Name="Present";Expression={-not [string]::IsNullOrWhiteSpace($_.Value)}}
```

commit前に、generated artifactやlocal stateがstageされていないことを確認します。

```powershell
git status --short
git diff --cached --stat
```

## Versioning方針

<!-- kairon:versioning-policy -->
現在のKaironはT159までのoperation test結果を収録した`0.2.0` Local Betaです。packageは `private: true` のため、
npm publishを前提にしたversion bumpではなく、運用上のrelease tag / release noteの
判断材料としてversionを扱います。

- `MAJOR`: 1.0以降に使う。現段階では使わない。
- `MINOR`: 0.x期間では、互換性に影響するCLI / config / artifact変更、または大きなuser-facing機能追加。
- `PATCH`: bug fix、診断改善、docs、test、operation harness改善。
- versionを変更する場合は、`package.json`、`package-lock.json` と `src/index.ts` の `KAIRON_VERSION` を必ず同じ値にする。
- docsのみ、またはlocal operation test資料のみの更新では、原則versionを変更しない。

Release helperを使う場合は、先にdry-runを確認してからwriteします。

```powershell
kairon release validate
kairon release bump --version 0.3.0
kairon release bump --version 0.3.0 --write
```

`release validate` は次を一括確認し、不整合時はexit code 1を返します。

- `package.json.version` と `src/index.ts` の `KAIRON_VERSION` が`x.y.z`形式で一致する。
- `package-lock.json`のtop-level versionとroot package versionが`package.json.version`に一致する。
- checklistにrelease readiness、evidence、versioningのmarkerがある。
- release notesに`Unreleased` heading / markerと現在versionのheadingがある。

`--write` はtracked worktreeがcleanな場合だけ実行できます。
実行時は `.kairon/release/backups/<timestamp>/` に変更前の対象fileを保存します。

## Reproducible Local Beta Artifact

version bumpをcommitしたclean tracked worktreeでpackageを生成し、そのpackageとchecksum manifestをsource commitへbindします。

```powershell
npm run release:pack
kairon release manifest `
  --package .\release-artifacts\0.2.0\kairon-0.2.0.tgz `
  --manifest .\release-artifacts\0.2.0\kairon-0.2.0.tgz.sha256.json
kairon release verify .\release-artifacts\0.2.0\kairon-0.2.0.tgz `
  --manifest .\release-artifacts\0.2.0\kairon-0.2.0.tgz.sha256.json `
  --release-manifest .\release-artifacts\0.2.0\release-manifest.json
```

`release-manifest.json`はsource commit、`dirty=false`、Windows runtime support、artifact SHA-256、checksum manifest SHA-256、sorted package inventoryとそのSHA-256を保持します。tracked変更が残る場合は生成を拒否します。npm tar metadataの時刻差によるbyte-for-byte一致は要件にせず、同じsourceから同じinventoryと検証可能metadataが得られることを確認します。

## Approval-gated GitHub Release

<!-- kairon:github-release-distribution -->
検証済みLocal Beta artifactをGitHub Releaseへ配布する場合は、planとpublishを分離します。tokenには対象repositoryのContents read/write権限が必要です。`GH_TOKEN`または`GITHUB_TOKEN`を使い、値自体は表示・保存しません。

```powershell
kairon release github plan `
  --version 0.2.0 `
  --repository owner/repo

kairon approval show APR-0001
kairon approval decide APR-0001 --action approve --reason "GitHub Release publish approved"

kairon release github publish REL-0001 `
  --approval-id APR-0001 `
  --confirm REL-0001

kairon release github verify `
  --version 0.2.0 `
  --repository owner/repo
```

- 既定はprerelease。stable公開時だけplanとverifyの両方へ`--stable`を付ける。
- plan作成後に`main`、local HEAD、release artifact、approval bindingが変化した場合はpublishしない。
- approvalの`plan_id`、`plan_digest`、artifact pathが一致し、decisionが`approve`の場合だけpublishする。
- tag、release、asset nameが既存の場合はsource SHA、channel、asset SHA-256が完全一致することを確認する。
- network / rate limitによる途中失敗は同じplan IDで再実行し、検証済みassetを重複uploadしない。
- result artifactにはtokenやraw GitHub responseを含めず、tag SHA、release ID、asset ID / size / SHA-256、正規化errorだけを残す。

## Verified Update And Rollback

release利用側では`stable | beta | pinned`のmanual channelを明示設定し、check / download / applyを分離します。

```powershell
kairon update channel set beta --repository owner/repo --write --confirm beta
kairon update check
kairon update download 0.2.0
kairon update apply UPD-0001 --confirm UPD-0001 --dry-run
kairon update apply UPD-0001 --confirm UPD-0001
```

- `update check`でfilesystemやregistryが変化しない。
- download後にpackage SHA-256、checksum manifest、release manifest、inventory、tag source SHAが一致する。
- cacheはproject source外のuser-local directoryにあり、partial downloadが確定artifactとして残らない。
- apply / rollback前にcache済みartifactを再検証し、exact confirmなしではPowerShell lifecycleを開始しない。
- lifecycle失敗時はregistryのinstalled / previous / last successfulを成功扱いにしない。
- rollback targetは事前にverified cacheへ取得し、`kairon update rollback --to <version> --confirm <version>`で明示する。
- background auto-update、silent update、schedulerは存在しない。

## Release Notes更新

releaseする場合は `docs/release-notes-v0.md` の `Unreleased` から該当versionへ移します。

Draftを生成する場合は、write前にdry-runを確認します。

```powershell
kairon release notes --since <ref>
kairon release notes --since <ref> --write
```

`--write` は `docs/release-notes-v0.md` の `<!-- kairon:release-notes-unreleased -->`
直下へappend-onlyで追記します。

記録する内容:

- release日
- version
- 主な変更
- 実行したtest
- manual / operation test evidence
- known limitations

## 完了条件

- `npm run build` と `npm test` が通っている。
- `kairon readiness check` がexit code 0を返している。
- RCへ進める場合は`kairon readiness rc check`がexit code 0を返している。
- 対象範囲のtargeted testまたはoperation test結果がPRまたはrelease notesにある。
- README / docs更新要否を判断済み。
- `package.json` と `src/index.ts` のversionが一致している。
- generated artifact、secret、local stateをcommitしていない。
- GitHub配布を行う場合は`release github verify`が`status=verified`を返している。
