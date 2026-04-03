#!/usr/bin/env python3
import json
import urllib.request
import urllib.error

BODY = {
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "Reply with exactly one word: pong"}],
    "max_tokens": 64,
    "stream": False,
}
def load_secret():
    p = "/home/agkireev/ccproxy/.env"
    with open(p, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("PROXY_SECRET_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("PROXY_SECRET_KEY not found in .env")


SECRET = load_secret()

req = urllib.request.Request(
    "http://127.0.0.1:8082/v1/chat/completions",
    data=json.dumps(BODY).encode("utf-8"),
    headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {SECRET}",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read().decode("utf-8")
        print("HTTP", resp.status)
        data = json.loads(raw)
        msg = data["choices"][0]["message"]["content"]
        print("ASSISTANT:", msg)
        print("OK_PROXY_WORKS")
except urllib.error.HTTPError as e:
    print("HTTP", e.code)
    print(e.read().decode()[:2000])
