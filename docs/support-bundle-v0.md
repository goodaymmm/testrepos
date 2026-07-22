# Kairon Sanitized Support Bundle v0

<!-- kairon:sanitized-support-bundle -->

## 目的

障害調査に必要なKaironの状態を、credential、project source、raw agent outputを含めず、operatorが明示的に共有できる1つのlocal ZIPへまとめる。

## 安全境界

収集は次の明示allowlistだけを使用する。既存directoryやraw artifactを再帰copyしない。

| Category | 内容 |
| --- | --- |
| system | Kairon / Node version、platform、doctorの安全な集計 |
| runtime | schedule、lock、daemon、recoveryのallowlist field |
| queue | queue、approval、follow-up、sessionの件数 |
| provider | provider status、quota counter、retry時刻、policy |
| workflow | task / run / reviewのstatus別件数。最大500 recordを集計 |
| notification | Discord / Boardのstatusとdoctor check |
| integrity | RAG、secret scan、backup、readiness関連のstatus |

次の内容は常に除外する。

- project source、working tree content、`.env`、protected path
- token、password、cookie、authorization、private key
- raw stdout / stderr、prompt、context、agent output、daemon log
- diff、patch、command line
- 自動upload、support portal送信、clipboard copy

## Dry Run

```powershell
cd C:\path\to\target-project
kairon support bundle --dry-run
```

収録予定file、category、推定size、除外理由を表示する。dry-runは`.kairon/support/`、counter、ZIPを変更しない。

## Bundle生成

既定の出力先は`.kairon/support/bundles/`である。外部directoryへ保存する場合は`--output`を指定する。

```powershell
kairon support bundle
kairon support bundle --output C:\Users\operator\Desktop\kairon-support
```

実行結果:

```text
.kairon/support/plans/SUP-0001.json
<output>/kairon-support-SUP-0001.zip
```

ZIP内は固定allowlistである。

```text
manifest.json
hashes.sha256
summary.md
diagnostics/system.json
diagnostics/runtime.json
diagnostics/queue.json
diagnostics/provider.json
diagnostics/workflow.json
diagnostics/notification.json
diagnostics/integrity.json
```

生成処理はsanitized payloadをstagingし、secret pattern scan通過後にZIPを作る。作成したZIPを再parseし、entry path、duplicate、link、CRC、size、SHA-256、manifest、secret patternを確認できた場合だけatomic renameする。

## 検証

共有前と受領後の両方で検証する。

```powershell
kairon support verify C:\path\to\kairon-support-SUP-0001.zip
```

合格条件:

- `verification.ok=true`
- `PASS archive`、`PASS paths`、`PASS manifest`、`PASS hashes`
- `secret_scan=passed`
- `secret_findings=0`

失敗時は共有せず、元ZIPを編集して再利用しない。新しいbundleを生成する。

## Operator確認

1. `--dry-run`で収録categoryと除外理由を確認する。
2. bundle生成後に`kairon support verify`を実行する。
3. ZIP名とSHA-256をincident記録へ残す。
4. 必要な相手へoperatorが明示的に送付する。
5. 調査完了後は組織のretention policyに従って削除する。

Kaironはbundleをnetworkへ送信しない。
