# Capability and Connector Trust Policy v0

## 目的

KaironがtaskをAgentへ渡す前に、task要求、persona、Agent support、project policy、
human approval、connector trust declarationを統合し、実際に許可するcapabilityを確定する。
promptへ記載されたhintやAgent自身の申告は権限付与の根拠にしない。

## Capability Class

| Class | 例 | 既定 |
| --- | --- | --- |
| `read` | `read`, `review`, `qa`, `json.output` | 許可 |
| `workspace_write` | `coding`, `workspace.write` | 許可 |
| `external_read` | `research`, `connector:native.mcp:external_read` | 許可 |
| `git_write` | `git.write`, `merge` | approval必須 |
| `external_write` | `external.write`, `deploy` | approval必須 |
| `privileged` | `secret.access`, `billing.write` | approval必須 |

未知capabilityは既定で`denied`となる。`_`と`-`は既知capabilityのaliasを正規化するために
`.`へ変換するが、未知値を既知値として推測しない。

## Decision

decisionは次の集合から算出する。

```text
requested
  ∩ Agent supported
  ∩ project / persona policy allowed
  ∩ approval satisfied
= effective
```

statusは次のいずれかである。

- `allowed`: effective capabilityだけをAgent promptへ渡す。
- `approval_required`: capability用Approvalを作成し、Agent processを起動しない。
- `setup_required`: 宣言済みconnectorがdisabled等で利用準備されていない。
- `denied`: 未知capability、未知connector、Agent非対応、過剰scopeを拒否する。

一つでも`denied`があれば、許可可能なsubsetが存在してもjob全体を起動しない。

## Config

`agents.json`の各Agentは次を宣言する。

```json
{
  "supported_capabilities": ["read", "coding", "git.write"],
  "supported_connectors": ["native.mcp"]
}
```

`policies.json`は`capability_policy`を持つ。

```json
{
  "capability_policy": {
    "default_effect": "deny",
    "allowed_classes": [
      "read",
      "workspace_write",
      "git_write",
      "external_read",
      "external_write",
      "privileged"
    ],
    "approval_required_classes": [
      "git_write",
      "external_write",
      "privileged"
    ],
    "denied_capabilities": [],
    "approval_required_capabilities": [],
    "connectors": {
      "native.mcp": {
        "enabled": true,
        "trust_level": "restricted",
        "allowed_scopes": ["read", "external_read"],
        "data_egress": true,
        "write_actions": false
      }
    }
  }
}
```

旧configに宣言がない場合、既存task互換のbuilt-in capability matrixを使用する。
この状態は`kairon doctor`でwarningとなり、未知capability / connectorのdefault denyは維持する。

## Connector Request

明示connector requestは次の形式を使う。

```text
connector:<connector-id>:<capability-class>
```

例:

```text
connector:native.mcp:external_read
```

connectorは`enabled`、Agentの`supported_connectors`、`allowed_scopes`、
`trust_level`、`data_egress`、`write_actions`をすべて満たす必要がある。
互換aliasの`native.mcp` / `native_mcp`も同じconnector decisionへ正規化され、
trust宣言を迂回しない。

trust levelの上限:

- `untrusted`: `read`
- `restricted`: `read`, `external_read`
- `trusted`: `read`, `external_read`, write class
- `privileged`: 全class

外部scopeには`data_egress=true`、write scopeには`write_actions=true`が必要である。
未知connectorと過剰scopeはdefault denyである。

## Approval

approval対象capabilityがある場合、Kaironは`type=capability_policy`のApprovalを1件作成する。
task、Agent、requested capabilityをSHA-256 fingerprintで結び付け、pending requestを重複作成しない。

```powershell
kairon approval show APR-0001
kairon approval decide APR-0001 --action approve --reason "operator approved"
kairon task run TASK-0001
```

同じfingerprintの`approve`だけが次回評価で有効になる。`reject`と`request_changes`は
decisionを`denied`にし、別taskや変更後capabilityへのapprovalを流用しない。

## CLI

```powershell
kairon capability evaluate --task TASK-0001
kairon capability explain --task TASK-0001 --agent codex
kairon capability explain --task TASK-0001 --agent codex --format json
```

`evaluate`は最終statusとeffective setを表示する。`explain`はrequested、supported、
policy allowed、approved、reasonを追加表示する。これらはread-onlyでApprovalを作成しない。

## Artifact

task runごとに次をatomic writeする。

```text
.kairon/runs/RUN-xxxx/capability-decision.json
```

artifactにはcredential、Authorization、cookie、raw environment valueを保存しない。
blocked runもrunner / outboxとdecisionを残すため、Agent processが起動されなかったことを監査できる。
decisionは`capability_decision` memberとしてcorrelationへ紐付く。

## 安全境界

- prompt hintだけでeffective capabilityを増やさない。
- 未知capability / connector / scopeを推測許可しない。
- connector credentialやsession tokenをpolicy artifactへ保存しない。
- approvalはtask・Agent・requested setが一致する場合だけ再利用する。
- policy blocked jobではofficial Agent CLIを起動しない。
