# Kairon Local Observability v0

Kairon records runtime health metrics locally. It does not send metrics to an
external telemetry service and does not require a collector.

## Artifacts

- Raw daily samples: `.kairon/metrics/raw/YYYY-MM-DD.jsonl`
- Latest aggregate snapshot: `.kairon/metrics/snapshots/latest.json`
- Daily and weekly reports: `.kairon/metrics/rollups/`
- Latest SLO summary: `.kairon/metrics/slo/latest.json`

Raw samples use fixed metric names and bounded labels. Task bodies, prompts,
diffs, usernames, tokens, raw errors, and project/task/run IDs are rejected.
Alert policy decisions use the bounded `notification_policy_decision_total`
metric and never store route IDs or alert payloads as labels.

## Commands

```powershell
kairon metrics snapshot --window-minutes 60
kairon metrics report --period daily
kairon metrics report --period weekly
kairon metrics slo check
```

`INSUFFICIENT_DATA` is not a passing SLO result. A malformed raw sample is
reported as `CORRUPT_DATA`. The watchdog reads only the persisted latest SLO
summary and does not aggregate raw samples during each check.

## Retention

Raw metric and rollup limits are part of `policies.json` under
`cleanup.retention.categories`. Cleanup remains proposal-based; metric files are
not deleted directly by the metrics commands.
