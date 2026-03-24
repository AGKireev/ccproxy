# CCProxy — Configuration Reference

## Environment Variables

All configuration is via environment variables. Bun loads `.env` automatically (no dotenv needed).

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8082` | HTTP server port |
| `CLAUDE_CODE_FIRST` | `true` | Try Claude Code OAuth before fallback. Set `false` for direct API only. |
| `ANTHROPIC_API_KEY` | - | Fallback API key (used when Claude Code is rate-limited or unavailable) |

### Compaction (Server-Side Context Management)

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPACTION_ENABLED` | `true` | Enable server-side compaction for Opus 4.6+ models. Set `false` to disable. |
| `COMPACTION_TRIGGER_TOKENS` | `150000` | Token threshold to trigger compaction. Minimum: 50000 (API enforced). |

When enabled, the proxy injects a `compact_20260112` edit that triggers Anthropic's server-side summarization when input tokens exceed the trigger threshold. This can help manage very long conversations proactively.

### OpenAI/OpenRouter Passthrough

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | - | API key for non-Claude models. If unset, non-Claude requests fail. |
| `OPENAI_BASE_URL` | `https://api.openai.com` | Base URL. Set to `https://openrouter.ai/api` for OpenRouter. |
| `OPENROUTER_REFERER` | `https://github.com/ccproxy` | HTTP-Referer header for OpenRouter |
| `OPENROUTER_TITLE` | `CCProxy` | X-Title header for OpenRouter |

### Security

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_SECRET_KEY` | - | **Recommended.** When set, all `/v1/*` requests must include this value as a Bearer token. Cursor sends its "API Key" field as `Authorization: Bearer <key>`, so just paste the key into Cursor's Override settings. If not set, the proxy is open to anyone who knows the URL. |
| `ALLOWED_IPS` | disabled | Comma-separated IP whitelist for tunnel requests. Only enforced when Cloudflare headers (`CF-Connecting-IP`) are present — local requests always pass. If not set or set to `*`, the whitelist is disabled entirely. |

#### Proxy Secret Key

This is the primary security layer. Generate a key and add it to `.env`:

```bash
# Generate a 64-character hex key
bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```env
PROXY_SECRET_KEY=your_generated_key_here
```

**Cursor setup**: Go to Settings → Models → Override OpenAI Base URL, and paste the key into the **API Key** field. Cursor sends this as `Authorization: Bearer <key>` with every request.

Without a valid key, the proxy returns `401 Unauthorized` (generic error — reveals nothing about the proxy).

#### IP Whitelist

An optional second security layer. When `ALLOWED_IPS` is set, only requests from those IPs are allowed through the Cloudflare tunnel.

```env
# Enable with specific IPs
ALLOWED_IPS=52.44.113.131,184.73.225.134

# Disable (any of these):
# ALLOWED_IPS=*
# or simply comment it out / don't set it
```

**Why you might disable it**: Cursor doesn't call your proxy directly — it routes requests through its own AWS backend servers. These server IPs change over time as Cursor scales. When a new server IP appears, it won't be in your whitelist, and you'll see:

```
Provider returned error: {"error":{"type":"authentication_error","message":"Unauthorized: IP 52.59.29.232 not in whitelist"}}
```

**Fix**: Either add the new IP to `ALLOWED_IPS`, or disable the whitelist by commenting it out. With `PROXY_SECRET_KEY` active, the IP whitelist is redundant — the secret key already prevents unauthorized access.

**Security layers summary**:

| Layer | Protects against | Recommended |
|-------|-----------------|-------------|
| `PROXY_SECRET_KEY` | Anyone without the key | ✅ Yes — always set this |
| `ALLOWED_IPS` | Requests from non-Cursor IPs | Optional — can disable if secret key is set |
| Cloudflare tunnel | Direct access to server ports | ✅ Yes — no open ports |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `VERBOSE_LOGGING` | `false` | Enable detailed file logging to `api.log`. Contains full request/response bodies. |

### Advanced

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_CODE_EXTRA_INSTRUCTION` | `"CRITICAL: You are running headless as a proxy..."` | Extra system prompt appended after the required Claude Code prefix. Set to empty string to disable. |

> **Note**: 1M context is now GA for Opus/Sonnet 4.6 (March 2026). No beta header or special config is needed. The `context-1m-2025-08-07` header is no longer blocked.

---

## Constants (Hardcoded in `config.ts`)

These are not configurable via environment but are important to know:

| Constant | Value | Purpose |
|----------|-------|---------|
| `CLAUDE_CREDENTIALS_PATH` | `~/.claude/.credentials.json` | OAuth credentials file path |
| `CLAUDE_CLIENT_ID` | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | OAuth client ID for token refresh |
| `ANTHROPIC_TOKEN_URL` | `https://platform.claude.com/v1/oauth/token` | Token refresh endpoint |
| `ANTHROPIC_API_URL` | `https://api.anthropic.com` | Anthropic API base URL |
| `ANTHROPIC_BETA_OAUTH` | `oauth-2025-04-20` | Required beta for OAuth |
| `ANTHROPIC_BETA_CLAUDE_CODE` | `claude-code-20250219` | Required beta for Claude Code |
| `ANTHROPIC_BETA_COMPACTION` | `compact-2026-01-12` | Compaction beta header |
| `CLAUDE_CODE_SYSTEM_PROMPT` | `"You are Claude Code..."` | Required system prompt prefix for OAuth |
| `BLOCKED_BETAS` | `Set([])` (empty) | Beta headers stripped from Cursor's requests. Currently empty — all headers pass through. |

---

## Deployment Configurations

### Port

The proxy defaults to port **8082**, matching ccproxy v1. This allows easy switching between v1 and v2 without changing Cloudflare tunnel or Cursor settings.

Files that reference the port:
- `.env` — `PORT=8082`
- `.env.example` — `# PORT=8082`
- `src/config.ts` — `process.env.PORT || "8082"`
- `cloudflared-config.yml` — `service: http://localhost:8082`
- `start-proxy.ps1` — quick tunnel fallback URL
- `start-proxy.sh` — `PORT="${PORT:-8082}"`

### Cloudflare Tunnel

The `cloudflared-config.yml` file configures a named tunnel with:
- Hostname: your custom domain
- 120s keepalive timeout (for long LLM streaming)
- Chunked encoding enabled (required for SSE)

```yaml
ingress:
  - hostname: your-subdomain.yourdomain.com
    service: http://localhost:8082
    originRequest:
      keepAliveTimeout: 120s
      keepAliveConnections: 100
      tcpKeepAlive: 30s
      connectTimeout: 30s
      disableChunkedEncoding: false
  - service: http_status:404
```

### Start Scripts

- **`start-proxy.ps1`** (Windows): Starts proxy in a new cmd window + Cloudflare tunnel
- **`start-proxy.sh`** (macOS/Linux): Starts both in one terminal with `[server]`/`[tunnel]` prefixes

Both scripts are gitignored (may contain local paths).

---

## Beta Headers

The proxy manages several beta header strings that get merged before sending to Anthropic:

### Always Included (Claude Code OAuth)
```
claude-code-20250219    # Required for Claude Code identification
oauth-2025-04-20        # Required for OAuth authentication
```

### Conditionally Included
```
compact-2026-01-12              # When compaction is injected (Opus 4.6+)
interleaved-thinking-2025-05-14 # Fallback if Cursor doesn't send beta headers
```

### From Cursor (Passthrough)
Cursor typically sends:
```
context-management-2025-06-27        # Context editing (clear_tool_uses, clear_thinking)
fine-grained-tool-streaming-2025-07-14  # Granular tool call streaming
interleaved-thinking-2025-05-14      # Thinking blocks (deprecated on 4.6, needed for 4.5)
effort-2025-11-24                    # Effort control
max-effort-2026-01-24                # Max effort variant
adaptive-thinking-2026-01-28         # Adaptive thinking for Opus 4.6
```

### Previously Blocked (No Longer Blocked)
```
context-1m-2025-08-07               # Was blocked — required API Usage Tier 4
                                     # Now: 1M context is GA for 4.6 models (March 2026).
                                     # Header is harmless and passes through.
```

The `mergeBetaHeaders()` function in `config.ts` uses a `Set` to combine all headers, preventing duplicates. The `BLOCKED_BETAS` set filters out headers incompatible with OAuth before merging.

---

## Model Name Mapping

Cursor sends model names in its own format. The proxy normalizes them:

| Cursor Format | Anthropic Format | Minor Version | Compaction? |
|--------------|------------------|---------------|-------------|
| `claude-4.6-opus-high` | `claude-opus-4-6` | 6 | ✅ Yes |
| `claude-4.6-opus-max-thinking` | `claude-opus-4-6` | 6 | ✅ Yes |
| `claude-4.5-opus-high` | `claude-opus-4-5` | 5 | ❌ No |
| `claude-4.5-sonnet-high` | `claude-sonnet-4-5` | 5 | ❌ No |
| `claude-4.5-haiku` | `claude-haiku-4-5` | 5 | ❌ No |
| `claude-opus-4-6` (already Anthropic) | `claude-opus-4-6` | 6 | ✅ Yes |

The `-thinking` suffix is stripped. The reasoning budget (`high`, `medium`, `low`, `max`) is extracted and used to configure the `thinking` parameter.

### Extended Thinking Configuration

| Model Version | Thinking Config | Notes |
|--------------|----------------|-------|
| Opus 4.6+ | `{ type: "adaptive" }` | Claude dynamically decides thinking depth |
| 4.5 and below | `{ type: "enabled", budget_tokens: N }` | Explicit budget required |

Budget mapping for 4.5:
- `max` → `max_tokens - 1`
- `high` → 50000
- `medium` → 20000
- `low` → 5000

When thinking is enabled:
- `temperature`, `top_k`, `top_p` are removed (Anthropic constraint)
- `tool_choice` is forced to `auto` if incompatible
- `stream` is forced `true` if `max_tokens > 21,333`
- `max_tokens` is bumped to 128K (Opus 4.6) or 64K (4.5)
