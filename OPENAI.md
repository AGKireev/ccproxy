# OpenAI Codex Subscription Proxy — Setup Guide

CCProxy can route OpenAI model requests (GPT-5.4, GPT-4o, o3, etc.) through your **ChatGPT subscription** (Plus $20/mo or Pro $200/mo) instead of paying per-token API fees. This works the same way as the Claude Code proxy — your subscription gives you access to the models, and CCProxy acts as the bridge.

By default, the proxy uses **GPT-5.4 with maximum reasoning (`xhigh`)** — equivalent to "GPT-5.4 Extra High Thinking" in Cursor. This is the most powerful configuration available: deepest chain-of-thought reasoning with the full 1M token context window.

---

## Quick Start

### 1. Install OpenAI Codex CLI

```bash
npm install -g @openai/codex
```

### 2. Login with Your ChatGPT Account

```bash
codex login
```

This opens your browser → you sign in with your ChatGPT account (the one with Plus/Pro subscription) → tokens are saved to `~/.codex/auth.json` automatically.

### 3. Start CCProxy

No configuration needed — CCProxy **auto-detects** your Codex credentials.

```bash
bun run index.ts
```

You should see in the console:

```
✓ OpenAI Codex credentials found — GPT models will use your ChatGPT subscription
  OpenAI token expires in 55 minutes
  Account ID: your-account-id
```

### 4. Configure Cursor

In Cursor Settings → Models:
- **OpenAI API Base URL**: `http://localhost:8082/v1`
- **API Key**: your `PROXY_SECRET_KEY` value (if configured), or any dummy value like `sk-dummy`

Then select a GPT model from the model dropdown (e.g., `gpt-5.4`).

---

## Authentication

CCProxy reads OpenAI credentials from the **official Codex CLI** auth files. It checks these locations in order:

1. `~/.ccproxy/openai-credentials.json` (CCProxy's own, created after first token refresh)
2. `~/.codex/auth.json` (official OpenAI Codex CLI)
3. `~/.chatgpt-local/auth.json` (openai-oauth package)

### Primary Method: Codex CLI

```bash
# Install
npm install -g @openai/codex

# Login (opens browser)
codex login

# Verify
codex --version
```

After `codex login`, the tokens are saved and CCProxy picks them up automatically. Tokens auto-refresh — you typically only need to login once.

### Alternative: Manual Token Input

If you can't install the Codex CLI, or you already have tokens from another tool (OpenClaw, openai-oauth, etc.), POST them directly:

```bash
curl -X POST http://localhost:8082/auth/openai/manual \
  -H "Content-Type: application/json" \
  -d '{
    "access_token": "YOUR_ACCESS_TOKEN",
    "refresh_token": "YOUR_REFRESH_TOKEN",
    "account_id": "YOUR_ACCOUNT_ID"
  }'
```

Where to find these values:
- **From Codex CLI**: `~/.codex/auth.json` → `tokens.access_token`, `tokens.refresh_token`, `tokens.account_id`
- **From OpenClaw**: `~/.openclaw/agents/default/auth-profiles.json` → `access`, `refresh`, `accountId`

### Check Status

```
GET http://localhost:8082/auth/openai/status
```

Returns:
```json
{
  "authenticated": true,
  "account_id": "your-account-id",
  "expires_in_minutes": 55
}
```

---

## Available Models

| Model ID in Cursor | Reasoning Effort | Context Window | Description |
|---|---|---|---|
| `gpt-5.4` | **xhigh** (default) | 1M tokens | **Maximum reasoning — recommended** |
| `gpt-5.4-extra-high-thinking` | xhigh | 1M tokens | Explicit max reasoning (same as above) |
| `gpt-5.4-xhigh` | xhigh | 1M tokens | Explicit max reasoning (same as above) |
| `gpt-5.4-high` | high | 1M tokens | Strong reasoning, faster than xhigh |
| `gpt-5.4-medium` | medium | 1M tokens | Balanced speed/quality |
| `gpt-5.4-thinking` | xhigh | 1M tokens | Alias for max reasoning |
| `gpt-5.4-fast` | high | 1M tokens | 15% faster processing |
| `gpt-4o` | — | 128K tokens | General purpose |
| `gpt-4o-mini` | — | 128K tokens | Fast and cheap |
| `o3` | — | 200K tokens | Reasoning model |
| `o4-mini` | — | 200K tokens | Fast reasoning model |

**Default behavior**: When you select `gpt-5.4` without any suffix, the proxy automatically applies `xhigh` reasoning — the maximum thinking power. This is equivalent to "GPT-5.4 Extra High Thinking" in Cursor.

---

## Reasoning Effort Levels

GPT-5.4 supports configurable reasoning depth via the `reasoning.effort` parameter:

| Level | Speed | Cost | Best For |
|---|---|---|---|
| `none` | Fastest | Cheapest | Simple text generation, no chain-of-thought |
| `low` | Fast | Low | Quick syntax questions, simple transformations |
| `medium` | Moderate | Moderate | Standard coding tasks, implementations |
| `high` | Slower | Higher | Debugging, refactoring, architectural decisions |
| **`xhigh`** | **Slowest** | **3-5× high** | **Complex multi-file analysis, hardest problems** |

The proxy defaults to `xhigh` because IDE coding tasks benefit from maximum reasoning depth. You can override this per-request by using a model name suffix (e.g., `gpt-5.4-high`) or globally via `OPENAI_CODEX_REASONING_EFFORT` in `.env`.

---

## Configuration

All options go in your `.env` file:

```env
# No enable/disable needed — auto-detected from credentials!

# Try Codex subscription before falling back to OPENAI_API_KEY (default: true)
# OPENAI_CODEX_FIRST=true

# Default model (default: gpt-5.4)
# OPENAI_CODEX_DEFAULT_MODEL=gpt-5.4

# Default reasoning effort (default: xhigh — maximum thinking)
# Options: none, low, medium, high, xhigh
# OPENAI_CODEX_REASONING_EFFORT=xhigh

# Fallback: standard OpenAI API key (used when Codex subscription fails)
# OPENAI_API_KEY=sk-xxx

# Override the Codex client ID (advanced — don't change unless necessary)
# OPENAI_CODEX_CLIENT_ID=app_EMoamEEZ73f0CkXaXp7hrann
```

---

## How It Works

### Auto-Detection Logic

When you select a model in Cursor, CCProxy automatically routes it:

| Model selected | Route |
|---|---|
| Any Claude model (`claude-*`) | → Anthropic API via Claude Code OAuth subscription |
| Any GPT model (`gpt-*`, `o3`, `o4-*`) | → OpenAI Codex via ChatGPT OAuth subscription |
| Any other model | → OpenAI API key passthrough |

No manual switching needed — just select the model in Cursor and it works.

### Request Flow

```
Cursor                          CCProxy                         OpenAI
  |                               |                               |
  |  POST /v1/chat/completions   |                               |
  |  model: "gpt-5.4"            |                               |
  |  messages: [...]              |                               |
  |  stream: true                 |                               |
  |------------------------------>|                               |
  |                               |  1. Detect: GPT model         |
  |                               |  2. Check: ~/.codex/auth.json |
  |                               |  3. Convert Chat Completions  |
  |                               |     → Responses API format    |
  |                               |  4. Add reasoning:{effort:"xhigh"}
  |                               |                               |
  |                               |  POST chatgpt.com/backend-api |
  |                               |       /codex/responses        |
  |                               |  Auth: Bearer <OAuth token>   |
  |                               |  chatgpt-account-id: <id>     |
  |                               |------------------------------>|
  |                               |                               |
  |                               |    SSE: Responses API events  |
  |                               |<------------------------------|
  |                               |                               |
  |  SSE: Chat Completions events |  5. Transcode SSE format      |
  |<------------------------------|                               |
```

1. **Auto-detection**: CCProxy checks if `~/.codex/auth.json` exists. If yes → uses your ChatGPT subscription (no API credits). If no → falls back to `OPENAI_API_KEY`. If neither → returns a clear error explaining what's missing.

2. **Format conversion**: Cursor sends Chat Completions format (`messages` array). The Codex backend expects Responses API format (`input` array). The proxy converts transparently.

3. **Reasoning injection**: Adds `reasoning: { effort: "xhigh" }` to every request unless a specific effort level is in the model name.

4. **SSE transcoding**: The Codex backend streams Responses API events (`response.output_text.delta`, etc.). The proxy transcodes these to Chat Completions SSE events that Cursor understands.

5. **Fallback chain**: Codex subscription → API key → descriptive error. Each step is automatic.

---

## Troubleshooting

### "No OpenAI Codex credentials found"
Run `codex login` to authenticate, then restart CCProxy. Check that `~/.codex/auth.json` exists.

### 403 "unsupported_country_region_territory"
OpenAI restricts Codex access in some regions. Try using a VPN to a supported region when running `codex login`.

### 429 Rate Limited
Your ChatGPT subscription has usage limits. The proxy caches the rate limit expiry and falls back to `OPENAI_API_KEY` if configured. Wait for cooldown or upgrade to ChatGPT Pro ($200/mo) for higher limits.

### Empty or truncated responses
With `xhigh` reasoning, the model uses more tokens for internal thinking. The proxy allows up to 128K output tokens by default. If responses seem cut off, check your Cursor `max_tokens` setting.

### Token refresh fails
If `codex login` was done long ago, the refresh token may have expired. Run `codex login` again to get fresh tokens.

---

## Subscription vs API Key Comparison

| | Codex Subscription (via CCProxy) | Direct API Key |
|---|---|---|
| **Cost** | Flat: $20/mo (Plus) or $200/mo (Pro) | Per-token: ~$2.50/$15 per 1M tokens |
| **GPT-5.4 xhigh reasoning** | ✅ Included | ✅ Available (expensive) |
| **1M context window** | ✅ Full | ✅ Full |
| **Rate limits** | Subscription-tier limits | Pay-as-you-go |
| **Setup** | `codex login` + CCProxy | Paste API key in Cursor |
| **Works in Cursor** | ✅ Via CCProxy (full GPT-5.4 reasoning) | ❌ Limited (no GPT-5.4 reasoning) |

**Key advantage**: Cursor's built-in custom OpenAI API key does **not** support GPT-5.4 reasoning models. CCProxy bypasses this by routing through the Codex backend, giving you full GPT-5.4 Extra High Thinking through your existing subscription.
