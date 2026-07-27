# Stable Acceptance v0

<!-- kairon:stable-acceptance -->

## 目的

Stable End-to-End Acceptance Harnessは、T176-T188の成果とT189のcross-system境界を
同じtest ID、source commit、evidence aliasで再検証するためのローカル証跡基盤である。
Stable公開可否の最終判定は行わず、T190 readiness gateへ入力するfresh evidenceを作る。

## 生成

```powershell
$stamp = Get-Date -Format yyyyMMddHHmmss
kairon test docs `
  --range T176-T189 `
  --template stable-acceptance `
  --name-prefix t176-t189-stable-acceptance `
  --result-root "operation-test-results\stable-acceptance-$stamp"
```

生成物は次の4点である。

- `docs/t176-t189-stable-acceptance-test-list-v0.md`
- `docs/t176-t189-stable-acceptance-commands-v0.md`
- `<result-root>/evidence-manifest.json`
- `<result-root>/cleanup-plan.json`

生成したtest list、command list、result rootはoperation evidenceであり、commitしない。
本書だけを実装契約としてcommitする。

## Manifest契約

`evidence-manifest.json`はGit HEADのsource commit、文書SHA-256、固定test ID、
classification、checkpoint、evidence aliasを保持する。statusは生成時に`NOT_RUN`であり、
previous result rootでPASS済みのIDだけ`PASS`参照として引き継げる。

引き継いだPASSの元証跡は変更しない。新しいresult rootの`selected_test_ids`には
未PASSだけを含め、再実行結果は新しいrootへ書く。

分類は次の2種類である。

- `required`: local / fixture / deterministic testで完了できる必須項目
- `external_required`: GitHub、Discord、Clean Windows、smartphone、再起動などfresh外部証跡が必要な必須項目

`external_required`の前提不足は`SETUP_REQUIRED`であり、unit test成功や過去の目視だけで
自動的にPASSへ変更しない。

## Checkpoint分離

PowerShell command listは`command-group`コメントで次を分離する。

- automated required test
- Windows Sandbox
- GitHub / network dependency
- Discord / smartphone
- Windows reboot前後
- exact resource cleanup
- final summary

Windows Sandbox timeout、PowerShell process終了、Discord操作、OS再起動を同じblockへ
入れない。reboot後はCOMMON groupを再実行し、source commitとresult rootを再読込する。

## Cleanup安全境界

cleanup planは外部resource作成前に生成する。削除可能なのは次の全条件を満たすresourceだけである。

1. harnessが作成したことを記録している。
2. release ID、tag、credential target、scheduled task名、PID、sandbox ID、directoryなどの
   exact IDが記録されている。
3. manifestのrun IDとcleanup confirmationが一致する。

exact IDが空のresourceは削除せず`skip`する。prefix、wildcard、latest resource、
repository全体、credential種別全体を対象にした削除は禁止する。

## Secret境界

command file、clipboard helper、stdout、summary、manifestへcredential値を保存しない。
記録できるのは環境変数名、credential provider名、present / missing、sanitized reasonだけである。
`Authorization` header、Bot token、PAT、Discord public/private materialの値は証跡対象外とする。

## Summary

各resultは`id`、`status`、`name`、sanitized `details`だけを持つ。
`kairon test summarize`は`summary.json`に加えてStable evidence manifestのcarried PASSを読み、
test list aliasへ解決する。test listにないIDを新規PASSとして追加せず、
`missing_from_list`は実装またはgeneratorの不整合として扱う。

cleanupが未完了、requiredがFAIL / SETUP_REQUIRED、external_requiredがSETUP_REQUIREDの
いずれかであれば、T190 Stable readinessへ完了証跡として渡さない。

`FINAL_SUMMARY`は各scenarioの最終statusとevidence path、`SUMMARY`と更新後
`CLEANUP_PLAN`のSHA-256、`completed_at`をevidence manifestへ固定する。18 scenarioが
すべて`PASS`でcleanupも`completed`の場合だけmanifestを`completed`とし、それ以外は
`incomplete`とする。T190はこのfinalized manifestだけを受理する。
