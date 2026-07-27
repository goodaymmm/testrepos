<!-- kairon:performance-regression-gate -->

# Performance Budget v0

## 目的

T187では、queue、state、workflow、RAG、Board、multi-projectに対する
deterministic performance suiteを追加します。通常のunit testへ実時間の閾値を
混在させず、専用コマンドで絶対値budgetと同一環境baseline比を評価します。

## 判定モデル

- 各scenarioは固定seed、固定fixture size、warmup 2回、計測7回を既定値とします。
- 7 sample以上では最小値と最大値を1件ずつ除外し、中央値とp95を計算します。
- 5 sample未満の結果は生成しません。
- median、p95、heap deltaの絶対値budget超過は`UNPASSED`です。
- machine fingerprintとNode majorが一致するbaselineでは、medianまたはp95が
  1.5倍を超えると`UNPASSED`です。
- machine fingerprintまたはNode majorが異なる比較は`UNKNOWN`です。異なる環境の
  数値をbaseline regressionとして扱いません。
- network latencyはlocal runtime scenarioへ混在させません。network scenarioを
  追加する場合は`scope=network`として別budgetを定義します。

## Scenario

| Subsystem | Scenario |
| --- | --- |
| queue | 1k / 10k itemのlist、claim候補選択 |
| state | 1k recordのintegrity scan、event compaction plan kernel |
| workflow | 100 / 1k checkpoint replay |
| RAG | 1k / 10k chunkのlexical、vector、hybrid query |
| Board | 1k itemのprojection aggregation |
| projects | 10 / 50 projectのsupervisor scan |

`representative` profileは各subsystemの小さいfixtureを実行します。`full` profileは
10k fixtureを含む全scenarioを実行します。fixture定義は
`tests/fixtures/performance/scenarios.json`に固定し、外部serviceやproject sourceを
読みません。

## Artifact

benchmarkは`.kairon/performance/runs/`、比較結果は
`.kairon/performance/comparisons/`、Markdown reportは
`.kairon/performance/reports/`へ保存します。

artifactには次だけを保存します。

- source commit、Node runtime version
- OS platform、architecture、CPU model、logical CPU count
- machine metadataから生成した一方向fingerprint
- fixtureのseed、size、description
- sample、median、p95、heap delta、budget判定

hostname、username、environment variable、credential、project source本文は保存しません。

## 実行

```powershell
kairon performance run --profile representative
kairon performance run --profile full
kairon performance compare .kairon\performance\runs\<current>.json `
  --baseline .kairon\performance\runs\<baseline>.json
kairon performance report .kairon\performance\comparisons\<comparison>.json
```

baselineは同じmachine、同じNode majorで生成し、source commitとruntime versionを
artifactに残します。RC evidenceにはcurrent commitのrepresentative benchmarkと、
利用可能な場合は同一環境baseline comparisonを登録します。

## RC / Stable Gate

`PERFORMANCE_REGRESSION`はrequired RC gateです。受理するartifact kindは
`performance_benchmark_result`と`performance_comparison_result`です。
代表scenarioが`PASS`でない場合はRC / Stable promotionへ進みません。
比較環境が一致せず`UNKNOWN`になった場合は、同一環境でbaselineを再生成します。

## Unit Testとの分離

`tests/performance-budget.test.ts`は注入clockを使ってsample処理、outlier除外、
baseline比、`UNKNOWN`判定、redaction境界を決定論的に検証します。実machineの速度を
unit test assertionに使用しないため、通常suiteを不安定化・長時間化しません。
