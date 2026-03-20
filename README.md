# ccproxy

A smart Bun proxy that routes Anthropic API requests through your Claude Code subscription, with **server-side compaction** to prevent sessions from breaking at the OAuth 200K context limit.

> **Disclaimer**: This proxy approach is hacky and may violate Anthropic's terms of service for Claude Code. Use at your own risk. No guarantees are provided.

## Quick Start

```bash
# Prerequisites: Claude Code CLI authenticated (`claude /login`) and Bun installed
bun install && bun run index.ts
```

Proxy runs on `http://localhost:8082`. Use `http://localhost:8082/v1` as your base URL in Cursor.

**Windows**: Run `start-proxy.ps1` to start both the proxy and Cloudflare tunnel.
**macOS/Linux**: Run `./start-proxy.sh` for both in one terminal.

### HTTPS via Cloudflare Tunnel

Cursor calls the API via their backend servers, so you need an HTTPS endpoint:

```bash
# Quick tunnel (URL changes on restart)
cloudflared tunnel --url http://localhost:8082

# Or configure a named tunnel (permanent URL) — see cloudflared-config.yml
cloudflared tunnel --config ./cloudflared-config.yml run
```

> **Security**: Set `PROXY_SECRET_KEY` in `.env` to protect your proxy — see [Security](#security) below.

## How It Works

```
Cursor (OpenAI format)
  → CCProxy translates to Anthropic format
  → Injects compaction edit (Opus 4.6, trigger at 150K tokens)
  → Routes via Claude Code OAuth (subscription)
      ↓ fallback on 429/403
    Direct Anthropic API (paid)
  → Translates response back to OpenAI format
  → Streams to Cursor
```

### Server-Side Compaction

Cursor shows "97K / 872K" for Opus 4.6, but OAuth caps at **200K tokens**. Cursor never triggers summarization (thinks it has 672K headroom). At 200K, the API returns 400 and the session breaks.

**The fix**: The proxy injects Anthropic's `compact_20260112` compaction edit into every Opus 4.6 request. When input tokens exceed 150K, the API automatically generates a conversation summary and continues the response. Sessions survive indefinitely.

See [docs/COMPACTION.md](docs/COMPACTION.md) for the full deep-dive.

### Extended Thinking

- Opus 4.6: adaptive thinking (`{ type: "adaptive" }`) — Claude dynamically decides thinking depth
- Older models: explicit budget (`{ type: "enabled", budget_tokens: N }`)
- Incompatible parameters auto-removed, streaming forced when needed, `max_tokens` auto-bumped

### OAuth Token Management

- Auto-refresh with persistence to `~/.claude/.credentials.json`
- File locking prevents races with Claude CLI running in parallel
- In-process mutex prevents concurrent refresh from parallel requests

## Security

The proxy has two security layers, configured via `.env`:

### Proxy Secret Key (recommended)

Set `PROXY_SECRET_KEY` to a long random string. When set, **every** `/v1/*` request must include it as a Bearer token — requests without it (or with a wrong key) get `401 Unauthorized`.

```bash
# Generate a key
bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Add to .env
PROXY_SECRET_KEY=your_generated_key_here
```

**In Cursor**: Set the key as the **API Key** field in your Override settings (Cursor sends it as `Authorization: Bearer <key>` automatically).

> **⚠️ If `PROXY_SECRET_KEY` is not set, the proxy is open to anyone who knows the URL!**

### IP Whitelist (optional, can be disabled)

`ALLOWED_IPS` restricts which IPs can access `/v1/*` endpoints through the Cloudflare tunnel. This check only applies when Cloudflare headers (`CF-Connecting-IP`) are present — local requests are always allowed.

```bash
# Restrict to specific IPs (comma-separated)
ALLOWED_IPS=52.44.113.131,184.73.225.134

# Disable IP whitelist (comment out or set to "*")
# ALLOWED_IPS=*
```

**Why you might want to disable it**: Cursor routes requests through their own backend servers (AWS). These server IPs change over time. If a new Cursor server IP is not in your whitelist, you'll see `"Unauthorized: IP x.x.x.x not in whitelist"` errors in Cursor. With `PROXY_SECRET_KEY` active, the IP whitelist is redundant and can be safely disabled.

**If you see `IP not in whitelist` errors**: Either add the blocked IP to `ALLOWED_IPS`, or disable the whitelist entirely by commenting out `ALLOWED_IPS` (and make sure `PROXY_SECRET_KEY` is set).

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8082` | Proxy port |
| `PROXY_SECRET_KEY` | - | **Recommended.** Secret key for proxy access. Set in Cursor as API Key. |
| `ALLOWED_IPS` | disabled | Comma-separated IP whitelist. Set to `*` or leave unset to disable. |
| `ANTHROPIC_API_KEY` | - | Fallback API key when Claude Code limits hit |
| `COMPACTION_ENABLED` | `true` | Server-side compaction for Opus 4.6+ |
| `COMPACTION_TRIGGER_TOKENS` | `150000` | Token threshold for compaction (min: 50000) |
| `OPENAI_API_KEY` | - | For non-Claude model passthrough |
| `OPENAI_BASE_URL` | `https://api.openai.com` | OpenAI/OpenRouter base URL |
| `VERBOSE_LOGGING` | `false` | Detailed file logging to `api.log` |

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the complete reference.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/messages` | Anthropic Messages API (native format) |
| `POST /v1/chat/completions` | OpenAI Chat Completions API (Cursor's primary path) |
| `GET /v1/models` | Available models list |
| `GET /health` | Health check |

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System overview, request flow, module map |
| [docs/COMPACTION.md](docs/COMPACTION.md) | Compaction strategy, API mechanics, design decisions |
| [docs/TESTING.md](docs/TESTING.md) | Test results, methodology, errors encountered |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | All env vars, config options, deployment |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | Change history from v1 → v2 baseline → current |
| [docs/ISSUES.md](docs/ISSUES.md) | All issues encountered, root causes, fixes |
| [docs/HYPOTHESIS.md](docs/HYPOTHESIS.md) | Hypotheses tested, strategies evaluated, decisions made |

## Known Limitations

- **OAuth 200K hard cap**: If a single request has > 200K input tokens before the API can compact, it will still fail. Compaction only helps conversations that *grow* past the limit over multiple turns.
- **Re-compaction on every qualifying request**: OpenAI format can't represent `compaction` blocks — they are stripped from responses. Cursor never preserves them. Every request over 150K tokens triggers fresh compaction (~3500 tokens overhead). This is wasteful but prevents session death.
- **Compaction summary quality**: After compaction, response quality depends on the summary preserving the user's question. Custom instructions are injected to mitigate this, but very complex multi-part questions may still be imperfectly summarized.
- **Opus 4.6 only**: Compaction is only supported on `claude-opus-4-6`. Older models (4.5) don't have the compaction API and aren't affected by the 200K mismatch (their native window matches the OAuth cap).
- **Cloudflare tunnel idle timeout**: Proxy sends SSE keepalives every 25s to mitigate, but very long thinking periods may still drop.
- **Tool call edge cases**: XML tool call translation handles common patterns but complex schemas may not translate perfectly.
- **1M context not available**: Cursor sends `context-1m-2025-08-07` beta header but this requires API Usage Tier 4 (not available on OAuth). The proxy strips this header automatically.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `Unauthorized` (401) | `PROXY_SECRET_KEY` is set but Cursor isn't sending the key. Set the key as **API Key** in Cursor's Override settings. |
| `IP x.x.x.x not in whitelist` (403) | A new Cursor backend IP isn't in `ALLOWED_IPS`. Either add it, or disable the whitelist by commenting out `ALLOWED_IPS` (recommended if `PROXY_SECRET_KEY` is set). |
| No credentials found | Run `claude /login` |
| Token invalid / expired | Run `claude /login` again |
| `invalid_grant` on refresh | Another process rotated the token. Run `claude /login`. |
| `prompt is too long` (400) | Compaction should prevent this. Check that `COMPACTION_ENABLED` is not `false`. |
| `long context beta not available` (400) | Beta header filtering should prevent this. Check `BLOCKED_BETAS` in config.ts. |
| Empty response after compaction | Custom compaction instructions should preserve the user's question. Check proxy logs for compaction delta content. |
| Tunnel drops during responses | Cloudflare idle timeout. Check tunnel config keepalive settings. |
| Cursor not using the proxy | Restart Cursor after changing the base URL; toggle the setting off and on. |
| Non-Claude models fail | Set `OPENAI_API_KEY` for passthrough. |

## License

MIT
