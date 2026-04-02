#!/usr/bin/env python3
"""Manual OAuth flow for Claude Code on headless servers."""
import sys
import os
import json
import hashlib
import base64
import secrets
import urllib.parse
import urllib.request

CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"
SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
CREDS_PATH = os.path.expanduser("~/.claude/.credentials.json")

def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")

def generate_pkce():
    verifier = b64url(secrets.token_bytes(32))
    challenge = b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge

def build_auth_url(challenge, state):
    params = {
        "code": "true",
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPES,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
    }
    return "https://claude.ai/oauth/authorize?" + urllib.parse.urlencode(params)

def exchange_code(code, verifier):
    data = urllib.parse.urlencode({
        "grant_type": "authorization_code",
        "code": code,
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "code_verifier": verifier,
    }).encode("utf-8")
    
    req = urllib.request.Request(TOKEN_URL, data=data, headers={
        "Content-Type": "application/x-www-form-urlencoded",
    })
    
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def save_credentials(token_data):
    import time
    expires_at = int(time.time() * 1000) + token_data["expires_in"] * 1000
    
    creds = {
        "claudeAiOauth": {
            "accessToken": token_data["access_token"],
            "refreshToken": token_data["refresh_token"],
            "expiresAt": expires_at,
            "scopes": SCOPES.split(" "),
        }
    }
    
    os.makedirs(os.path.dirname(CREDS_PATH), exist_ok=True)
    with open(CREDS_PATH, "w") as f:
        json.dump(creds, f)
    
    print(f"Credentials saved to {CREDS_PATH}")
    return creds

if __name__ == "__main__":
    if len(sys.argv) == 1:
        # Step 1: Generate PKCE and print auth URL
        verifier, challenge = generate_pkce()
        state = b64url(secrets.token_bytes(32))
        url = build_auth_url(challenge, state)
        
        # Save verifier for step 2
        with open("/tmp/claude-oauth-verifier.json", "w") as f:
            json.dump({"verifier": verifier, "state": state}, f)
        
        print(f"STATE={state}")
        print(f"URL={url}")
    
    elif len(sys.argv) == 2:
        # Step 2: Exchange code for tokens
        code = sys.argv[1]
        
        with open("/tmp/claude-oauth-verifier.json") as f:
            data = json.load(f)
        
        print(f"Exchanging code for tokens...")
        token_data = exchange_code(code, data["verifier"])
        print(f"Token exchange successful!")
        
        creds = save_credentials(token_data)
        print(f"Access token: {token_data['access_token'][:20]}...")
        print(f"Expires in: {token_data['expires_in']} seconds")
        
        os.unlink("/tmp/claude-oauth-verifier.json")
        print("Done!")
