# Kairon RAG Memory v0

## 目的

RAG Memory は、Agent が毎回すべての project document を読む必要をなくし、必要な文脈だけを job ごとに渡すための derived index である。
canonical source は JSON / JSONL / MD であり、RAG index はいつでも再構築できる補助データとして扱う。

## Memory Layers

| Layer | 内容 | 寿命 | Retrieval |
| --- | --- | --- | --- |
| rules | AGENTS.md、CLAUDE.md、GEMINI.md、Kairon rules | 長期 | 常に優先 |
| facts | project構成、test command、API contract | 変更まで | metadata filter |
| decisions | 承認、設計判断、却下理由 | 長期 | task / resource filter |
| episodes | run log、review、QA結果 | 中期 | recency + similarity |
| documents | PRD、仕様、外部公式docs | 長期 | collection routing |
| code | file summary、symbol、test map | commitごと | path / symbol filter |

## Index Pipeline

```text
canonical files
  -> loader
  -> normalizer
  -> chunker
  -> metadata enricher
  -> embedding
  -> vector index
  -> lexical index
  -> manifest
```

## Document Metadata

```json
{
  "doc_id": "rules:AGENTS.md:sha256:...",
  "collection": "project_rules",
  "project_id": "example-app",
  "source_path": "AGENTS.md",
  "source_type": "rule",
  "task_id": null,
  "resource": "repo:*",
  "persona": ["planner", "implementer", "reviewer", "qa"],
  "risk_level": "all",
  "created_at": "2026-05-23T00:00:00+09:00",
  "updated_at": "2026-05-23T00:00:00+09:00",
  "hash": "sha256:..."
}
```

## Retrieval Plan

Agent は自由に検索しない。
Control Plane が task と persona から retrieval plan を作る。

retrieverは`lexical|vector|hybrid`の共通filter contractを持つ。vector capabilityが
`SETUP_REQUIRED`、index missing、dimension mismatch、source driftの場合はlexicalへ
fallbackし、結果を`degraded`として明示する。外部embedding APIへの自動fallbackは行わない。

```json
{
  "task_id": "TASK-0001",
  "persona": "implementer",
  "query": "approval board implementation constraints",
  "collections": ["project_rules", "task_state", "code_index", "decisions"],
  "filters": {
    "project_id": "example-app",
    "resource": ["repo:path:src/**", "state:approvals"]
  },
  "top_k": 8,
  "rerank": true,
  "compress": true
}
```

## Context Budget

RAG の失敗は「情報不足」だけでなく「情報過多」でも起きる。
persona ごとに context budget を分ける。

| Persona | 優先 context |
| --- | --- |
| planner | requirements、decisions、dependency graph |
| implementer | rules、acceptance、relevant files、test map |
| reviewer | diff、rules、past incidents、acceptance |
| qa | acceptance、test map、past failures、run logs |
| researcher | external docs、requirements、decision gaps |
| maintainer | generated paths、cleanup policy、past cleanup |

## Update Policy

- rule / config 更新時は即時 re-index。
- commit / push 後に code_index を更新する。
- run 完了時に task_history と episodes を更新する。
- approval decision 発生時に decisions を更新する。
- maintenance time に stale chunk と orphan index を掃除する。

## Incremental Refresh

- 初回refreshはfull indexを作成する。
- 2回目以降はsource manifestの`file_mtime_ms`と`file_size_bytes`を比較し、未変更sourceとchunkを再利用する。
- file metadataが変わった場合だけsanitized content hashを再計算し、hashが同じなら既存chunkを維持する。
- indexの`refresh` summaryへscanned / added / updated / unchanged、理由別skip / prune件数を保存する。
- protected / generated / missing / archivedは別理由として記録し、secret値や本文はsummaryへ保存しない。
- `kairon rag status`はindex作成後に追加・変更・削除されたsource件数をread-onlyで検査し、`fresh`または`stale`を表示する。

## Integrity And Rebuild

- index manifestはsource/chunkの安定fieldだけから決定的SHA-256を計算し、可変時刻をchecksum対象に含めない。
- `kairon rag verify`はmanifest checksum、件数、重複ID、orphan chunk、source/chunk hash、source driftを検証する。
- 検証結果は`.kairon/rag/integrity/latest.json`へ保存し、本文やcredentialは含めない。
- `kairon rag stats --duplicates --context-budget`は重複chunk比率、推定token、最大chunk、context budget超過、rebuild期限、retention候補を表示する。
- `kairon rag rebuild --dry-run --compare`はfull candidateをmemory上に生成し、現在indexを書き換えずquery sampleのmatch消失を検査する。
- rebuild planは`.kairon/rag/rebuilds/<rebuild-id>.json`へ保存する。retention超過artifactは候補として数えるだけで直接削除しない。
- `kairon rag rebuild --execute --confirm <rebuild-id>`はexact confirmation、planned candidate checksum、current index checksumを再検証した場合だけatomic swapする。
- plan後にsourceまたはindexが変わった場合は新しいplanを要求する。
- refresh、compact、rebuild candidate、rebuild executeは同じindex resource lockを使い、同時書込みを拒否する。

## Safety

- secret path は index しない。
- `.env`, credential, token, private key は chunk 化しない。
- provider embedding を使う場合は外部送信対象と追加 API 課金の有無を明示する。
- MVP は外部 embedding API を前提にせず、local embedding を標準にする。
- retrieval result には source id と hash を必ず含める。
- RAG result は根拠であり、policy decision の唯一の根拠にしない。

## Local Vector And Quality Gate

- 既定provider候補はpure Node 22で動作する`local_hash`とする。model download、外部network、追加license、native binaryを必要とせず、Windowsでも同一checksumを再現できる。
- semantic modelが必要な場合の`local_onnx`はcapability placeholderであり、runtime未導入は`SETUP_REQUIRED`とする。
- embedding cache keyはmodel ID、dimension、chunk ID、chunk text checksumから作る。変更のないchunkはincremental buildで再利用する。
- vector manifestにはprovider、model ID、dimension、entry count、source manifest checksum、lexical/vector index checksumだけを保存し、embedding値をlogへ出さない。
- hybrid scoreは正規化したlexical/vector score、freshness、同一sourceのdiversity penaltyから決定する。
- quality gateはexpected source、forbidden source、precision@K、fallback statusで判定し、generative answer本文をgolden dataにしない。

## rag.json

```json
{
  "enabled": true,
  "storage": {
    "base_dir": ".kairon/rag",
    "vector": "local",
    "lexical": "local",
    "graph": "local"
  },
  "embedding_profile": "local_default",
  "integrity": {
    "query_samples": ["approval routing", "runtime recovery", "review findings"],
    "context_budget_tokens": 12000,
    "max_duplicate_ratio": 0.25
  },
  "rebuild": {
    "interval_days": 30,
    "retention_days": 90,
    "max_artifacts": 20
  },
  "collections": {
    "project_rules": { "enabled": true, "required": true },
    "task_state": { "enabled": true },
    "task_history": { "enabled": true },
    "code_index": { "enabled": true },
    "decisions": { "enabled": true },
    "incidents": { "enabled": true },
    "external_docs": { "enabled": true }
  },
  "security": {
    "exclude_paths": [".env*", "**/*.pem", "**/*secret*", "**/*token*"],
    "require_source_hash": true
  }
}
```

## MVP Scope

- local index を作成できる。
- project rules と task state を検索できる。
- context bundle を生成できる。
- source id / hash 付きで retrieval result を保存できる。
- re-index を maintenance job として実行できる。
