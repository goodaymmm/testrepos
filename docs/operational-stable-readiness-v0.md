# Operational Stable Readiness v0

<!-- kairon:t205-operational-stable-readiness -->

T205は、Stable artifactの作成可否だけでなく、配布後のcanary、health、更新確認、
rollout、長期soak、DR、Agent互換性、diagnostics、patch保守までを15 gateで集約する。
T190のStable readinessとは別の上位判定であり、既存のBeta / RC / Stable resultを
変更しない。

## 判定原則

- current Git commitへbindしたmanifestだけを評価する。
- evidenceのpath、artifact kind、status、source commit、実行時刻、有効期限、size、
  SHA-256をmanifest作成時とcheck時の両方で検証する。
- 全15 gateがfreshな`PASS`でglobal blockerが0件の場合だけ
  `operational_stable_ready=true`とする。
- external環境が必要なgateの証跡不足は`SETUP_REQUIRED`、required gateの不足は
  `UNKNOWN`とする。
- tampered、stale、wrong commit、wrong artifact kind、wrong releaseは`UNKNOWN`として
  fail-closedにする。
- 判定はGitHub release、update、restoreを実行しない。

## Gate

| Gate | Class | Accepted evidence |
| --- | --- | --- |
| `STABLE_BASELINE_CURRENT` | required | `documentation_inventory` / `stable_readiness_result` |
| `CONSUMER_MANIFEST_VERIFY` | required | consumer manifestがverifiedの`stable_release_verification` |
| `PUBLISHED_STABLE_VERIFY` | external_required | `stable_release_verification` |
| `CLEAN_WINDOWS_CANARY` | external_required | `stable_canary_final_result` |
| `POST_RELEASE_HEALTH` | required | `post_release_health_result` |
| `UPDATE_CHECK_SCHEDULE` | external_required | `scheduled_update_check` |
| `MULTI_PROJECT_ROLLOUT` | required | `multi_project_rollout_plan` |
| `STABLE_SOAK` | external_required | `stable_soak_certificate` |
| `EVIDENCE_CATALOG` | required | `operation_evidence_catalog_verification` |
| `SCHEDULED_DR_VERIFY` | external_required | `scheduled_dr_verification` |
| `AGENT_COMPATIBILITY` | external_required | `agent_cli_compatibility_certification_summary` |
| `DIAGNOSTICS_TRIAGE` | required | `diagnostics_triage_report` |
| `PATCH_RELEASE_REHEARSAL` | external_required | `patch_release_verification_result` |
| `BUILD_UNIT_SECURITY` | required | build/full-test証跡と`security_baseline_result`の両方 |
| `STATE_SECRET_CLEANUP` | required | state/secret証跡と`patch_release_cleanup_result`の両方 |

`CONSUMER_MANIFEST_VERIFY`と`PUBLISHED_STABLE_VERIFY`には同じT194 resultを指定できる。
前者はembedded consumer verification、後者はremote Stable identity、integrity、
currentness、read-only実行を別々に評価する。

## CLI

同じgateへ複数artifactが必要な場合は`--evidence`を繰り返す。

```powershell
kairon readiness operational manifest `
  --evidence STABLE_BASELINE_CURRENT=.\evidence\t192.json `
  --evidence CONSUMER_MANIFEST_VERIFY=.\evidence\t194.json `
  --evidence PUBLISHED_STABLE_VERIFY=.\evidence\t194.json `
  --evidence CLEAN_WINDOWS_CANARY=.\evidence\t195.json `
  --evidence POST_RELEASE_HEALTH=.\evidence\t196.json `
  --evidence UPDATE_CHECK_SCHEDULE=.\evidence\t197.json `
  --evidence MULTI_PROJECT_ROLLOUT=.\evidence\t198.json `
  --evidence STABLE_SOAK=.\evidence\t199.json `
  --evidence EVIDENCE_CATALOG=.\evidence\t200.json `
  --evidence SCHEDULED_DR_VERIFY=.\evidence\t201.json `
  --evidence AGENT_COMPATIBILITY=.\evidence\t202.json `
  --evidence DIAGNOSTICS_TRIAGE=.\evidence\t203.json `
  --evidence PATCH_RELEASE_REHEARSAL=.\evidence\t204.json `
  --evidence BUILD_UNIT_SECURITY=.\evidence\full-test.json `
  --evidence BUILD_UNIT_SECURITY=.\evidence\security-baseline.json `
  --evidence STATE_SECRET_CLEANUP=.\evidence\security-baseline.json `
  --evidence STATE_SECRET_CLEANUP=.\evidence\patch-cleanup.json

kairon readiness operational check
kairon readiness operational report --format markdown
```

既定artifact:

- manifest:
  `.kairon/readiness/operational-stable-evidence-manifest.json`
- canonical result:
  `.kairon/readiness/operational-stable-result.json`
- operator report:
  `.kairon/readiness/operational-stable-report.md`

## Global Blocker

- current commitを解決できない、またはmanifest/evidence commitが一致しない
- Published Stableとconsumer/canary/health/rollout/soakのrelease identityが一致しない
- unresolved high / critical incidentまたはincident store異常
- security high / critical、secret exposure
- rollback failure
- exact-ID cleanup failure

resultにはrerun commandとrelease / update / restoreのcommand referenceだけを記録する。
`external_write_performed`は常に`false`であり、実操作には別のapprovalとexact confirmが
必要である。

## Doctor

manifestが存在するprojectでは`kairon doctor`が
`readiness.operational_stable`を追加表示する。未PASS時はgate count、blocker、
rollback、cleanup、security、incidentの集計と
`kairon readiness operational check`への導線を返す。
