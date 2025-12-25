# ccproxy

A local proxy that routes Anthropic API requests through your Claude Code subscription, with automatic fallback to direct API when limits are hit.

## Quick Start

```bash
# Prerequisites: Claude Code CLI authenticated (`claude /login`) and Bun installed
bun install && bun run index.ts
```

Proxy runs on `http://localhost:8082`. Use `http://localhost:8082/v1` as your base URL.

### HTTPS via Cloudflare Tunnel

Required for OpenAI provider override in Cursor:

```bash
brew install cloudflared

# Quick tunnel (URL changes on restart)
cloudflared tunnel --url http://localhost:8082

# Fixed tunnel (permanent URL)
cloudflared tunnel login
cloudflared tunnel create ccproxy
cloudflared tunnel route dns ccproxy ccproxy.yourdomain.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /Users/you/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: ccproxy.yourdomain.com
    service: http://localhost:8082
  - service: http_status:404
```

Run: `cloudflared tunnel run ccproxy`

Use `https://ccproxy.yourdomain.com/v1` as your base URL.

## Cursor Setup

**Anthropic Provider** (recommended):

- Settings → Anthropic API Base URL → `http://localhost:8082/v1`
- Anthropic API Key → any value (e.g., `proxy`)

**OpenAI Provider** (alternative):

- Settings → OpenAI API Base URL → `http://localhost:8082/v1`
- OpenAI API Key → any value

Working? Check terminal for `✓ Request served via Claude Code`.

## Configuration

| Variable            | Default | Description                                  |
| ------------------- | ------- | -------------------------------------------- |
| `PORT`              | `8082`  | Proxy port                                   |
| `ANTHROPIC_API_KEY` | -       | Fallback API key when Claude Code limits hit |
| `CLAUDE_CODE_FIRST` | `true`  | Set `false` to use direct API only           |

## How It Works

```
Cursor → ccproxy → Claude Code OAuth (subscription)
              ↓ fallback (429/403)
         Anthropic API (direct, paid)
```

Requests are logged to SQLite for analytics and cost tracking.

## API Endpoints

| Endpoint               | Description                                         |
| ---------------------- | --------------------------------------------------- |
| `/v1/messages`         | Anthropic Messages API                              |
| `/v1/chat/completions` | OpenAI Chat Completions API                         |
| `/analytics`           | Usage stats (`?period=hour\|day\|week\|month\|all`) |
| `/budget`              | GET/POST budget settings                            |
| `/health`              | Health check                                        |

## Troubleshooting

| Issue                | Fix                                                                               |
| -------------------- | --------------------------------------------------------------------------------- |
| No credentials found | Run `claude /login`                                                               |
| Token invalid        | Run `claude /login` again                                                         |
| Always falling back  | Check subscription limits, view `/analytics`                                      |
| Budget exceeded      | Wait for reset, increase via `POST /budget`, or disable with `{"enabled": false}` |

## License

MIT
