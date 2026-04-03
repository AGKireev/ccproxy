#!/usr/bin/env python3
"""Smoke test GPT via ccproxy on localhost. Reads PROXY_SECRET_KEY from ccproxy .env."""
import json
import os
import sys
import urllib.error
import urllib.request

ENV_PATH = "/home/agkireev/ccproxy/.env"


def load_secret():
    with open(ENV_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("PROXY_SECRET_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("PROXY_SECRET_KEY not found in .env")


def main():
    secret = load_secret()
    body = {
        "model": "gpt-5.4",
        "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
        "max_tokens": 32,
        "stream": False,
    }
    req = urllib.request.Request(
        "http://127.0.0.1:8082/v1/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {secret}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode("utf-8")
            print("HTTP", resp.status)
            print(raw[:1200])
    except urllib.error.HTTPError as e:
        print("HTTP", e.code)
        print(e.read().decode("utf-8", errors="replace")[:2000])


if __name__ == "__main__":
    main()
