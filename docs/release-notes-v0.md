# Release Notes v0

Kaironのrelease判断に使う手動release notesです。自動生成ではなく、release前に
`docs/release-checklist-v0.md` を確認してから更新します。

## Unreleased

<!-- kairon:release-notes-unreleased -->
T159までに、Windows 24時間daemon、guarded GitHub merge / deploy、production workflow、Discord HTTP Interactions、remote read-only Board、state backup / compaction、RAG integrity、provider policy、private local package lifecycle、Beta readiness gateを実装・operation test済みです。

現時点の未release変更は、各PR本文とmerge履歴を一次記録とします。正式なreleaseを切る場合は、この節から対象versionの節へ要約を移します。local operation resultやgenerated evidenceはrelease notesへ埋め込まず、再実行方法と判定結果だけを記録します。

## Versioning

<!-- kairon:versioning-policy -->
現在のT159 Local Beta baseline versionは `0.1.0` です。version変更時は `package.json` と
`src/index.ts` の `KAIRON_VERSION` を同時に更新します。
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

## 0.1.0 - MVP baseline

- Local runtime、queue、approval、agent runner、review loop、maintenance、cleanup、recovery、Board、RAG、GitHub / Discord運用補助の基盤を扱うMVP baseline。
- npm publishは前提にせず、local CLIとして `npm link` で運用する。
