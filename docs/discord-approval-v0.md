# Kairon Discord Approval v0

## 目的

Discord Approval は、個人運用で外出中でも approval queue を確認し、approve / reject / request changes を返せるようにする。
MVP では Slack 対応や常時公開 Board UI を必須にしない。

運用は 2 つに分ける。

- 外出時: Discord 上で簡易情報を見て承認 / 差し戻しする。
- 在宅時: Discord 通知を入口にし、必要なら Board で詳細を確認して承認する。

Board は在宅時の詳細確認用として loopback read-only UI を使う。スマートフォン最適化や外部公開は将来対応とする。

## 結論

個人運用の Mobile Approval は Discord first が妥当である。

- スマートフォン通知が標準で使える。
- Button / Select / Modal により approve / reject / request changes を Discord 内で完結できる。
- Board の外部公開を MVP から外せる。
- 家では Discord 通知から Board を開き、詳細に判断できる。
- 外では短い要約、risk、checks、branch、commit を見て即時判断できる。

## 推奨構成

```text
Kairon
  -> Discord Bot Connector
    -> Approval Channel / DM
      -> Button: Approve / Reject / Request Changes
        -> Discord Interaction
          -> interaction validation
          -> actor allowlist
          -> approval state validation
          -> approval.decided event
```

## 接続方式

MVP は Discord Gateway を優先する。

| Mode | 採用 | 理由 |
| --- | --- | --- |
| Discord Gateway | MVP | public callback endpoint 不要。個人PC常駐と相性が良い |
| Discord HTTP Interactions Endpoint | 将来 | serverless / cloud 化しやすいが endpoint 公開と署名検証が必要 |
| Loopback Board UI | MVP | 在宅時の詳細確認用。外部公開せず `127.0.0.1` / `localhost` で提供する |
| Board Mobile UI | 将来 | 詳細確認には有効だが、外部公開と認証設計が必要 |

Gateway で interaction を受けた場合も、Discord への interaction response は HTTP で返す。
処理は短時間で ack し、実際の state update は内部 queue に渡す。

### HTTP Interactions Endpoint

HTTP Interactions は Gateway を使わず、Discord Developer Portal の Interactions Endpoint URL から POST を受ける構成で使う。
Kairon の初期実装では、公開 HTTP server や cloud deploy は含めず、以下を満たす handler 境界を提供する。

- signature verification は `X-Signature-Ed25519`、`X-Signature-Timestamp`、Discord public key を使って実施する。
- `X-Signature-Ed25519` と `X-Signature-Timestamp` を Discord public key で検証する。
- raw body を署名検証に使い、JSON parse 後の再シリアライズ結果では検証しない。
- `type=1` の PING には PONG を返す。
- approval button / modal / `/kairon status` / `/kairon leave` は Gateway と同じ正規化関数へ渡す。
- actor allowlist、guild、channel、nonce、idempotency、high-risk policy は Gateway と同じ判定を使う。
- public endpoint 公開、TLS、reverse proxy、serverless adapter、secret manager 連携は後続 phase とする。

HTTP Interactions を本番運用する場合は `KAIRON_DISCORD_PUBLIC_KEY` 相当の値を secret として渡し、request body を middleware で加工しないこと。
Express などを使う場合も、署名検証前に JSON body parser で raw body を失わないようにする。

### Local HTTP Interactions Server

Operation test / local検証用に、loopback-onlyのHTTP server adapterを提供する。

```powershell
kairon discord http start --host 127.0.0.1 --port 18777 --max-seconds 30
```

- 既定hostは `127.0.0.1`。
- `0.0.0.0` などpublic bindは拒否する。
- `/` または `/interactions` へのPOSTを受け付ける。
- raw bodyをBufferのまま保持し、`X-Signature-Ed25519` / `X-Signature-Timestamp` の検証に使う。
- public keyは `public_key_env`、既定では `KAIRON_DISCORD_PUBLIC_KEY` から取得する。
- TLS終端、reverse proxy、public internet公開、cloud deploymentはこのadapterの対象外。

## Discord Message Design

Discord 上の approval message は、外出時に判断できる情報だけに絞る。

```json
{
  "approval_id": "APR-0001",
  "task_id": "TASK-0001",
  "title": "Merge approval: approval board",
  "type": "merge",
  "risk_level": "high",
  "summary_items": [
    "承認待ちBoardを追加",
    "npm test passed",
    "Claude reviewer approved",
    "Deployは含まない"
  ],
  "branch": "auto/TASK-0001/codex",
  "commit_sha": "abc1234",
  "checks": [
    { "name": "tests", "status": "passed" },
    { "name": "review", "status": "passed" },
    { "name": "secret_scan", "status": "passed" }
  ],
  "actions": ["approve", "reject", "request_changes"],
  "board_url": "http://localhost:3000/approvals/APR-0001"
}
```

### 表示ルール

- title は 1 行で収める。
- summary_items は最大 4 件。
- checks は `passed / failed / warning / skipped` を明示する。
- branch と commit は必ず表示する。
- risk が high の場合は理由を 1 行表示する。
- 長い diff、stdout、stderr、全文 review は Discord に流さない。

## Actions

| Action | Discord UI | 結果 |
| --- | --- | --- |
| approve | Button | `approval.decided: approve` |
| reject | Button + confirm | `approval.decided: reject` |
| request_changes | Button -> Modal | 差し戻し理由を記録 |
| open_board | Link Button | Board 詳細を開く |
| snooze | Select | 後で再通知 |

`request_changes` は Modal で短い理由を入力する。
外出時でも「何が足りないか」を Agent に返せることを優先する。

## Slash Commands

Discord から Kairon Runtime に送れる command。

| Command | 結果 |
| --- | --- |
| `/kairon status` | 現在の schedule mode、active run、pending approval を返す |
| `/kairon leave` | 本日の Active Work を終了し、Standby Work 相当へ切り替える |

Slash command は shell command を直接実行しない。
Discord Gateway が decision / command object に正規化し、Work Queue に積む。

## Decision Command

Discord interaction payload は canonical event に直接しない。
内部 decision command に正規化する。

```json
{
  "provider": "discord",
  "approval_id": "APR-0001",
  "decision": "request_changes",
  "reason": "テスト追加後に再提出してください",
  "actor": {
    "discord_user_id": "987654321",
    "mapped_user_id": "user:owner"
  },
  "message_id": "1234567890",
  "interaction_id": "2345678901",
  "custom_id": "kairon:approval:APR-0001:request_changes:42",
  "nonce": "42",
  "received_at": "2026-05-23T07:12:00+09:00"
}
```

## Security Requirements

- Discord bot token は repository に保存しない。
- approval channel は専用 channel か owner DM に限定する。
- actor は allowlist に登録された Discord user id のみ許可する。
- custom_id に approval id、action、nonce を含める。
- approval は `pending` 状態のものだけ decision 可能にする。
- callback / interaction handler は idempotent にする。
- high risk approval は、設定により Board 再確認を要求できる。
- Discord message から shell command を直接実行しない。
- decision command は Work Queue に積み、State Applier が policy check 後に反映する。

## Home / Away Mode

Discord Approval は利用者の状況に応じて表示密度を切り替える。

```json
{
  "approval_display_modes": {
    "away": {
      "max_summary_items": 4,
      "show_diff": false,
      "show_logs": false,
      "actions": ["approve", "reject", "request_changes", "snooze"]
    },
    "home": {
      "max_summary_items": 6,
      "show_board_link": true,
      "show_diff": "board_only",
      "actions": ["approve", "reject", "request_changes", "open_board"]
    }
  }
}
```

初期実装では schedule と manual toggle で `home / away` を切り替える。
Board linkはloopback URLを前提にし、スマートフォン用Boardやpublic endpointは将来のphaseで対応する。

## notifications.json

```json
{
  "primary_provider": "discord",
  "providers": {
    "discord": {
      "enabled": true,
      "mode": "gateway",
      "bot_token_env": "KAIRON_DISCORD_BOT_TOKEN",
      "public_key_env": "KAIRON_DISCORD_PUBLIC_KEY",
      "application_id_env": "KAIRON_DISCORD_APPLICATION_ID",
      "guild_id_env": "KAIRON_DISCORD_GUILD_ID",
      "approval_channel_id_env": "KAIRON_DISCORD_APPROVAL_CHANNEL_ID",
      "owner_user_id_env": "KAIRON_DISCORD_OWNER_USER_ID",
      "allowed_user_ids_env": "KAIRON_DISCORD_ALLOWED_USER_IDS",
      "use_dm": false,
      "register_commands_on_start": true
    }
  },
  "approval_policy": {
    "default_actions": ["approve", "reject", "request_changes", "snooze"],
    "require_board_reauth_for": ["deploy", "secret_change", "billing_change"],
    "require_board_confirmation_for": ["deploy", "secret_change", "billing_change", "protected_branch_push", "force_push", "branch_delete"],
    "require_local_confirmation_for": ["merge", "protected_branch_push", "force_push", "branch_delete"],
    "notify_on": ["approval.requested", "approval.decided", "run.failed"],
    "display_mode": "schedule_or_manual"
  }
}
```

`require_board_confirmation_for` または `require_local_confirmation_for` に該当する approval で Discord の approve が押された場合、Kairon は即時 `approval.decided` にしない。
代わりに `approval.confirmation_requested` event を保存し、approval status を `confirmation_required` にする。
最終承認は Board で内容を再確認した後、または local CLI の `kairon approval decide <approval-id> --action approve` で行う。

## Board UI との分担

Discord で完結させるもの。

- approve
- reject
- request changes
- snooze
- leave
- status 確認
- Board 起動

Board UI に寄せるもの。

- diff viewer
- run log
- test / lint 詳細
- review thread
- cleanup proposal の一括確認
- schedule / policy / agent 設定
- RAG retrieval source の確認

## MVP Scope

- Discord bot を 1 server / 1 owner で運用する。
- approval request を専用 channel または DM に投稿できる。
- approve / reject / request changes / snooze を受け取れる。
- request changes は Modal で理由を入力できる。
- actor allowlist、nonce、idempotency を実装する。
- decision を `approval.decided` event として保存する。

Gateway の起動、interaction ack、idempotency、slash command registration の詳細は `docs/discord-gateway-v0.md` に分離する。
- Board は在宅時の詳細確認用とし、スマートフォン最適化は後続に回す。
