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

## 安全境界

- 全project一括start / stopは行わない。
- project横断task / approval / state migrationは行わない。
- multi-user central serverとして使用しない。
- registryは各projectのcanonical stateの所有者にならない。
- `projects doctor`は通常の`kairon doctor`を内部実行しない。通常doctorにはartifact更新を伴うcheckがあるため、横断診断はread-only helperだけで構成する。
