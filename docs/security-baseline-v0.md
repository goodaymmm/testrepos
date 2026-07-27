# Kairon Stable Security Baseline v0

<!-- kairon:security-check-report -->

## 目的

Stable配布前にdependency、archive / path、credential、HTTP boundary、child process、
generated artifact、canonical stateを一つのsecret-safe evidenceへ集約する。

## 実行

networkを使う`npm audit`はKaironのoffline checkと分離してJSONへ保存する。

```powershell
npm audit --omit=dev --json |
  Out-File .kairon\security\npm-audit.json -Encoding utf8

kairon security check `
  --npm-audit .kairon\security\npm-audit.json `
  --artifact <external-dr-catalog.json>

kairon security report .kairon\security\security-baseline.json
```

`--artifact`は複数指定できる。defaultでは`release-artifacts/`、`.kairon/metrics/`、
`.kairon/performance/`、`.kairon/backups/`、`.kairon/recovery/`のJSON、JSONL、
Markdownを最大256件、1件2 MiBまでscanする。project外のDR catalogは絶対pathを
artifactへ保存せず、`<external>/<basename>`へ置換する。

## 判定

| Status | 条件 |
| --- | --- |
| `PASS` | offline check PASS、fresh npm audit evidenceあり、high / critical 0、secret exposure 0 |
| `SETUP_REQUIRED` | offline checkはPASSだがnpm audit evidenceがない、読めない、またはschema不明 |
| `UNPASSED` | high / critical finding、lock / license違反、path / archive / HTTP / process policy違反、state error、secret exposure |

`SECURITY_INTEGRITY`はexternal-required RC gateであり、
`security_baseline_result`を受け付ける。evidenceはcurrent source commitへbindし、
24時間以内に再生成する。

## Dependency Policy

- direct production dependency: `commander`、`discord.js`、`node-pty`、`zod`
- production transitive packageはofficial npm registryとsha512 integrityを必須とする
- license allowlist: `0BSD`、`Apache-2.0`、`BSD-2-Clause`、`BSD-3-Clause`、
  `ISC`、`MIT`
- high / critical npm advisoryはStable blockerとする

## Archive / Path Policy

- compressed 64 MiB、expanded 256 MiB、entry 4096件、1 entry 64 MiB
- compression ratio 200以下、path 240文字以下
- traversal、absolute / UNC、backslash、control character、reserved device name、
  trailing dot / space、case-insensitive collisionを拒否する
- symbolic / hard link entryとrestore先のsymlink / junctionを拒否する

## HTTP / Process Policy

- Discord body 1 MiB、header 16 KiB / 64件、request timeout 10秒
- Discord timestamp tolerance / replay TTLは300秒以下
- BoardはGET / HEADのみ、header 16 KiB / 64件
- child process outputはstdout / stderr各4 MiBに制限し、末尾を保持する
- shell使用はWindowsのreview済みshimに限定する

## Secret Safety

resultにはfinding code、severity、safe subjectだけを保存し、secret本文、raw environment、
hostname、username、絶対user pathを保存しない。生成したSecurity Baseline JSONと
Markdown report自体もsecret scanを通過する必要がある。
