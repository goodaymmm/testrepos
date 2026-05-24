# Kairon Technology Stack v0

## 目的

この文書は Kairon MVP の実装技術を固定する。
選定基準は、Windows ローカル常駐、公式 CLI process 制御、file-based state、Discord Gateway、レビュー必須運用との相性である。

## Runtime

| 項目 | 採用 |
| --- | --- |
| Language | TypeScript |
| Runtime | Node.js |
| Minimum Node | 22.x |
| Recommended Node | 24.x LTS |
| Package manager | npm |
| Module format | ESM |

現在のローカル環境は Node `v22.21.1`、npm `10.9.4`。
Node 22 は Maintenance LTS、Node 24 は Active LTS として扱えるため、MVP は Node 22+ 対応で開始する。

Node 24 LTS への移行は、実装が安定した段階で行う。

## Core Libraries

| 用途 | 採用 | 理由 |
| --- | --- | --- |
| CLI | `commander` | Node CLI の定番で TypeScript 型もある |
| Schema validation | `zod` | TypeScript-first で config / event schema と相性がよい |
| Test runner | `vitest` | TypeScript test を軽く始められる |
| TS execution | `tsx` | dev 実行で build step を省ける |
| TypeScript compiler | `typescript` | typecheck / build |
| Discord | `discord.js` | Gateway / interaction / slash command を扱いやすい |

## Standard Library First

次は外部 dependency を増やさず Node 標準で始める。

- filesystem: `node:fs/promises`
- path: `node:path`
- process: `node:child_process`
- crypto hash / nonce: `node:crypto`
- timers: `node:timers/promises`

Git 操作は初期実装では `child_process` 経由で `git` command を呼ぶ。
`simple-git` は導入しない。
Git transaction と event 記録を Kairon 側で明示したいためである。

## Optional / Deferred Libraries

| 用途 | 方針 |
| --- | --- |
| pty | `node-pty` は deferred。Windows native build の不確実性があるため、Session Host interface を先に固定する |
| SQLite | deferred。MVP は file-based state |
| LangGraph | deferred。Control Protocol 設計は残し、MVP は skeleton |
| LangChain / RAG | deferred。placeholder interface のみ |
| Board UI | deferred。MVP では Discord / file projection |

## package.json scripts

```json
{
  "scripts": {
    "kairon": "tsx src/cli/main.ts",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

## Initial Dependencies

```json
{
  "dependencies": {
    "commander": "^14.0.0",
    "discord.js": "^14.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  }
}
```

Version range は scaffold 時点で `npm install` により lock file へ固定する。
Dependency 更新は別 task とし、機能実装と混ぜない。

## Discord Notes

MVP は Discord Gateway mode を採用する。
Slash command、button、modal submit は interaction として受け、Kairon internal command に正規化する。

Message content intent は使わない。
Kairon は通常 chat message を読む必要がない。

## Review And Quality

Kairon 本体の code-producing change は次を通す。

- `npm run typecheck`
- `npm test`
- Codex review
- 可能なら Claude review

Claude Opus が実装した場合は Codex review via `codex-plugin-cc` を優先する。
Gemini は Discord / Google ecosystem / multimodal / large context の追加 review に使う。

## References

- Node.js Releases: https://nodejs.org/en/about/releases/
- Node.js Release Working Group: https://github.com/nodejs/Release
- Commander: https://www.npmjs.com/package/commander
- Zod: https://zod.dev/
- Vitest: https://vitest.dev/guide/
- tsx: https://tsx.is/
- Discord Interactions: https://docs.discord.com/developers/platform/interactions
