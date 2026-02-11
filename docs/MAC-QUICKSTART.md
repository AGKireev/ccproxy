# CCProxy — Mac Quick-Start Guide

## One-Time Setup (common)

1. **Install Bun** — `curl -fsSL https://bun.sh/install | bash`, then restart your terminal.
2. **Install Cloudflared** — `brew install cloudflared`.
3. **Install & authenticate Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`, then run `claude /login` and complete the OAuth flow.
4. **Clone & install the proxy** — `git clone <repo-url> && cd ccproxy && bun install`.
5. **Create `.env`** — `cp .env.example .env` (defaults work out of the box).

Now pick **Option A** (easiest) or **Option B** (permanent URL).

---

## Option A — Quick Tunnel (no domain needed)

Cloudflare gives you a temporary public HTTPS URL every time you start the proxy. No account, no domain, no config — just run and go. The URL changes on every restart.

### One-time setup

6. **Configure Cursor**:
   1. Open **Cursor → Settings → Models**.
   2. Enable **"Override OpenAI Base URL"**.
   3. Set the URL to `https://xxxxxxxx.trycloudflare.com/v1` (placeholder — you'll get the real URL in step 2 below).
   4. Enter any string as the API key (e.g. `x`) — the proxy uses Claude Code OAuth, not this key.
   5. **Restart Cursor**.

### Daily usage

1. Open Terminal in the `ccproxy` folder.
2. Run `./start-proxy.sh` — starts the proxy + a quick tunnel.
3. Look for the `[tunnel]` line with your temporary URL (e.g. `https://xxxxxxxx.trycloudflare.com`).
4. Copy that URL, go to **Cursor → Settings → Models**, update the Base URL to `https://<new-url>/v1`, and **restart Cursor**.
5. Use Cursor normally — pick a Claude model and go.
6. When done — press `Ctrl+C` to shut everything down.

> **Heads up**: The URL changes every time you restart the tunnel. You'll need to update Cursor settings and restart Cursor each time.

---

## Option B — Named Tunnel (permanent URL with your own domain)

Set up once with your own domain — the URL never changes. No need to touch Cursor settings again after initial setup.

### One-time setup

6. **Create a Cloudflare tunnel**:
   1. `cloudflared tunnel login` — opens browser to authenticate with your Cloudflare account.
   2. `cloudflared tunnel create ccproxy` — creates a named tunnel.
   3. `cloudflared tunnel route dns ccproxy ccproxy.yourdomain.com` — points your subdomain to the tunnel.
   4. `cp cloudflared-config.example.yml cloudflared-config.yml` — then edit the file and fill in your tunnel UUID, credentials path, and hostname.
7. **Configure Cursor**:
   1. Open **Cursor → Settings → Models**.
   2. Enable **"Override OpenAI Base URL"**.
   3. Set the URL to `https://ccproxy.yourdomain.com/v1`.
   4. Enter any string as the API key (e.g. `x`) — the proxy uses Claude Code OAuth, not this key.
   5. **Restart Cursor**.

### Daily usage

1. Open Terminal in the `ccproxy` folder.
2. Run `./start-proxy.sh` — starts the proxy + your named tunnel.
3. Wait for the `✅ Both processes running` message.
4. Open Cursor, pick a Claude model, and use it normally.
5. When done — press `Ctrl+C` to shut everything down.

---

## Troubleshooting

- **"command not found: bun"** — restart your terminal after installing Bun.
- **401 errors** — re-run `claude /login` to refresh your OAuth token.
- **Quick tunnel URL changed** — update the Base URL in Cursor settings and restart Cursor.
- **Logs** — set `VERBOSE_LOGGING=true` in `.env`, then check `api.log`.
