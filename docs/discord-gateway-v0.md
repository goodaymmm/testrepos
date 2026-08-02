# Kairon Discord Gateway v0

## 目的

Discord Gateway は、Kairon の Mobile Approval と軽量 command を Discord から受け取るための接続層である。
MVP では個人利用を前提に、公開 HTTP endpoint を持たず、ローカルで起動した Gateway client が Discord から interaction を受け取る。

この仕様は次を固定する。

- Discord は approval / lightweight command channel であり、shell execution channel ではない。
- Gateway は Discord interaction を Kairon internal command に正規化する。
- State Store へ直接書かず、Work Queue / State Applier 経由で反映する。
- actor allowlist、nonce、idempotency を必須にする。
- `/kairon leave` は `kairon leave` と同じ Active Work 終了 command に変換する。

## 基本方針

- MVP は Discord Gateway mode を採用する。
- HTTP Interactions Endpoint は cloud 化フェーズまで後回しにする。
- Discord bot token は env、または明示設定したWindows Credential Manager targetから読み、repository / `.kairon/` に値を保存しない。
- Discord message には判断に必要な要約情報だけを載せる。
- 長い diff、stdout、stderr、全文 review は Discord へ送らない。
- Button / Modal / Slash Command の interaction は短時間で ack し、重い処理は内部 queue で行う。
- canonical event は `approval.decided`、`schedule.override.created`、`active_work.closed` など既存 state event に変換する。

## Official Discord Constraints

MVP の設計で前提にする Discord 側の制約。

| 項目 | Kairon の扱い |
| --- | --- |
| Interactions | Slash command、button、select、modal submit を受け取る |
| Initial response | interaction 受信後すぐに defer / ack する |
| Follow-up window | ack 後の結果通知は短時間の follow-up / message edit で行う |
| Component custom_id | 100 文字以内に収める |
| Gateway / HTTP | MVP は Gateway、将来は HTTP endpoint も選べる |

実装時は Discord 公式 docs の current spec を再確認する。

## Process Boundary

```text
kairon start
  -> Kairon Runtime Host
    -> Discord Gateway process
      -> connect Discord Gateway
      -> register or verify slash commands
      -> listen interaction events
      -> normalize interaction
      -> enqueue internal command
      -> update Discord message
```

Discord Gateway process は local runtime の一部である。
Runtime が停止している場合、Discord interaction は処理できない。

## Responsibilities

| 領域 | Gateway がやること | Gateway がやらないこと |
| --- | --- | --- |
| Connection | Discord Gateway へ接続し reconnect する | provider token を生成しない |
| Notification | approval message を投稿・更新する | Board の詳細表示を代替しない |
| Interaction | button / modal / slash command を受ける | shell command を直接実行しない |
| Security | actor / channel / nonce / idempotency を検証する | merge / deploy 承認の最終 policy 判定をしない |
| State | internal command を Work Queue に積む | canonical state を直接変更しない |

## notifications.json

```json
{
  "schema_version": "0.1",
  "primary_provider": "discord",
  "providers": {
    "discord": {
      "enabled": false,
      "mode": "gateway",
      "bot_token_env": "KAIRON_DISCORD_BOT_TOKEN",
      "application_id_env": "KAIRON_DISCORD_APPLICATION_ID",
      "guild_id_env": "KAIRON_DISCORD_GUILD_ID",
      "approval_channel_id_env": "KAIRON_DISCORD_APPROVAL_CHANNEL_ID",
      "owner_user_id_env": "KAIRON_DISCORD_OWNER_USER_ID",
      "allowed_user_ids_env": "KAIRON_DISCORD_ALLOWED_USER_IDS",
      "secrets": {
        "bot_token": {
          "provider": "windows_credential",
          "target": "Kairon/Discord/BotToken"
        }
      },
      "use_dm": false,
      "register_commands_on_start": true
    }
  },
  "approval_policy": {
    "default_actions": ["approve", "reject", "request_changes", "snooze"],
    "require_board_reauth_for": ["deploy", "secret_change", "billing_change"],
    "notify_on": ["approval.requested", "approval.decided", "run.failed"],
    "display_mode": "schedule_or_manual"
  },
  "gateway": {
    "ack_timeout_ms": 2500,
    "idempotency_ttl_minutes": 60,
    "reconnect": {
      "enabled": true,
      "max_backoff_seconds": 60
    }
  }
}
```

`ack_timeout_ms` は Discord interaction の初期応答に余裕を持たせるための Kairon 内部予算である。
`secrets.bot_token` は任意であり、envが設定されている場合はenvを優先する。Credential Manager target名だけをconfigへ書き、token値そのものは保存しない。

## Environment Variables

| Env | 必須 | 用途 |
| --- | --- | --- |
| `KAIRON_DISCORD_BOT_TOKEN` | yes | Bot login |
| `KAIRON_DISCORD_APPLICATION_ID` | yes | Slash command registration |
| `KAIRON_DISCORD_GUILD_ID` | MVP yes | 個人 server の guild command registration |
| `KAIRON_DISCORD_APPROVAL_CHANNEL_ID` | channel mode yes | Approval channel |
| `KAIRON_DISCORD_OWNER_USER_ID` | yes | owner allowlist |
| `KAIRON_DISCORD_ALLOWED_USER_IDS` | optional | comma separated allowlist |

MVP は guild command registration を使う。
global command registration は反映遅延があり、個人運用の MVP では不要である。

## Bot Permissions

MVP に必要な権限は最小にする。

- Send Messages
- View Channel
- Use Slash Commands
- Read Message History

Message content intent は使わない。
Kairon は user の通常 chat message を読む必要がない。

## Slash Commands

登録する command。

```text
/kairon status
/kairon leave
```

MVP では command surface を狭く保つ。
`/kairon task run` のような実行系 command は Discord からは提供しない。

### `/kairon status`

返す情報。

- schedule mode
- active work closed flag
- active runs count
- pending approvals count
- last error if any

Discord response は ephemeral を優先する。

### `/kairon leave`

処理。

```text
interaction received
  -> ack
  -> actor allowlist check
  -> create internal command
  -> enqueue schedule override command
  -> update response
```

内部 command。

```json
{
  "schema_version": "0.1",
  "command_id": "CMD-0001",
  "type": "schedule.close_active_work",
  "source": "discord",
  "actor": {
    "discord_user_id": "987654321",
    "mapped_user_id": "user:owner"
  },
  "payload": {
    "date": "2026-05-24",
    "reason": "discord_kairon_leave"
  },
  "idempotency_key": "discord:interaction:2345678901",
  "received_at": "2026-05-24T15:00:00+09:00"
}
```

State Applier はこの command から `schedule.override.created` と `active_work.closed` を作る。

## Approval Notification

`approval.requested` event を受けて Discord message を投稿する。

```json
{
  "schema_version": "0.1",
  "notification_id": "NTF-0001",
  "approval_id": "APR-0001",
  "provider": "discord",
  "target": {
    "channel_id": "1234567890",
    "message_id": null
  },
  "status": "pending_send",
  "display_mode": "away",
  "created_at": "2026-05-24T10:00:00+09:00"
}
```

Message に載せる情報。

- approval id
- task title
- approval type
- risk level
- summary items
- checks
- branch
- commit SHA if available
- action buttons
- Board link if available

Message に載せない情報。

- full diff
- long logs
- secret-like values
- raw outbox
- provider session details

## Component custom_id

`custom_id` は短く、idempotency と対象特定に必要な情報だけを入れる。

```text
kr:v1:apr:{approval_id}:{action}:{nonce}
```

例。

```text
kr:v1:apr:APR-0001:approve:n42
kr:v1:apr:APR-0001:reject:n42
kr:v1:apr:APR-0001:changes:n42
kr:v1:apr:APR-0001:snooze:n42
```

`custom_id` に user input や長い title を含めない。
nonce は approval message 作成時に発行し、`.kairon/approvals/APR-xxxx.json` 側に保存する。

## Interaction Handling

共通 flow。

```text
interaction received
  -> record discord.interaction.received
  -> ack or defer
  -> verify provider config
  -> verify actor allowlist
  -> verify channel / guild
  -> verify idempotency key
  -> parse custom_id or slash command
  -> validate target state
  -> enqueue internal command
  -> update Discord response/message
```

Gateway は State Store に直接 decision を書かない。
内部 command を `.kairon/state/inbox/` または Work Queue に積み、State Applier が state lock 下で反映する。

## Approval Decision Command

Button / Modal から生成する internal command。

```json
{
  "schema_version": "0.1",
  "command_id": "CMD-0002",
  "type": "approval.decide",
  "source": "discord",
  "approval_id": "APR-0001",
  "decision": "request_changes",
  "reason": "テスト追加後に再提出してください",
  "actor": {
    "discord_user_id": "987654321",
    "mapped_user_id": "user:owner"
  },
  "discord": {
    "guild_id": "1111111111",
    "channel_id": "2222222222",
    "message_id": "3333333333",
    "interaction_id": "4444444444",
    "custom_id": "kr:v1:apr:APR-0001:changes:n42"
  },
  "nonce": "n42",
  "idempotency_key": "discord:interaction:4444444444",
  "received_at": "2026-05-24T10:20:00+09:00"
}
```

State Applier はこの command から `approval.decided` event を作る。

## Request Changes Modal

`request_changes` は Modal で理由を入力する。

Modal custom_id。

```text
kr:v1:apr:APR-0001:changes_modal:n42
```

理由の制約。

- 1 文字以上
- 1000 文字以下
- secret-like pattern が含まれる場合は保存前に warning / redact を検討する

理由は Agent の fix job context に含めるため、短く具体的な内容を推奨する。

## Snooze

Snooze は approval を閉じず、再通知予定だけを更新する。

```json
{
  "type": "approval.snooze",
  "approval_id": "APR-0001",
  "until": "2026-05-24T18:00:00+09:00",
  "source": "discord"
}
```

MVP の snooze preset。

- 30 minutes
- 2 hours
- tomorrow 07:00

## Idempotency

Discord interaction は再送・二重クリック・reconnect により重複する可能性がある。
Kairon は次の key を保存する。

```text
discord:interaction:{interaction_id}
discord:approval:{approval_id}:{action}:{nonce}
```

保存先。

```text
.kairon/runtime/discord/idempotency.json
```

Schema。

```json
{
  "schema_version": "0.1",
  "keys": {
    "discord:interaction:4444444444": {
      "status": "accepted",
      "command_id": "CMD-0002",
      "created_at": "2026-05-24T10:20:00+09:00",
      "expires_at": "2026-05-24T11:20:00+09:00"
    }
  }
}
```

同一 idempotency key が既に `accepted` の場合、同じ結果を返し、state command は再投入しない。

## Actor And Channel Validation

必須 validation。

- `discord_user_id` が owner または allowed users に含まれる。
- `guild_id` が設定された guild と一致する。
- `channel_id` が approval channel または owner DM と一致する。
- approval が `pending` または `snoozed` である。
- nonce が approval に保存された nonce と一致する。
- action が approval の許可 actions に含まれる。

失敗時は ephemeral response で拒否理由を返し、`discord.interaction.rejected` event を出す。

## Message Update Policy

Decision 後、Discord message を更新する。

| Decision | Message update |
| --- | --- |
| approve | approved 状態にし、buttons を無効化 |
| reject | rejected 状態にし、buttons を無効化 |
| request_changes | changes requested 状態にし、buttons を無効化 |
| snooze | snoozed 状態と再通知時刻を表示 |

Message update 失敗は canonical state を巻き戻さない。
`notification.update_failed` を記録し、次回 sync で再試行する。

## Reconnect And Recovery

Gateway 起動時。

```text
load notifications.json
load runtime/discord/session.json
connect gateway
register slash commands if enabled
scan pending approvals
scan notification records
reconcile missing messages
start interaction loop
```

Recovery の原則。

- Discord message が消えていても approval state を canonical とする。
- pending approval に message がない場合は再投稿する。
- already decided approval の button interaction は rejected として扱う。
- Gateway downtime 中に承認できなかったものは file-based approval として残る。

## Runtime Files

```text
.kairon/runtime/discord/
  session.json
  commands.json
  idempotency.json
  notifications.json
  last_error.json
```

`session.json`。

```json
{
  "schema_version": "0.1",
  "status": "connected",
  "started_at": "2026-05-24T10:00:00+09:00",
  "last_heartbeat_at": "2026-05-24T10:01:00+09:00",
  "last_sequence": 123,
  "guild_id": "1111111111"
}
```

## Events

Gateway が出す event。

- `discord.gateway.started`
- `discord.gateway.connected`
- `discord.gateway.disconnected`
- `discord.command.registered`
- `discord.interaction.received`
- `discord.interaction.rejected`
- `notification.sent`
- `notification.updated`
- `notification.update_failed`
- `notification.failed`

State Applier が command から出す canonical event。

- `approval.decided`
- `schedule.override.created`
- `active_work.closed`

## Security Notes

- Bot token は `.env` や secret manager に置き、Git 管理対象にしない。
- Discord 上に secret、full logs、provider session info を表示しない。
- Discord user id は user identity として扱い、display name を認可に使わない。
- high risk approval は Board 再確認や local passkey confirmation を後続 phase で追加できる。
- deploy / secret / billing 系は Discord approve だけでは完了させない policy を許可する。

## MVP Done Criteria

- `kairon doctor` が Discord env の不足を検出できる。
- `kairon start` が Discord Gateway process を起動できる。
- `/kairon status` が runtime status を返す。
- `/kairon leave` が `schedule.close_active_work` command を queue に積む。
- `approval.requested` から Discord message を投稿できる。
- approve / reject / request_changes / snooze を受け取れる。
- request_changes modal の理由を command に保存できる。
- actor allowlist、channel validation、nonce、idempotency が働く。
- decision は `approval.decided` event として反映される。
- 二重 interaction が state を二重更新しない。

## References

- Discord Developers: Interactions & Commands
  - https://docs.discord.com/developers/platform/interactions
- Discord Developers: Receiving and Responding to Interactions
  - https://docs.discord.com/developers/interactions/receiving-and-responding
- Discord Developers: Component Reference
  - https://docs.discord.com/developers/components/reference
- Discord Developers: Application Commands
  - https://docs.discord.com/developers/docs/interactions/slash-commands
