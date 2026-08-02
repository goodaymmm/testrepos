# Multi-project Operations v0

## 目的

Kaironを導入した複数projectを、canonical stateを混在させずuser-local registryから一覧・診断する。T173のsupervisorはread-onlyであり、各projectのruntime、queue、approval、configを変更しない。

## Registry

既定のWindows path:

```text
%LOCALAPPDATA%\Kairon\projects.json
```

testまたは隔離運用では環境変数で差し替える。

```powershell
$env:KAIRON_PROJECTS_REGISTRY_PATH = "C:\tmp\kairon-user-state\projects.json"
# または
$env:KAIRON_USER_DATA_DIR = "C:\tmp\kairon-user-state"
```

registryは次だけを保持する。

- project ID
- normalized root
- registered / last seen timestamp
- observed Kairon version
- credential、query、fragmentを除去したBoard URL
- pass / warning / error件数だけのlast doctor summary
- optional rollout group（`canary` / `primary` / `deferred`）

token、cookie、Authorization、approval detail、task本文、project source、raw diff、stdout / stderr、raw environment valueは保存しない。

registry更新は`projects.json.lock`を使い、期限切れlockだけを回収する。JSONはtemporary fileからatomic renameする。JSON破損、schema不一致、duplicate ID / rootを検出した場合は自動修復や空registryへの置換を行わない。

## 登録

```powershell
kairon projects register M:\EnglishApp
kairon projects register C:\work\AnotherProject
kairon projects list
kairon projects show englishapp
```

`register`はrootと`.kairon/config/project.json`を読み、project IDを確認する。同じroot / IDの再登録はidempotentである。同じIDが別の存在するrootへ登録済みの場合は拒否する。既存rootが消失した後に同じIDの新rootを登録した場合は、`previous_root`を残して移動として扱う。

登録解除はregistryだけを変更し、対象projectを削除しない。

```powershell
kairon projects unregister englishapp
```

## Read-only doctor

```powershell
kairon projects doctor
kairon projects doctor --format json
```

各projectについて次を順次読む。

- project IDとconfigured root
- `.kairon/config/*.json` validation
- runtime lock、queue件数、pending approval件数、Watchdog件数の縮約summary
- Board server runtime status
- Discord HTTP Interactions server runtime status
- provider policyの`max_concurrent`
- installed Kairon version、project config schema version
- state integrity error / warning件数

複数project間では次を確認する。

- duplicate project ID / normalized root
- missing / unreadable / moved root
- Kairon version差
- ready状態のBoard / Discord HTTP host + port衝突
- ready状態のexternal URL衝突
- providerごとのproject数と`max_concurrent`合計

provider合計はcapacity計画の参考情報であり、supervisorが割当、suspend、fallback、起動を行うことはない。

## Isolation確認

temporary projectを2つ用意する場合の確認例:

```powershell
$env:KAIRON_PROJECTS_REGISTRY_PATH = Join-Path $env:TEMP "kairon-projects-test\projects.json"
kairon projects register C:\tmp\project-a
kairon projects register C:\tmp\project-b
kairon projects doctor --format json
```

確認事項:

1. project-aのqueue / approval変更がproject-bのsummaryへ現れない。
2. doctor前後で両projectの`.kairon/`file hashが変わらない。
3. 同じportのready statusを持つ場合に両projectへcollision warningが付く。
4. rootを移動・削除した場合にerror分類される。
5. registryが破損した場合にproject stateへ影響せず処理を停止する。

## Scheduled health

T185ではread-only supervisorを定期実行し、user-local snapshotを生成できる。

```powershell
kairon projects health scan
kairon projects health report
```

scan profileはproject単位timeout、bounded concurrency、retention日数、alert threshold、provider pressure thresholdを持つ。1 projectのtimeoutまたは読取失敗は、そのprojectの`project_inspection_timeout` / `project_inspection_failed`へ隔離され、残りのproject結果を失わない。registry全体が破損している場合も、子projectを変更せずuser-local failed snapshotを残す。

artifactはregistryと同じuser-local directory配下の`scheduled-health/`へ保存する。

- `latest.json`: 最新snapshot
- `snapshots/*.json`: retention対象の履歴
- `rollups/daily/*.json`: 日次集計
- `rollups/weekly/*.json`: 週次集計
- `profile.json`: 最後に使用したscan profile
- `task-status.json`: Windows Task Schedulerの観測結果

snapshotはproject ID、health状態、縮約runtime、endpoint状態、provider limit、前回差分だけを保持し、project rootを保存しない。T183 alert policyは通知可否の判定結果だけをsnapshotへ記録する。scheduled health自身はDiscord送信、queue投入、approval生成を行わない。

`kairon doctor`の`projects.scheduled_health` checkはこのuser-local artifactだけを読む。scheduled health未実行は導入前互換としてPASS、failed snapshot、stale snapshot、task error / disabledはWARNINGになる。

## Canary-first rollout plan

T198ではprojectをoptional rollout groupへ割り当てる。既存entryにfieldがない場合は
`deferred`として読み、次回の明示的なgroup変更まで一括更新対象にしない。

```powershell
kairon projects rollout group englishapp-canary --set canary
kairon projects rollout group englishapp-primary --set primary
kairon projects rollout group archived-project --set deferred

cd M:\EnglishApp
kairon projects rollout plan --target-version 0.3.1
kairon projects rollout show <plan-id>
```

planはcurrent PASS Stable verification、registry、各projectの次の縮約summaryへbindする。

- project ID / root / rollout group
- installed / registered Kairon version
- config schema version
- health statusとlast health timestamp
- runtime active / stopped
- state integrity error / warning件数

runtime active、state integrity error、targetより新しいinstalled version、missing root、
health error、Stable verificationのmissing / invalid / expiry / version mismatchはblockerである。
canaryが1件以上必要で、全canaryがtarget versionかつhealth PASSになるまでprimaryは
`canary_not_completed`となる。canary成功後は新しいplanを作成し、primary向けに
`update download`とexact confirmation付き`update apply`の手動templateを表示する。

planはregistry隣接の`rollout-plans/`へatomic writeし、input digestとplan digestを持つ。
`rollout show`はcurrent inputを再収集し、project / state / Stable verificationの変更または
期限切れを`stale`としてcommandを非表示にする。plan内にcredential、approval本文、task本文、
raw doctor output、project source本文を保存しない。

## 安全境界

- 全project一括start / stopは行わない。
- project横断task / approval / state migrationは行わない。
- multi-user central serverとして使用しない。
- registryは各projectのcanonical stateの所有者にならない。
- `projects doctor`は通常の`kairon doctor`を内部実行しない。通常doctorにはartifact更新を伴うcheckがあるため、横断診断はread-only helperだけで構成する。
- `projects health scan`も通常doctor、runtime start / stop、queue claim、approval decisionを実行しない。
- `projects rollout plan / show`はpackage download / apply、runtime start / stop、
  Task Scheduler登録、approval decisionを実行しない。
