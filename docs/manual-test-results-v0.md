# Manual Test Results v0

このファイルは、PRやrelease判断に使うmanual / operation test結果の記録先です。

## 記録方針

- すべてのPRでmanual testが必要なわけではない。
<!-- kairon:pr-body-policy -->
- manual / operation testを実施した場合は、PR本文の `Manual / Operation Test` に結果概要を書く。
- repo履歴として残す必要がある結果だけ、このファイルへ追記する。
<!-- kairon:generated-artifact-policy -->
- `scripts/kairon-operation-test.ps1` の生成物は原則commitしない。必要な場合は `summary.json` / `summary.md` の重要部分だけをこのファイルへ転記する。

## 記録テンプレート

```markdown
### YYYY-MM-DD: <対象PRまたはT番号>

- PR:
- 対象branch:
- 対象project:
- 実行者:
- 実行command:
- summary artifact:
- 結果:
  - pass:
  - fail:
- 判断:
- follow-up:
```

## Results

現時点では、PR本文のエビデンスを一次記録とする。
