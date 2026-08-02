<!-- kairon:diagnostics-triage -->

# Diagnostics Triage v0

## 目的

`kairon diagnostics triage`は、Doctor、Watchdog、Incident、correlation、
Stable readiness、update transaction、Agent CLI certification、support bundle planを
read-onlyで相関し、operatorが次に行う安全な操作を優先度順に確認するためのcommandである。

triageはrestart、restore、update、incident recovery、approval decisionを実行しない。
状態変更が必要な場合も、実行commandを`approval_required`として提示するだけである。

## Command

```text
kairon diagnostics triage
kairon diagnostics triage --format json
kairon diagnostics triage --format markdown
kairon diagnostics triage --output <path>
```

`--output`を指定すると、拡張子を除いた同一base pathへJSONとMarkdownをatomic writeする。
例として`--output reports/triage.json`は`reports/triage.json`と
`reports/triage.md`を生成する。指定しない場合はstdoutだけを使用し、report artifactを
作成しない。

## Source

| Source | 読み取り対象 |
| --- | --- |
| Doctor | warning / error check、`next_action` |
| Watchdog | unresolved alert、severity、fingerprint |
| Incident | active incident、resource、correlation ID |
| Correlation | memberとartifact path |
| Stable readiness | `.kairon/readiness/stable-result.json` |
| Update | `.kairon/update/transactions/UTX-*.json` |
| Agent certification | Codex、Claude、AntigravityCLIのlatest inspection |
| Support bundle | `.kairon/support/plans/SUP-*.json` |

sourceが欠落している場合は空の正常状態として扱う。存在するsourceが壊れて読み取れない
場合は`source_read_failed`としてreportを`PARTIAL`にし、raw exceptionやstack traceは
保存しない。

## Root Cause集約

findingは次の順でgroup化する。

1. correlation ID
2. update transaction ID
3. release ID
4. Watchdog fingerprint
5. root cause category

同じIncidentへ紐づくWatchdog alertとupdate rollback failureは1つのtriage itemへ
集約される。itemには関連finding ID、Incident / transaction / release ID、
project-relative evidence pathだけを記録する。

root cause categoryは以下を使用する。

- `configuration`
- `credentials`
- `agent_compatibility`
- `runtime_health`
- `incident_recovery`
- `data_integrity`
- `release_readiness`
- `update_recovery`
- `remote_connectivity`
- `support_evidence`

## Action Class

- `read_only`: `doctor`、`show`、`list`、readiness check、certification、
  support bundle dry-runなど。
- `approval_required`: Incident assisted recoveryなど、実行前にapprovalとexact confirmを
 必要とする操作。
- `external_manual`: 公式CLI login、GitHub / Discord設定、networkやsubscriptionの
 外部操作。

triageは削除、force push、`git reset`、credential値を含むcommandを出力しない。
critical / high itemにはsanitized support bundleのdry-runをread-only actionとして
追加する。

## Redaction

reportは以下を保存しない。

- token、password、cookie、authorization header
- prompt、stdout、stderr、diff、raw request payload
- raw stack trace
- project外のabsolute path
- Windows credential path

JSONとMarkdownは書き込み前にsecret scanし、findingがある場合は出力しない。
evidence pathはproject-relative pathへ正規化する。

## Status

- `PASS`: itemがなく、全sourceを安全に読み取れた。
- `ATTENTION_REQUIRED`: 1件以上のoperator actionがある。
- `PARTIAL`: 1件以上のsourceを安全に読み取れなかった。

`PARTIAL`は自動修復の理由にはならない。まず`kairon doctor --format json`と、
source固有のread-only commandで証跡を確認する。
