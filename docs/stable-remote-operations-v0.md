# Stable Remote Operations v0

<!-- kairon:stable-remote-operations -->

## 目的

`stable-remote-readonly`は、Discord HTTP Interactionsとread-only Boardを同じ固定リモート運用方針で管理するprofileである。短命なquick tunnel URLではなく、operatorが管理する固定HTTPS host、TLS終端、identity-aware proxyを前提にする。

KaironはDNS、TLS certificate、Cloudflare Tunnel、VPN、IdP applicationを作成・変更しない。外部基盤の自動provision、Board write API、token付きdeep linkも提供しない。

<!-- kairon:t175-stable-remote-baseline -->
T175 Release Candidate baselineでは、固定hostnameでのDiscord interactionとBoard readiness、IdP認証後のsmartphone read-only閲覧、access revoke後の拒否、tunnel disconnect / URL drift alert、再起動後の同一URL復旧、secret-free Board deep linkをoperation test済みである。外部host、tunnel、IdPはoperator管理のため、release判定時はcurrent source commitに対するfresh evidenceを再取得する。

## Config

`.kairon/config/notifications.json`へ次を設定する。

```json
{
  "remote": {
    "profile": "stable-remote-readonly",
    "discord_interactions_base_url": "https://ops.example.com/discord/",
    "board_base_url": "https://ops.example.com/board/",
    "trusted_proxies": ["127.0.0.1/32"],
    "allowed_origins": ["https://ops.example.com"],
    "identity_header": "x-kairon-verified-identity"
  }
}
```

- 2つのbase URLは固定HTTPS URLでなければならない。
- `localhost`、loopback IP、`*.trycloudflare.com`はstable profileとして拒否する。
- `board_base_url`のoriginを`allowed_origins`へ含める。
- `trusted_proxies`はKairon loopback backendへ接続するreverse proxyだけに限定する。
- `identity_header`はreverse proxyが認証成功後に設定し、外部requestから渡された同名headerをproxy側で除去・上書きする。

profile有効時は、Discordへ`reverse-proxy`、Boardへ`remote-readonly`の実効設定を配布する。従来の`notifications.http`と`notifications.board`はprofile無効時の互換設定として残る。

## CLI

```powershell
kairon remote profile show
kairon remote profile show --format json
kairon remote profile validate
kairon remote status
kairon remote doctor
```

- `profile show`: 実効設定と旧設定からの移行提案を表示する。設定を書き換えない。
- `profile validate`: networkへ接続せず、固定URL、CIDR、origin、identity headerを検証する。
- `status`: local runtime artifactと設定URLを照合し、起動状態とURL driftを表示する。直前の外部診断結果は上書きしない。
- `doctor`: 外部Discord readinessと未認証Board accessをprobeし、疎通、identity enforcement、tunnel状態を保存する。

状態は`.kairon/runtime/remote/status.json`へ保存する。raw response body、cookie、Authorization、identity値、access tokenは保存しない。

## 外部構成

推奨経路:

```text
Discord / browser
  -> fixed HTTPS host
  -> TLS + identity-aware reverse proxy
  -> 127.0.0.1 Discord HTTP / Board server
```

Discord Interactions endpointは`<discord_interactions_base_url>/interactions`、readinessは`<discord_interactions_base_url>/ready`となる。Boardは未認証requestに401、403、またはIdPへのredirectを返す必要がある。未認証で2xxになる場合、`remote doctor`はidentity bypassとして検出する。

Discord approval通知の`Open Board`は固定`board_base_url`とapproval anchorだけを含む。access token、credential、query secretは含めない。
決定後にaction buttonを除去したstatus messageにも同じ固定Board URLを残す。

## 起動と停止

起動時はidentity-aware reverse proxy、Board、Discord HTTP endpointの設定を揃えた後に、次の順で状態を確認する。

```powershell
kairon remote profile validate
kairon board serve --profile remote-readonly
# 別PowerShell
kairon discord http start --profile reverse-proxy
# reverse proxy / tunnelを起動した後
kairon remote doctor
```

Board serverとDiscord HTTP serverはforeground processである。停止時は新規trafficを止め、各processへ`Ctrl+C`を送り、reverse proxy / tunnelを停止する。その後`kairon remote status`でlocal endpointが停止済みであることを確認する。Kaironは外部proxyやtunnel processを強制終了しない。

## Watchdog

`kairon remote doctor`の最新要約をWatchdogが読み、次をalert化する。

- `remote_external_unreachable`
- `remote_identity_bypass`
- `remote_url_drift`
- `remote_tunnel_disconnected`

Watchdogは毎tickで外部通信せず、保存済みの診断要約だけを評価する。tunnel再接続、DNS変更、IdP policy変更は自動実行しない。

## 旧設定からの移行

`notifications.http.profile=reverse-proxy`と`notifications.board.profile=remote-readonly`が整合している場合、`kairon remote profile show`は`migration_proposal=available`を表示する。proposalはread-onlyであり、自動適用しない。operatorが内容を確認して`notifications.remote`へ転記し、次の順で確認する。

```powershell
kairon remote profile validate
kairon discord http start --profile reverse-proxy
kairon board serve --profile remote-readonly
kairon remote status
kairon remote doctor
kairon watchdog check
```

## 安全境界

- Boardはread-onlyを維持する。
- fixed hostやIdPの管理者権限をKaironへ渡さない。
- external URLへtokenを埋め込まない。
- 外部疎通失敗を自動で別hostへ切り替えない。
- identity bypassはcritical alertとし、operatorがproxy policyを修正するまで運用を継続しない。
