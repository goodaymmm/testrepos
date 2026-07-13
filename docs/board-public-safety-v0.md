# Board Public Safety v0

## 目的

Kairon Board は `.kairon/` の運用状態を集約する read-only view である。現時点の実装は loopback-only のローカル確認用途に限定し、public endpoint や mobile 外部公開は有効化しない。

この文書は、将来 Board を外部公開またはスマートフォンから確認できる導線に拡張する前に満たすべき安全要件を固定する。

## 現在の安全境界

- `kairon board serve` は `127.0.0.1` / `localhost` だけを許可する。
- `0.0.0.0`、LAN IP、IPv6 wildcard、public hostname への bind は拒否する。
- defaultはtoken不要のloopback-onlyを維持し、opt-inで短期`board.read` Bearer tokenを要求できる。
- token本体は起動時だけ表示し、status artifactにはSHA-256 hash、期限、scopeだけを保存する。
- projectionは最終出力前に再帰的なsecret scanを通し、結果を`meta.secret_scan`へ保存する。
- access auditは`.kairon/runtime/board/access.jsonl`へ保存し、raw token、IP、User-Agentを含めない。
- Board は approval の状態確認と local CLI hint の表示だけを行う。
- Board から approval action、merge、deploy、protected branch push を直接実行しない。
- Board projection は raw diff、stdout/stderr、secret-like key、非local Board URLを表示しない。
- Discord approval message に載せる Board URL も local loopback URL のみを扱う。

## 機密情報分類

| 分類 | 例 | Boardでの扱い |
| --- | --- | --- |
| Secret | token, API key, password, cookie, authorization header | 常に `[redacted]` または省略 |
| Raw logs | stdout, stderr, full diff, patch body | 集約件数やstatusだけ表示 |
| Local state | task id, run id, approval id, review id | 表示可。ただしpathはproject-relativeに限定 |
| Operator hint | local CLI command hint | 表示可。実行はoperatorがterminalで行う |
| External URL | public Board URL, webhook URL, unknown host | Board projectionから除外 |

## Threat Model

### Token leakage

攻撃例:

- approval payload、daemon error、Discord audit reason に token が混入する。
- external Board URL の query string に token が含まれる。

対策:

- secret-like key は projection生成時にredactする。
- inline textは `token=...`、`api_key=...` 形式をredactする。
- `board_url` は `http://127.0.0.1` / `http://localhost` 以外を除外する。
- Bearer tokenをURL query、HTML、projection、status artifactへ書かない。
- token必須modeでは短いTTLを使用し、期限切れと`board.read`以外のscopeを拒否する。

## Local short-lived access

```powershell
kairon board serve --require-token --access-token-ttl-seconds 900
```

- `--require-token`は既定900秒のtokenを生成する。
- `--access-token-ttl-seconds`を指定すると、最大86400秒の範囲でtoken必須modeを有効にする。
- clientは`Authorization: Bearer <token>`を付ける。
- tokenはprocess memoryと起動時CLI出力だけで扱い、`.kairon/runtime/board/server.json`にはhash、`expires_at`、`board.read` scopeだけを残す。
- 認証後もserverはGET/HEADだけを許可し、state変更endpointは持たない。

## Access audit / secret scan

- access auditは`allowed`、`denied`、`error`、method、分類済みroute、HTTP status、認証結果だけを記録する。
- clientは`loopback`として分類し、raw IPは保存しない。
- User-Agentは値を保存せず、存在したかだけを記録する。
- URL query、Authorization header、Bearer tokenはaudit対象外とする。
- secret scanはsecret-like keyを`[redacted]`または`[omitted]`へ置換する。
- inline assignment、Bearer token、high-confidenceなGitHub/OpenAI credential形式も置換する。
- 正常にredactできた件数はPASS summaryとして扱い、redaction発生だけでDoctorをwarningにしない。
- 保存済みprojectionに未redact値がある場合、またはscan summaryがない場合だけ`board.secret_scan`をwarningにする。

### Approval forgery

攻撃例:

- Board画面のbuttonからapproval decisionを偽造する。
- public endpointへ直接POSTして承認済み扱いにする。

対策:

- Boardはread-onlyに固定し、action endpointを持たない。
- approval decisionは既存の `kairon approval decide`、Discord signed interaction、または明示的なfollow-up runnerだけが処理する。
- 将来public Boardを作る場合も、CSRF対策、signed nonce、actor allowlist、audit logを必須にする。

### Raw log exposure

攻撃例:

- stdout/stderrやdiffにsecretまたは個人情報が含まれ、Boardから閲覧可能になる。

対策:

- Board projectionはraw log本文を持たず、status、exit_code、event_countだけを表示する。
- review findingやerror messageは短縮し、secret-like textをredactする。

## Public公開前の必須要件

1. TLS terminationを必須化する。
2. 認証を必須化する。候補は GitHub OAuth、Discord OAuth、またはshort-lived signed access token。
3. read-only scopeを維持し、approval actionは別経路へ分離する。
4. operator allowlistを導入する。
5. request / decision / view access auditを残す。
6. Board projectionのsecret scanをCIまたはoperation testに含める。
7. public URLをartifactに保存する場合はsecretを含めない。
8. defaultは引き続きpublic disabledにする。

## Auth候補比較

| 候補 | 利点 | リスク | 採用条件 |
| --- | --- | --- | --- |
| GitHub OAuth | repository権限と紐づけやすい | private repo planやscope設計の影響を受ける | read-only scopeとowner allowlistを実装できること |
| Discord OAuth | 既存approval運用と相性がよい | guild / channel権限の誤設定で見えすぎる | guild id、user id、role allowlistを検証できること |
| Short-lived signed token | 実装が小さい | URL漏洩時に期限内アクセスされる | 短TTL、one-time nonce、audit、再発行UIがあること |

## Mobile compact view

現時点のmobile対応はローカルBoardの視認性改善に限定する。

- Compact Overviewを先頭に表示する。
- 横長tableは横スクロールに逃がす。
- ID、path、command hintは折り返して画面外にはみ出さないようにする。
- mobile対応によって表示情報量やredaction境界を変えない。

## 対象外

- public bindの有効化。
- Boardからのapproval決定。
- Board上のmerge / deploy実行。
- 認証なしpublic endpoint。
- `.kairon/` artifactへのsecret保存。

