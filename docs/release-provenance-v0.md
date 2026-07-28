# Release Provenance And SBOM v0

<!-- kairon:release-provenance-sbom -->
Kairon `0.3.0`以降のStable Local Release artifactに対し、依存関係、build環境、source commit、
package、checksum manifestを機械検証可能な形で結び付ける仕様です。

## 用語と保証範囲

- SBOMはCycloneDX JSON 1.6形式を使う。
- provenanceはKairon独自の`kairon_local_build_provenance` schema `0.1`を使う。
- provenanceはlocal buildの再検証情報であり、SLSA認証や署名済みattestationを称しない。
- package、checksum manifest、SBOM、provenance、release manifestは同じversionと
  source commitへbindする。
- public npm registryへのpublish、remote signing、transparency log登録は行わない。

## Generator選定

CycloneDXの外部generator追加も候補になりますが、T178では採用しません。
`package-lock.json` lockfileVersion 3をstructured inputとしてKairon自身が決定的JSONを
生成します。

- 新しいruntime dependency、transitive dependency、license review対象を増やさない。
- Windows Node.js 22で既存CLIと同じ実行条件を維持する。
- package-lock SHA-256と正規化component一覧を同時に検証できる。
- 同じname/versionのnested dependencyはpurl単位で統合する。

この実装自身のlicenseはrepositoryの`UNLICENSED`方針に従います。第三者generatorの
codeは取り込まず、追加のgenerator licenseは発生しません。

## 生成手順

clean tracked worktreeとbuild済みCLIを使用します。

```powershell
npm run release:pack

$artifact = ".\release-artifacts\0.3.0"
$package = "$artifact\kairon-0.3.0.tgz"
$checksum = "$package.sha256.json"
$sbom = "$artifact\sbom.cdx.json"
$provenance = "$artifact\provenance.json"

kairon release sbom `
  --manifest $checksum `
  --output $sbom

kairon release provenance `
  --package $package `
  --manifest $checksum `
  --sbom $sbom `
  --output $provenance

kairon release manifest `
  --package $package `
  --manifest $checksum `
  --sbom $sbom `
  --provenance $provenance `
  --output "$artifact\release-manifest.json"

kairon release verify $package `
  --manifest $checksum `
  --release-manifest "$artifact\release-manifest.json" `
  --verification-context source
```

## Verification context

| context | 用途 | source tree | artifact binding |
| --- | --- | --- | --- |
| `source` | pack、manifest生成、GitHub publish | current clean commitと一致必須 | 必須 |
| `consumer` | install、update、download cache | consumer Gitとは比較しない | 必須 |

既定は`source`です。`consumer`は検証省略ではなく、package、checksum manifest、
inventory、SBOM、provenance、release manifestを相互検証し、manifestとprovenanceの
source SHA一致を`artifact_source_binding`として確認します。`source_tree_check`は
consumer hostのGit treeを選択しなかったことを明示します。

## SBOM contract

SBOMは次を保持します。

- application component: `kairon`とpackage version
- dependency component: name、version、npm purl、required/optional
- dependency property: direct/transitive、runtime/development、integrity、license
- `package-lock.json`全体のSHA-256
- checksum manifestから正規化したpackage inventoryのSHA-256

componentは`bom-ref`順にsortし、同一purlを重複させません。同一name/versionが複数階層に
存在する場合、direct、runtime、requiredを優先して1 componentへ統合します。

## Provenance contract

provenanceは次だけを保持します。

- clean Git source commitと`dirty=false`
- build command ID `npm_run_release_pack`
- Node.js versionとnpm version
- package、checksum manifest、SBOMのbasename、size、SHA-256
- package-lock SHA-256とpackage inventory SHA-256
- package versionと生成日時

provenanceにOS account名、hostname、絶対path、Git remote credential、environment variable、
token、password、authorization headerを保存しません。

## Release manifest binding

新形式の`release-manifest.json`はoptionalな`attestations`を持ちます。

- `attestations.sbom`: filename、CycloneDX format/version、size、SHA-256
- `attestations.provenance`: filename、Kairon format/version、size、SHA-256

片方だけを指定したmanifest生成は拒否します。`attestations`がない旧schema `0.1`
manifestは後方互換として従来の検証を継続します。

attestation付きmanifestをGitHub Releaseへ公開する場合は、package、checksum manifest、
release manifest、SBOM、provenanceの5 assetを同じreleaseへ配置します。Stable promotion planは
この5 assetのremote asset ID、size、SHA-256とSBOM / provenance digestを固定し、昇格時に
追加・欠落・差替えがあればGitHub write前に拒否します。

## Verifyで拒否する差異

`kairon release verify --release-manifest`はcontextに関係なく次を拒否します。

- packageまたはchecksum manifestのsize / SHA-256 / filename差異
- package-lock SHA-256またはdependency component差異
- package inventory SHA-256差異
- SBOMまたはprovenanceの置換、改変、version差異
- release manifestとprovenanceのsource commit差異
- provenance内のabsolute path、account、host、credential-like field

`source` contextでは、上記に加えてmanifest / provenance source commitと現在の
clean tracked sourceの差異を拒否します。

artifactを再生成した場合は、SBOM、provenance、release manifestも同じ順で再生成します。
個別fileのdigestだけを手作業で書き換えません。
