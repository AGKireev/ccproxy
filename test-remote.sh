#!/bin/bash
cat > /tmp/test-body.json << 'EOF'
{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"Say hello"}],"max_tokens":50,"stream":false}
EOF
curl -s -w '\nHTTP_CODE:%{http_code}' -X POST http://localhost:8082/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer fb5d913744e99643b8dcf77b1c0b46e145f73ae81641a1af0442621344a478d1' \
  -d @/tmp/test-body.json
rm /tmp/test-body.json
