# Agent CLI Compatibility Certification v0

<!-- kairon:agent-cli-compatibility-certification -->

## Scope

Kaironが利用する公式CLI `codex`、`claude`、`agy`について、更新後もprompt、
outbox、PTY、分類契約が維持されているかを確認する。`gemini`はKairon内部の互換Agent IDで、
実際のAntigravity CLI commandは`agy`である。

## Certification

```powershell
kairon agent certify --agent codex
kairon agent certify --agent claude
kairon agent certify --agent gemini
kairon agent certify --all
kairon agent certification show
```

各certificationは次を検査する。

- configured official commandのavailability
- `--version`出力からのversion正規化
- 公式loginとsetup readiness
- 最小promptのdelivery
- stdout / stderr artifactの生成
- file outboxまたは既存stdout fallbackから生成されたoutbox contract
- timeout、permission、rate / usage limit、setup required分類
- same-day sessionとのrun / status一致
- Antigravityのvisible PTY round-trip
- allowlist形式のsecret-free certification result

## Status

| status | 意味 | operator action |
| --- | --- | --- |
| `PASS` | version取得とsmoke contractが成功 | 有効期限まで監視 |
| `SETUP_REQUIRED` | CLI、公式login、permission、quota等の外部準備が必要 | 対象providerだけを準備して再実行 |
| `FAIL` | version、prompt、outbox、session、PTY等の契約回帰 | 対象CLI更新を止め、artifactを調査 |

前回成功時からversionが変わった場合、targeted smokeが成功していれば`PASS`のまま
`version_change=WARNING`を記録する。未知のnewer versionを推測でunsupportedにせず、
Doctorが再認証commandを提示する。

## Artifact Boundary

`.kairon/state/agent-certifications/{agent}/history/`と`latest.json`へ保存するのは、
正規化version、version outputのSHA-256、runner mode、分類、run / task ID、
source commit、実行時刻、有効期限、rerun command、artifact digestだけである。

次は保存しない。

- credential、token、cookie、API key
- prompt本文
- stdout / stderr本文
- provider内部API endpoint
- provider間で流用できるauthentication material

詳細調査ではcertification artifactから参照された既存smoke runを使う。provider失敗を
別providerのcredentialで回避せず、公式CLIと公式loginだけを使用する。
