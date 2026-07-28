# Release Notes v0

Kaironのrelease判断に使う手動release notesです。自動生成ではなく、release前に
`docs/release-checklist-v0.md` を確認してから更新します。

## Unreleased

<!-- kairon:release-notes-unreleased -->

0.3.0 Stable baseline確定後の変更をここへ記録します。

各PR本文とmerge履歴を一次記録とし、local operation resultやgenerated evidenceはrelease
notesへ埋め込まず、再実行方法と判定結果だけを記録します。

## Versioning

<!-- kairon:versioning-policy -->
現在のStable Local Release versionは `0.3.0`です。T160-T191の変更をcurrent source
commitへ固定し、GitHub Releaseへのpublish / Stable昇格はapproval-bound操作として
readiness判定から分離します。version変更時は `package.json`、
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

## 0.3.0 - 2026-07-28

### Summary

- T160-T168のapproval-gated GitHub Release、verified manual update / rollback、sanitized support bundle、Watchdog、Incident lifecycle、production workflowを収録。
- T169-T174のdurable workflow checkpoint、Agent context budget、capability trust policy、hybrid local RAG、multi-project supervisor、stable remote operationsを収録。
- T175の14 gate Release Candidate readinessとT176のoperator document baselineを収録。
- package / CLI / lockfileのversionを`0.3.0`へ同期し、同一source commitから生成したartifactの正規化inventory、runtime support、source identityを比較できる再現性testを追加。
- T178で決定的なCycloneDX 1.6 SBOMとlocal build provenanceを追加し、package、
  checksum manifest、release manifest、source commitへbind。
- T179で同一release / tag / source / 5 assetを維持するapproval-gated Stable promotionを追加。
- T180-T181でschema migration planとtransactional update / rollback health gateを追加。
- T182-T186でlocal metrics / SLO、alert policy、bounded self-healing、
  scheduled multi-project health、off-device DRを追加。
- T187-T188でdeterministic performance regression gateとfresh npm auditを含む
  Stable security baselineを追加。
- T189-T190で18 scenarioのStable Acceptanceと16 gateのStable Readinessを追加し、
  判定とGitHub promotionを分離。
- T191でStable再テスト時のSBOM、security、acceptance、CI blockerを修正。

### Migration / Upgrade

- `0.2.0`からの更新は、`kairon update download 0.3.0`とexact confirm付き`kairon update apply`、または`update-local-beta.ps1`を使う。
- update前に`kairon doctor`とstate backupを確認し、rollback用`0.2.0` artifactをverified cacheへ保持する。
- config migration、state backup / restore、rollback、uninstall後のproject `.kairon/`保持は既存contractを維持する。

### Tests

- `npm run build`
- `npx vitest run tests\release-command.test.ts tests\local-beta-package.test.ts tests\release-manifest.test.ts tests\pr-release-docs.test.ts tests\documentation-inventory.test.ts`
- `npm test`
- clean tracked sourceからの`release:pack`、`release manifest`、`release verify`

### Manual / Operation Test Evidence

- T160-T175 operation testで当時のRC readiness 14 gate、global blocker 0件、
  secret finding 0件を確認。
- T189 Stable Acceptanceで18 / 18 scenarioを確認。
- T191 blocker修正後のcurrent sourceでStable Readiness 16 / 16 gate、
  `stable_ready=true`、global blocker 0件を確認。
- clean Windowsで0.2.0から0.3.0へのupdate、意図した失敗時rollback、再update、
  uninstall後のproject state保持を確認。

### Known Limitations

- public npm registryへpublishしない。
- `0.3.0`は個人運用向けStable Local Releaseであり、GitHub Releaseへのpublishと
  Stable昇格は専用のapproval-bound commandによる明示操作とする。
- npm tar metadataの時刻差を許容し、再現性は同一source commit、正規化inventory、runtime support、検証可能metadataで判定する。
- background auto-updateとsilent updateは提供しない。

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
