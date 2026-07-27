# Kairon Stable Threat Model v0

<!-- kairon:stable-security-baseline -->

## Scope

Kaironは単一operatorがWindows 11、PowerShell 7、Node 22で利用するprivate local
runtimeである。本modelはpublic SaaS、multi-tenant control plane、public npm publishを
対象にしない。

## Asset

- `.kairon/`配下のcanonical config、state、approval、workflow、incident、evidence
- project sourceとGit history
- local release package、checksum manifest、SBOM、provenance
- GitHub / Discord / reverse proxy / Agent CLIへ接続するcredential
- off-device backupとDR catalog
- Board projection、metrics、performance report、support bundle

## Actor

- trusted single operator
- Kairon local runtime
- allowlist済み公式Agent CLI
- GitHub、Discord、npm registry等のexternal provider
- untrusted project content、archive、HTTP request、generated output

## Trust Boundary

1. operator processとOS credential store
2. project sourceと`.kairon/` canonical state
3. child processとして起動するAgent / Git / npm CLI
4. loopback HTTP serverとreverse proxy
5. GitHub / Discord / npm registry
6. project外のoff-device backup destination

credential値、raw prompt、raw diff、stdout / stderr、Authorization / Cookieはtrust
boundaryを越えるdiagnostic artifactへ保存しない。

## Abuse CaseとMitigation

| Abuse case | Mitigation |
| --- | --- |
| archive traversal / absolute / UNC path | portable relative path policy、root prefix、path length上限 |
| symlink / junction / reparse escape | extraction / restore前のlink拒否、archive link entry拒否 |
| reserved device name / trailing dot / case collision | Windows portable path policyとcase-insensitive collision検査 |
| archive bomb | compressed / expanded size、entry count / size、compression ratio上限 |
| dependency差替え | direct dependency allowlist、official registry、sha512 lock integrity |
| prohibited license | production transitive dependencyのlicense allowlist |
| high / critical advisory | timestamp付き`npm audit --omit=dev --json` evidenceを必須化 |
| HTTP resource exhaustion | body、header bytes / count、request timeout上限 |
| forged Discord callback | Ed25519 signature、timestamp tolerance、replay guard |
| reverse proxy spoofing | HTTPS external URL、trusted proxy CIDR、forwarded host / proto検証 |
| Board remote write | GET / HEADのみ、origin / identity / token / rate limit |
| child process shell injection | argument array、Windows shim限定shell、bounded output、timeout |
| generated artifact secret exposure | SBOM、provenance、metrics、performance、DR catalogのsecret scan |
| canonical state改変 | state integrity、source commit / checksum binding、atomic write |

## Residual Risk

- npm registry advisory情報はnetworkとprovider可用性に依存する。
- local administrator、kernel compromise、credential manager自体の侵害はKairon単体では
  防止できない。
- quick tunnel、reverse proxy、GitHub、Discordのprovider側設定はoperator管理であり、
  Stable acceptanceで実環境証跡を取得する。
- known limitationへhigh / critical findingを移してStable gateを通過させない。

## Stable判定

offline policyが`PASS`でも、freshなnpm audit証跡がなければSecurity Baselineは
`SETUP_REQUIRED`となる。high / critical advisory、lockfile integrity failure、
state integrity error、secret exposureは`UNPASSED`である。
