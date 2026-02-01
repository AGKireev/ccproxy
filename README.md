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

**Windows users**: A `start-proxy.bat` launcher template is referenced in this repo. Copy it from the example or create your own to start both the proxy server and Cloudflare tunnel in one click.

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
| `ANTHROPIC_API_KEY` | - | Fallback API key when Claude Code limits hit |
| `CLAUDE_CODE_FIRST` | `true` | Set `false` to use direct API only |
| `CLAUDE_CODE_EXTRA_INSTRUCTION` | *(see below)* | Extra system prompt appended after the required Claude Code prefix |
| `OPENAI_API_KEY` | - | OpenAI/OpenRouter API key for non-Claude model passthrough |
| `OPENAI_BASE_URL` | `https://api.openai.com` | OpenAI-compatible base URL (set to `https://openrouter.ai/api` for OpenRouter) |
| `ALLOWED_IPS` | Cursor backend IPs | Comma-separated IP whitelist; only enforced for Cloudflare tunnel requests |

See `.env.example` for the full list with descriptions.

## How It Works

```
Cursor → ccproxy → Claude Code OAuth (subscription)
              ↓ fallback (429/403)
         Anthropic API (direct, paid)
```

Request metadata is logged to your local SQLite database for analytics and cost tracking.

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

- **No thinking budget control** - The proxy does not set or forward the thinking budget that Cursor might otherwise configure when using Anthropic directly. Claude will use its default thinking behavior.
- **Tool call translation edge cases** - OpenAI-format tool calls are translated to Claude's native format. Complex or deeply nested tool schemas may not translate perfectly.
- **Cloudflare tunnel idle timeout** - Cloudflare enforces a ~60s idle timeout on HTTP/2 connections. The proxy sends SSE keepalive comments every 25s during silent periods (e.g., extended thinking) to prevent premature disconnection, but very long stalls may still drop.
- **OAuth token refresh** - Claude Code OAuth tokens are refreshed automatically, but if the CLI session expires or is revoked you'll need to re-run `claude /login`.
- **Streaming-only for Claude Code path** - The Claude Code OAuth path always uses streaming. Non-streaming requests are converted to streaming internally and the final result is assembled before responding.

## Troubleshooting

| Issue | Fix |
| --- | --- |
| No credentials found | Run `claude /login` |
| Token invalid / expired | Run `claude /login` again |
| Always falling back to API key | Check subscription limits, view `/analytics` |
| Budget exceeded | Wait for reset, increase via `POST /budget`, or disable with `{"enabled": false}` |
| Tunnel drops during long responses | This is a Cloudflare idle timeout issue; the proxy mitigates it with keepalives but very long thinking periods may still drop |
| Cursor not using the proxy | Restart Cursor after changing the base URL override; toggle the setting off and on |

## License

MIT
