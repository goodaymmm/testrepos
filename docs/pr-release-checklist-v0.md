# PR and Release Checklist v0

KaironのPR作成、manual test結果更新、README更新の抜けを減らすためのchecklistです。

## PR作成前

- [ ] `git status --short` で作業対象外の変更を確認した。
- [ ] 変更対象ファイルだけをstageする方針を確認した。
- [ ] 直前PRのmerge状態をGitHub connectorで確認した。
- [ ] `main` を `origin/main` へfast-forwardした。
- [ ] T番号に対応するbranchを作成した。

## PR本文

<!-- kairon:pr-body-policy -->
`.github/pull_request_template.md` を使い、少なくとも次を埋める。

- [ ] 目的
- [ ] 変更内容
- [ ] テスト
- [ ] Manual / Operation Test
- [ ] README / Docs
- [ ] エビデンス
- [ ] 残課題

## Manual / Operation Test結果の更新先

Manual / operation testを実施した場合は、次の優先順で記録する。

1. PR本文の `Manual / Operation Test` に結果概要を書く。
2. `scripts/kairon-operation-test.ps1` を使った場合は、生成された `summary.json` / `summary.md` のpathまたは要約をPR本文に書く。
3. repo履歴として残す必要がある場合だけ、`docs/manual-test-results-v0.md` に追記する。

<!-- kairon:generated-artifact-policy -->
生成された `operation-test-results/<run-id>/summary.*` は原則commitしない。

## README更新が必要な条件

<!-- kairon:readme-update -->
次のいずれかに該当する場合は、README更新の要否を必ず判断する。

- [ ] user-facing CLI commandを追加、削除、または出力変更した。
- [ ] setup手順、前提tool、認証、インストール手順を変更した。
- [ ] `.kairon/` の主要artifactやconfig schemaを変更した。
- [ ] operation testやmanual testの標準手順を変更した。
- [ ] safety policy、approval、merge/deploy制御に関わる挙動を変更した。
- [ ] READMEに記載済みの「実装済み/未完成」範囲が変わった。

README更新が不要な場合も、PR本文の `README / Docs` で理由を書く。

## 機械判定用anchor

T24系の運用テストでは、日本語文字列の文字化けに左右されないようにHTML comment anchorを判定する。PowerShellで確認する場合は、次のようにUTF-8を明示する。

```powershell
Get-Content .github\pull_request_template.md -Raw -Encoding UTF8
Get-Content docs\manual-test-results-v0.md -Raw -Encoding UTF8
Get-Content docs\pr-release-checklist-v0.md -Raw -Encoding UTF8
```

## Release前

- [ ] `npm run build` が通っている。
- [ ] `npm test` が通っている。
- [ ] 必要なtargeted testがPR本文に記録されている。
- [ ] manual / operation testの実施有無と結果がPR本文に記録されている。
- [ ] README更新要否が判断済み。
- [ ] generated artifactやlocal stateを誤ってcommitしていない。
