# Session Context Budget v0

## 目的

同日中に維持する公式CLI Agent sessionが無制限に肥大化することを防ぎ、contextの圧縮とsessionの交代を監査可能にする。
Kaironはprovider内部の残量を推測して操作せず、送信したprompt量とcanonical artifactから得られる指標だけを管理する。

## 計測

`.kairon/config/agents.json` の `session_budget` で次の4指標を管理する。

| 指標 | 意味 |
| --- | --- |
| `prompt_bytes` | Kaironが公式CLIへ送信したUTF-8 prompt byte数 |
| `job_count` | sessionへ投入したjob数。bootstrapは加算しない |
| `elapsed_seconds` | budget window開始からの経過秒数 |
| `compaction_count` | 同一sessionで完了したcompaction累計 |

`budget_source` は `kairon_estimated`、`provider_observed`、`mixed`、`unavailable` のいずれかを記録する。
providerがusage値を返さない場合、Kairon推定値をprovider観測値として表示しない。

既定値:

```json
{
  "session_budget": {
    "enabled": true,
    "soft_limit": {
      "prompt_bytes": 8000000,
      "job_count": 40,
      "elapsed_seconds": 21600,
      "compaction_count": 3
    },
    "hard_limit": {
      "prompt_bytes": 16000000,
      "job_count": 80,
      "elapsed_seconds": 43200,
      "compaction_count": 5
    },
    "compaction_keep_runs": 10,
    "resource_lock_ttl_seconds": 60
  }
}
```

各soft値は対応するhard値より小さくする。閾値に到達したjob自体は完了させ、その後のdispatchから判定を適用する。

## 状態遷移

```text
within_limit
  -> soft_limit
  -> compacting
  -> within_limit | soft_limit | hard_limit

within_limit | soft_limit
  -> hard_limit
  -> rotating
  -> within_limit
```

- soft limit到達時はcompaction planを自動生成する。dispatchは継続できる。
- hard limit、`compacting`、`rotating` では新規dispatchを拒否し、dispatcherは別Agentを選ぶ。
- active runがあるsessionはcompactまたはrotateできない。
- 操作はAgent/date単位のresource lockで直列化する。

## Compaction

```powershell
kairon agent session budget codex
kairon agent session compact codex --dry-run
kairon agent session compact codex --confirm CMP-...
```

dry-runは次を作成する。

```text
.kairon/sessions/YYYY-MM-DD/{agent}/compactions/{plan-id}.json
```

confirmはplan IDの完全一致とsource hashの一致を要求する。plan作成後にrunやmanifestが変化した場合はstaleとして拒否する。
成功時は直近 `compaction_keep_runs` 件だけをmanifestへ残し、bounded handoffを `active-handoff.json` と `active-handoff.md` に反映する。

handoffに含める情報:

- 現在のobjective
- 未完了作業
- run / approvalの判断
- canonical artifact参照
- source hash

stdout、stderr、scratch本文、credential、secret値は取り込まない。各配列は最大50項目、各文字列は最大500文字に制限する。

## Rotation

```powershell
kairon agent session rotate codex --reason "hard limit reached"
```

rotationはsanitized handoffを作成し、同じAgent/dateに新しいsession IDを発行する。
budget windowは0へ戻し、`rotation_count`だけを引き継ぐ。旧sessionを別のcanonical `session.json` として残さず、rotation artifactに旧状態と新状態の対応を記録する。

```text
.kairon/sessions/YYYY-MM-DD/{agent}/rotations/{rotation-id}.json
.kairon/sessions/YYYY-MM-DD/{agent}/rotations/{rotation-id}.handoff.json
.kairon/sessions/YYYY-MM-DD/{agent}/rotations/{rotation-id}.handoff.md
```

## 障害復旧

- compaction中断: 完了artifactがなければ次回open時に状態を再評価し、dispatch可能またはhard limitへ戻す。
- rotation中断: canonical `session.json` が新sessionならrotationを完了扱いにし、旧sessionなら旧sessionをactiveとして復旧する。
- resource lock競合: 後続操作を拒否し、同じplanを重複実行しない。
- 日次境界との競合: 日次handoffとbudget handoffは同じsummary contractを使い、翌日のContextBuilderは当日の`active-handoff.md`も明示的に読み込む。

## 証跡確認

```powershell
kairon agent session show codex
kairon agent session budget codex
Get-Content .kairon\sessions\$(Get-Date -Format yyyy-MM-dd)\codex\session.json -Raw
Get-ChildItem .kairon\sessions\$(Get-Date -Format yyyy-MM-dd)\codex\compactions
Get-ChildItem .kairon\sessions\$(Get-Date -Format yyyy-MM-dd)\codex\rotations
```

`session show` と `budget` では、status、dispatch可否、4指標、source、理由、active planを確認できる。
