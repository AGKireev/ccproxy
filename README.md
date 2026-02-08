# ccproxy

A local proxy that routes Anthropic API requests through your Claude Code subscription, with automatic fallback to direct API when limits are hit.

> **Disclaimer**: This proxy approach is hacky and may violate Anthropic's terms of service for Claude Code. Use at your own risk. No guarantees are provided.

![Demo](imgs/demo.png)

## Quick Start

```bash
# Prerequisites: Claude Code CLI authenticated (`claude /login`) and Bun installed
bun install && bun run index.ts
```

Proxy runs on `http://localhost:8082`. Use `http://localhost:8082/v1` as your base URL.

**Windows users**: Run `start-proxy.bat` to start both the proxy server and Cloudflare tunnel in one click.

**macOS/Linux users**: Run `./start-proxy.sh` to start both the proxy server and Cloudflare tunnel in one terminal.

### HTTPS via Cloudflare Tunnel

Cursor calls the API via their backend servers, so you need an HTTPS endpoint they can reach. Use Cloudflare Tunnel (or ngrok if you have it):

```bash
brew install cloudflared  # macOS
# Windows: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# Quick tunnel (URL changes on restart)
cloudflared tunnel --url http://localhost:8082

# Fixed tunnel (permanent URL) — recommended
cloudflared tunnel login
cloudflared tunnel create ccproxy
cloudflared tunnel route dns ccproxy ccproxy.yourdomain.com
```

Copy `cloudflared-config.example.yml` to `cloudflared-config.yml` and fill in your tunnel ID, credentials path, and hostname. Then run:

```bash
cloudflared tunnel --config ./cloudflared-config.yml run
```

Use `https://ccproxy.yourdomain.com/v1` as your base URL.

> **Security Warning**: Even though we whitelist Cursor's IP addresses, treat your tunnel URL like an API key. If it leaks, someone could use your Claude Code subscription and you could lose money on inference costs.

## Cursor Setup

In Cursor Settings, set the **Override OpenAI Base URL** to your Cloudflare tunnel URL (e.g., `https://ccproxy.yourdomain.com/v1`). Cursor will call our OpenAI-compatible endpoint, which translates requests to Claude.

> **Note**: The base URL override in Cursor can be finicky. If it's not working, try restarting Cursor or toggling the setting off and on.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8082` | Proxy port |
| `ANTHROPIC_API_KEY` | - | Fallback API key when Claude Code limits hit; also needed for context summarization |
| `CLAUDE_CODE_FIRST` | `true` | Set `false` to use direct API only |
| `CLAUDE_CODE_EXTRA_INSTRUCTION` | *(see below)* | Extra system prompt appended after the required Claude Code prefix |
| `OPENAI_API_KEY` | - | OpenAI/OpenRouter API key for non-Claude model passthrough |
| `OPENAI_BASE_URL` | `https://api.openai.com` | OpenAI-compatible base URL (set to `https://openrouter.ai/api` for OpenRouter) |
| `ALLOWED_IPS` | Cursor backend IPs | Comma-separated IP whitelist; only enforced for tunnel requests |
| `CONTEXT_STRATEGY` | `summarize` | Context management: `summarize`, `trim`, or `none` |
| `CONTEXT_SUMMARIZATION_MODEL` | `claude-opus-4-5` | Model used for summarization |
| `CONTEXT_MAX_TOKENS` | `200000` | Token threshold to trigger context management |
| `CONTEXT_TARGET_TOKENS` | `180000` | Target token count after summarization |
| `THINKING_BUDGET_HIGH` | `max` | Thinking budget for "high" — `max` = max_tokens - 1 |
| `THINKING_BUDGET_MEDIUM` | `20000` | Thinking budget for "medium" |
| `THINKING_BUDGET_LOW` | `5000` | Thinking budget for "low" |
| `VERBOSE_LOGGING` | `false` | Enable detailed file logging to `api.log` |

See `.env.example` for the full list with descriptions.

## How It Works

```
Cursor → ccproxy (OpenAI format) → translate to Anthropic format
                                  → count tokens (📊)
                                  → summarize if over 200K (🔄)
                                  → enable extended thinking if requested
                                  → Claude Code OAuth (subscription)
                                        ↓ fallback (429/403)
                                    Anthropic API (direct, paid)
```

### Context Management

When a request exceeds the 200K token limit, the proxy automatically manages context:

- **📊 Token counting** — Every request is measured with accurate per-message token estimation (differentiated ratios for prose, JSON, tool schemas)
- **🔄 Summarization** — Selects the oldest middle messages (protecting first 3 + last 10), calls Claude to summarize them, and replaces them with a compact summary. Iterates up to 2 times if needed.
- **✂️ Trim fallback** — If summarization fails or isn't configured, falls back to dropping old messages.

### Extended Thinking

The proxy supports Anthropic's extended thinking with full best-practice compliance:

- Model names like `claude-4.5-opus-high-thinking` are normalized and converted to the proper `thinking: { type: "enabled", budget_tokens: N }` API format
- `max_tokens` is automatically bumped to 64K (the model maximum) when thinking is enabled
- Incompatible parameters (`temperature`, `top_k`, `top_p`) are removed automatically
- `tool_choice` is forced to `auto` if set to an incompatible value
- Streaming is forced on when required (`max_tokens > 21,333`)
- Interleaved thinking is enabled via the `interleaved-thinking-2025-05-14` beta header, allowing Claude to reason between tool calls

### OAuth Token Management

- Tokens are refreshed automatically and persisted back to `~/.claude/.credentials.json`
- File locking (`.credentials.json.lock`) prevents race conditions with Claude CLI running in parallel
- In-process mutex prevents concurrent refresh from parallel HTTP requests
- Stale lock detection (>30s) with automatic cleanup

## Analytics

Track your usage and estimated savings with the built-in analytics:

```bash
# Get usage for the last 24 hours (default)
curl http://localhost:8082/analytics

# Get usage for different periods
curl http://localhost:8082/analytics?period=hour
curl http://localhost:8082/analytics?period=week
curl http://localhost:8082/analytics?period=month
curl http://localhost:8082/analytics?period=all
```

Example response:

```json
{
  "period": "day",
  "totalRequests": 129,
  "claudeCodeRequests": 60,
  "apiKeyRequests": 69,
  "errorRequests": 0,
  "totalInputTokens": 163,
  "totalOutputTokens": 47,
  "estimatedApiKeyCost": 0,
  "estimatedSavings": 0.001194,
  "estimatedApiKeyCostFormatted": "$0.0000¢",
  "estimatedSavingsFormatted": "$0.1194¢",
  "note": "Costs are estimates. Actual costs may vary due to prompt caching."
}
```

- **claudeCodeRequests** - Requests served via your Claude Code subscription (free)
- **apiKeyRequests** - Requests that fell back to your API key (paid)
- **estimatedSavings** - What you would have paid if all Claude Code requests went through the API

You can also view recent individual requests:

```bash
curl http://localhost:8082/analytics/requests?limit=10
```

## API Endpoints

| Endpoint | Description |
| --- | --- |
| `/v1/messages` | Anthropic Messages API |
| `/v1/chat/completions` | OpenAI Chat Completions API |
| `/analytics` | Usage stats (`?period=hour\|day\|week\|month\|all`) |
| `/analytics/requests` | Recent individual requests (`?limit=100`) |
| `/analytics/reset` | Reset analytics (POST) |
| `/budget` | GET/POST budget settings |
| `/health` | Health check |

## Known Limitations

- **Tool call translation edge cases** - OpenAI-format tool calls are translated to Claude's native format. Complex or deeply nested tool schemas may not translate perfectly.
- **Cloudflare tunnel idle timeout** - Cloudflare enforces a ~60s idle timeout on HTTP/2 connections. The proxy sends SSE keepalive comments every 25s during silent periods (e.g., extended thinking) to prevent premature disconnection, but very long stalls may still drop.
- **Streaming-only for Claude Code path** - The Claude Code OAuth path always uses streaming. Non-streaming requests are converted to streaming internally and the final result is assembled before responding.
- **Max output 64K tokens** - All current Claude 4.5 models cap at 64K output tokens. With extended thinking enabled, `budget_tokens` is set to `max_tokens - 1` (63,999), leaving minimal room for text output in the base allocation. Interleaved thinking allows the budget to span across tool use turns.
- **Context summarization requires API key** - The `summarize` strategy calls the Anthropic API directly (not via Claude Code OAuth) to summarize context, so it requires `ANTHROPIC_API_KEY` to be set.

## Troubleshooting

| Issue | Fix |
| --- | --- |
| No credentials found | Run `claude /login` |
| Token invalid / expired | Run `claude /login` again |
| `invalid_grant` on refresh | Another process may have rotated the token. Run `claude /login` to get fresh credentials. |
| Always falling back to API key | Check subscription limits, view `/analytics` |
| Budget exceeded | Wait for reset, increase via `POST /budget`, or disable with `{"enabled": false}` |
| Tunnel drops during long responses | Cloudflare idle timeout; proxy mitigates with keepalives but very long thinking periods may still drop |
| Cursor not using the proxy | Restart Cursor after changing the base URL override; toggle the setting off and on |
| `prompt is too long` errors | Context management should handle this automatically. Check that `CONTEXT_STRATEGY=summarize` is set. |

## License

MIT
