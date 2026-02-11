# CCProxy — Mac Quick-Start Guide

## One-Time Setup

1. **Install Bun** — `curl -fsSL https://bun.sh/install | bash`, then restart your terminal.
2. **Install & authenticate Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`, then run `claude /login` and complete the OAuth flow.
3. **Clone & install the proxy** — `git clone <repo-url> && cd ccproxy && bun install`.
4. **Create `.env`** — `cp .env.example .env` (defaults work out of the box).

Now pick **Option A** or **Option B** below.

---

## Option A — With Cloudflare Tunnel (recommended)

Cursor routes API calls through its own backend servers, so it can't reach `localhost`. A Cloudflare tunnel gives your proxy a public HTTPS URL that Cursor's servers can reach.

### One-time setup

5. **Install Cloudflared** — `brew install cloudflared`.
6. **Set up a tunnel** (pick one):
   - **Quick tunnel** (URL changes every restart, zero config) — nothing to configure, the start script handles it.
   - **Named tunnel** (permanent URL, recommended):
     1. `cloudflared tunnel login`
     2. `cloudflared tunnel create ccproxy`
     3. `cloudflared tunnel route dns ccproxy ccproxy.yourdomain.com`
     4. `cp cloudflared-config.example.yml cloudflared-config.yml` and fill in your tunnel UUID, credentials path, and hostname.
7. **Configure Cursor**:
   1. Open **Cursor → Settings → Models**.
   2. Enable **"Override OpenAI Base URL"**.
   3. Set the URL to `https://<your-tunnel-url>/v1`.
   4. Enter any string as the API key (e.g. `x`) — the proxy uses Claude Code OAuth, not this key.
   5. **Restart Cursor**.

### Daily usage

1. Open Terminal in the `ccproxy` folder.
2. Run `./start-proxy.sh` — starts both the proxy and the tunnel.
3. Wait for the `✅ Both processes running` message.
4. Open Cursor, pick a Claude model, and use it normally.
5. When done — press `Ctrl+C` to shut everything down.

> **Note**: If you're using a Quick Tunnel, the URL changes on every restart. Update the Base URL in Cursor settings and restart Cursor each time.

---

## Option B — Without Cloudflare (direct localhost)

If you don't want to use Cloudflare, you can run the proxy on `localhost` and point Cursor to it directly. This works when Cursor sends requests straight from your machine (e.g. some API-key setups or other clients that connect locally).

### One-time setup

5. **Configure Cursor**:
   1. Open **Cursor → Settings → Models**.
   2. Enable **"Override OpenAI Base URL"**.
   3. Set the URL to `http://localhost:8082/v1`.
   4. Enter any string as the API key (e.g. `x`).
   5. **Restart Cursor**.

### Daily usage

1. Open Terminal in the `ccproxy` folder.
2. Run `bun run index.ts`.
3. Wait for the `🚀 Server running at http://localhost:8082` message.
4. Open Cursor, pick a Claude model, and use it normally.
5. When done — press `Ctrl+C` to stop the proxy.

> **⚠️ Limitation**: Cursor typically routes "Override Base URL" requests through its own backend servers, which cannot reach `localhost`. If you experience connection errors, you'll need to switch to **Option A** with Cloudflare.

---

## Troubleshooting

- **"command not found: bun"** — restart your terminal after installing Bun.
- **401 errors** — re-run `claude /login` to refresh your OAuth token.
- **Quick tunnel URL changed** — update the Base URL in Cursor settings and restart Cursor.
- **Connection errors with Option B** — Cursor's backend can't reach localhost; switch to Option A.
- **Logs** — set `VERBOSE_LOGGING=true` in `.env`, then check `api.log`.
