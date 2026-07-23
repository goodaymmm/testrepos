# Workflow Checkpoint Store Decision

## Status

Accepted for T169.

## Decision

Kaironはworkflow checkpointのcanonical stateをJSON fileとして維持する。検索と整合性確認を高速化するoptional mirrorには、Node 22標準の`node:sqlite`を使用する。

## Driver Evaluation

| 評価項目 | 判断 |
| --- | --- |
| Node 22 | `node:sqlite`はNode 22.5以降で提供され、Kaironの`engines.node >=22`と一致する |
| Windows | Node本体に同梱され、Windows用の追加native package installを必要としない |
| CI | `actions/setup-node@v4`のNode 22で利用できる |
| license | Node.js runtimeの構成要素として既存runtime license境界内で利用する |
| prebuilt binary | 外部prebuilt binaryやpostinstallを追加しない |
| maintainer activity | Node.js release lineと同じ保守経路を利用する |
| vulnerability surface | npm dependency、extension loading、任意SQL inputを追加しない |
| stability | Node 22ではexperimental warningが出るため、optional生成indexに限定する |

外部SQLite packageは追加しない。package install失敗時の代替parserも実装しない。

## Persistence Order

1. workflow sequence、timestamp、checkpoint pathを確定する。
2. checkpoint metadataを除いたartifactからSHA-256 state hashを計算する。
3. canonical checkpoint JSONをatomic writeする。
4. current workflow run artifactをatomic writeする。
5. `checkpoint_store=file+sqlite`の場合だけresource lockを取得し、SQLite rowをtransactionでupsertする。
6. mirror失敗時はworkflow結果を維持し、store healthだけを`degraded / rebuild_required`へ更新する。

SQLite rowは次の列を持つ。

```text
workflow_id
sequence
state_hash
fencing_token
checkpoint_path
recorded_at
```

複数resource lockが存在するcheckpointでは、sort済みfencing token集合のSHA-256を`multi:<digest>`として保存する。lockがない場合は`none`を保存する。

## SQLite Policy

- journal mode: WAL
- synchronous: NORMAL
- busy timeout: config値、既定5000 ms
- extension loading: disabled
- schema version: metadata tableで管理
- write: transaction + workflow ID / sequence primary key
- canonical fileとの不一致: workflowを停止せずrebuild required

## Verification

`kairon workflow checkpoint verify`は次を検査する。

- checkpoint filenameとartifact workflow ID / sequence
- canonical JSONから再計算したstate hash
- node resource lockから再計算したfencing token
- canonical fileとSQLite rowのhash / fencing token / path
- missing row / orphan row
- SQLite unavailable / corrupt / unsupported schema

canonical file側の不整合は`failed`であり、index rebuildでは修復しない。SQLite側だけの不整合は`mismatch`かつ`rebuild_required=true`となる。

## Rebuild Safety

rebuildはdry-run planとexact confirmの二段階で行う。

1. canonical fileをscanし、file側issueが0件であることを確認する。
2. record set digestを含む`WCR-*` planを保存する。
3. confirm時にrecord set digestを再計算し、plan後の変更を拒否する。
4. rebuild resource lockを取得する。
5. temporary SQLite DBへ全rowを書き込む。
6. current DBをbackup renameし、temporary DBを置換する。
7. 成功後にbackupを削除し、healthを`healthy`へ戻す。

## Backup and Recovery

SQLite DB、`-wal`、`-shm`は生成indexとしてstate backupから除外する。canonical checkpoint JSONとrebuild plan / status artifactは通常のJSON stateとして扱う。DB削除・破損・lock後はcanonical fileから再構築する。

## Rejected Alternatives

- SQLiteをcanonical stateにする
- remote databaseを導入する
- npm native SQLite packageを追加する
- 独自SQLite parserを実装する
- mirror失敗をworkflow failureとして扱う
