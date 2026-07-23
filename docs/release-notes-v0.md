# Release Notes v0

Kaironのrelease判断に使う手動release notesです。自動生成ではなく、release前に
`docs/release-checklist-v0.md` を確認してから更新します。

## Unreleased

- T170: Agent sessionのprompt byte数、job数、経過秒数、compaction回数を追跡するcontext budget、soft-limit compaction plan、hard-limit dispatch停止、sanitized handoff付きrotationと中断復旧を追加。
- T169: canonical JSON checkpointを維持する`WorkflowCheckpointStore`、optional Node SQLite mirror、checksum / fencing検証、degraded継続、exact-confirm付きindex rebuildを追加。
<!-- kairon:release-notes-unreleased -->
現時点の未release変更は、各PR本文とmerge履歴を一次記録とします。local operation resultやgenerated evidenceはrelease notesへ埋め込まず、再実行方法と判定結果だけを記録します。

- approval-gated GitHub Release配布とremote asset再検証を追加。
- verified manual update channel、user-local cache、successful apply / rollback registryを追加。
- local-only sanitized support bundle、pre/post secret scan、ZIP hash検証を追加。
- runtime heartbeat、queue、provider、notification、Task Schedulerを監視するdeduplicated Watchdog alertとDiscord routingを追加。
- Watchdog alertとruntime recovery targetを集約するIncident lifecycle、append-only timeline、Incident限定support bundle、approval-gated assisted recoveryを追加。
- production workflowを明示`runtime.json`設定、proposal適用、env互換fallback、doctor競合診断を持つ正式configへ昇格。
- production workflowへtyped definition、allowlist condition、parallel branch、明示join policy、manual gate、approval-gated compensation plan / executionを追加。

## Versioning

<!-- kairon:versioning-policy -->
現在のLocal Beta versionは `0.2.0` です。version変更時は `package.json`、
`package-lock.json`、`src/index.ts` の `KAIRON_VERSION` を同時に更新します。
`kairon release validate` は、この同期とcore SemVer形式に加えて、`Unreleased` marker、
現在versionのrelease entry、release checklistの必須markerを一括確認します。

0.x期間の目安:

- `0.MINOR.0`: CLI、config schema、artifact contract、運用フローに互換性影響がある変更。
- `0.MINOR.PATCH`: bug fix、diagnostics、docs、test、operation harness改善。
- docs-only / local-only operation資料の追加では、原則versionを変更しない。

## Release Entry Template

```markdown
## <version> - YYYY-MM-DD

### Summary

-

### Tests

- `npm run build`
- `npm test`
-

### Manual / Operation Test Evidence

-

### Known Limitations

-
```

## 0.2.0 - 2026-07-22

### Summary

- T159までのWindows daemon、guarded GitHub merge / deploy、production workflow、Discord HTTP Interactions、remote read-only Board、state backup / compaction、RAG integrity、provider policy、private local package lifecycle、Beta readiness gateをLocal Beta baselineとして収録。
- package / CLI / lockfileのversionを`0.2.0`へ同期。
- tarball、checksum manifest、sorted package inventory、source commit、runtime supportをbindする`release-manifest.json`を追加。
- dirty tracked source、tampered tarball、checksum manifest差替え、inventory差異をrelease検証で拒否。

### Tests

- `npm run build`
- `npx vitest run tests\release-command.test.ts tests\local-beta-package.test.ts tests\release-manifest.test.ts tests\pr-release-docs.test.ts`
- `npm test`

### Manual / Operation Test Evidence

- clean checkoutとWindows Sandboxでのpack / verify / install / rollbackはrelease artifact生成後に実施する。

### Known Limitations

- public npm registryへpublishしない。
- GitHub Release配布とmanual update channelは実装済みであり、background auto-updateは対象外のまま維持する。
- npm tar metadataの時刻差を許容し、再現性は同一source commit、package inventory、artifact metadataの検証可能性で判定する。

## 0.1.0 - MVP baseline

- Local runtime、queue、approval、agent runner、review loop、maintenance、cleanup、recovery、Board、RAG、GitHub / Discord運用補助の基盤を扱うMVP baseline。
- npm publishは前提にせず、local CLIとして `npm link` で運用する。
