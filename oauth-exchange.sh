#!/bin/bash
VERIFIER=$(python3 -c "import json; print(json.load(open('/tmp/claude-oauth-verifier.json'))['verifier'])")
echo "Verifier: $VERIFIER"
curl -v -X POST https://platform.claude.com/v1/oauth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "grant_type=authorization_code&code=$1&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_verifier=$VERIFIER" 2>&1
