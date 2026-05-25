# Kairon Subscription Compliance v0

## 目的

Kairon は Codex CLI、Claude Code、AntigravityCLI を subscription usage の範囲で使うことを想定する。
この設計は API key 課金を避けるためではなく、個人の開発環境で公式 CLI を使い、使用量制限に従って Agent を運用するためのものである。

この文書は法律判断ではなく、Kairon の設計上の compliance guardrail である。

## 基本方針

- 公式 CLI / 公式認証フローだけを使う。
- OAuth token、session cookie、内部 endpoint を抽出して独自 client から叩かない。
- rate limit、quota、capacity 制限、protective measure を回避しない。
- 複数 account による quota sharding をしない。
- account credential を共有しない。
- provider が API key / paid usage を要求する flow へ自動的に切り替えない。
- CLI が usage limit に達したら該当 Agent を pause / defer する。
- subscription usage と API key usage を run log に明確に分ける。

## Terminal / Process Boundary

Kairon は、可視 Terminal window が開いているかどうかを compliance boundary として扱わない。
重要なのは、公式 CLI を公式認証状態で起動し、provider の usage limit、quota、permission prompt、protective measure を回避しないことである。

Kairon が許可する起動方式。

- user が foreground terminal で起動する。
- Kairon Agent Runner が公式 CLI を background child process として起動する。
- 同日 session 維持のために persistent terminal / pty を使う。

Kairon が禁止する方式。

- OAuth token、session cookie、auth file を抽出して独自 HTTP client から内部 endpoint を叩く。
- 公式 CLI の背後 service に third-party client として直接アクセスする。
- quota や rate limit を回避するために account、credential、IP、client identity を切り替える。

## Provider Assessment

| Provider | Subscription CLI 利用 | Kairon での扱い | 主なリスク |
| --- | --- | --- | --- |
| Codex | ChatGPT plan で Codex CLI 利用が公式に案内されている | 公式 `codex` CLI / `codex exec` のみ使用 | rate limit 回避、Output の programmatic extraction と見なされる使い方 |
| Claude Code | Pro / Max で Claude Code 利用が公式に案内されている | 公式 `claude` CLI のみ使用 | consumer terms の automated / non-human access 条項との境界 |
| AntigravityCLI | Google account / Google AI Pro / Ultra で AntigravityCLI / Gemini 系 CLI 利用が公式に案内されている | 公式 `agy` CLI のみ使用 | third-party software で裏サービスへ直接アクセスすると違反リスク |
| Discord | Bot / interaction は Developer Terms と rate limit に従う | approval notification のみ使用 | rate limit 超過、bot token 漏洩 |

## Codex Guardrail

- ChatGPT account で公式 Codex CLI に login する。
- `codex exec` は provider が提供する non-interactive mode として扱う。
- `--sandbox workspace-write` などの明示的 sandbox を使う。
- `danger-full-access` は isolated runner 以外で使わない。
- usage limit に近づいたら Codex job を defer する。
- OpenAI API key が設定されている環境では、subscription usage と混ざらないよう明示的に検出する。

## Claude Code Guardrail

- Claude Pro / Max account で公式 Claude Code に login する。
- `ANTHROPIC_API_KEY` が設定されている場合、subscription usage ではなく API usage になるため警告する。
- Claude Code を完全無人 bot として長時間連続実行する運用は、consumer terms の automated / non-human access 条項との境界が残る。
- Kairon MVP では Claude job に usage cap、cooldown、human review boundary を設定する。
- 規約上の明確性が必要な場合、Claude Code は user-approved run に限定するか、Anthropic API / Team / Enterprise の許可された automation route を検討する。

## AntigravityCLI Guardrail

- 公式 `agy` CLI と公式 authentication method だけを使う。
- Google account / Google AI Pro / Ultra の quota を尊重する。
- headless mode は公式 CLI の既存 credential または公式 API key / Vertex AI flow に限定する。
- Gemini Code Assist service などの裏側 service に、OAuth token を流用した third-party client で直接アクセスしない。
- quota に達したら Antigravity/Gemini job を defer する。

## Discord Guardrail

- Discord は LLM usage ではなく approval notification channel として扱う。
- Discord API は基本的に rate limit が主な制約であり、Kairon は low-volume approval message のみ送る。
- Discord Developer Terms と API rate limit に従う。
- Bot token は repository に保存しない。

## Runtime Checks

```json
{
  "subscription_compliance": {
    "official_cli_only": true,
    "disallow_token_extraction": true,
    "disallow_quota_sharding": true,
    "pause_on_usage_limit": true,
    "detect_api_keys": [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY"
    ],
    "require_user_review_for": [
      "provider_terms_change",
      "new_auth_method",
      "unofficial_client",
      "headless_claude_long_run"
    ]
  }
}
```

## Open Questions

- Claude Code subscription での long-running unattended orchestration が、どこまで明示許可された use に含まれるか。
- 各 provider の subscription terms が automation / agentic use に対して将来変更される可能性。
- 個人利用と商用利用の境界。商用プロジェクトへ接続する場合は Team / Business / Enterprise / API route の再検討が必要。
