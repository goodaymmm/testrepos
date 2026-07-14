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
現在のKaironは `0.1.0` のMVP基盤です。packageは `private: true` のため、
npm publishを前提にしたversion bumpではなく、運用上のrelease tag / release noteの
判断材料としてversionを扱います。

- `MAJOR`: 1.0以降に使う。現段階では使わない。
- `MINOR`: 0.x期間では、互換性に影響するCLI / config / artifact変更、または大きなuser-facing機能追加。
- `PATCH`: bug fix、診断改善、docs、test、operation harness改善。
- versionを変更する場合は、`package.json` と `src/index.ts` の `KAIRON_VERSION` を必ず同じ値にする。
- docsのみ、またはlocal operation test資料のみの更新では、原則versionを変更しない。

Release helperを使う場合は、先にdry-runを確認してからwriteします。

```powershell
kairon release validate
kairon release bump --version 0.2.0
kairon release bump --version 0.2.0 --write
```

`release validate` は次を一括確認し、不整合時はexit code 1を返します。

- `package.json.version` と `src/index.ts` の `KAIRON_VERSION` が`x.y.z`形式で一致する。
- checklistにrelease readiness、evidence、versioningのmarkerがある。
- release notesに`Unreleased` heading / markerと現在versionのheadingがある。

`--write` はtracked worktreeがcleanな場合だけ実行できます。
実行時は `.kairon/release/backups/<timestamp>/` に変更前の対象fileを保存します。

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
- 対象範囲のtargeted testまたはoperation test結果がPRまたはrelease notesにある。
- README / docs更新要否を判断済み。
- `package.json` と `src/index.ts` のversionが一致している。
- generated artifact、secret、local stateをcommitしていない。
