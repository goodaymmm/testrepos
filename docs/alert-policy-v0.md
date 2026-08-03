<!-- kairon:alert-policy -->
# Alert Escalation / Maintenance Policy v0

## Scope

Kairon applies a local notification policy to Watchdog transitions before Discord delivery. Alert and Incident state remains canonical even when delivery is deferred, suppressed, or aggregated.

## Configuration

`notifications.json` uses `alert_policy` with these bounded settings:

- `timezone`: IANA timezone used for all daily windows and budgets.
- `routes`: fixed route ID, `discord` or `local_audit`, and minimum severity.
- `quiet_hours`: recurring daily time ranges. Overnight ranges are supported.
- `maintenance_windows`: recurring daily time ranges. Overlaps are diagnosed.
- `reminder_interval_seconds`: minimum time between reminder deliveries.
- `daily_budget`: unique Discord messages allowed per local date before aggregation.

The default policy preserves immediate delivery, sets no quiet or maintenance windows, routes `warning` and above to Discord, and limits a day to 50 messages.

## Decision Rules

1. A resolved transition always bypasses quiet hours, maintenance, reminder interval, and daily budget when a Discord route exists.
2. The first critical transition, including an escalation to critical, has the same bypass.
3. A route below its minimum severity is suppressed without changing alert state.
4. Quiet hours and maintenance keep the pending transition with a reason and `defer_until`.
5. Maintenance release sends one summary before any remaining individual notifications.
6. Daily budget overflow sends one aggregate summary while retaining each alert artifact.
7. Discord message nonce is derived from the persisted idempotency key so daemon restarts do not duplicate one transition.

## State And Audit

- Pending metadata is stored in `.kairon/watchdog/alerts/ALT-*.json`.
- Policy and delivery events are appended to `.kairon/watchdog/audit.jsonl`.
- Policy decisions are linked to the Incident resource timeline.
- Bounded policy decisions are counted by local metrics.
- Acknowledgement, snooze, maintenance deferral, and resolution remain distinct states.

## Doctor

`kairon doctor` warns through `watchdog.alerts` when it finds:

- an invalid timezone;
- duplicate route IDs or duplicate provider/severity routes;
- a zero daily budget;
- overlapping maintenance windows.

No credential value, alert body, raw error, or project source is written to policy metrics.
