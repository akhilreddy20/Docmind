#!/usr/bin/env bash
# End-to-end smoke test against a running stack: register, upload samples,
# wait for ingestion, then ask the same question twice (second one should be a cache hit).
set -euo pipefail
API=${API:-http://localhost:4000}
DIR="$(cd "$(dirname "$0")/.." && pwd)"
EMAIL="smoke$(date +%s)@example.com"

TOKEN=$(curl -sf -XPOST "$API/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}" | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')
AUTH="authorization: Bearer $TOKEN"
echo "Registered $EMAIL"

curl -sf -XPOST "$API/documents" -H "$AUTH" \
  -F files=@"$DIR/samples/employee-handbook.md" \
  -F files=@"$DIR/samples/error-codes.txt" \
  -F files=@"$DIR/samples/orion-architecture.pdf" > /dev/null
echo "Uploaded samples, waiting for workers..."

for _ in $(seq 1 60); do
  DOCS=$(curl -sf "$API/documents" -H "$AUTH")
  if ! grep -qE '"status":"(queued|processing)"' <<<"$DOCS"; then break; fi
  sleep 1
done
grep -o '"filename":"[^"]*","mimeType":"[^"]*","sizeBytes":[0-9]*,"status":"[a-z]*"' <<<"$DOCS"

ask() {
  echo; echo "Q: $1"
  curl -sN -XPOST "$API/query/stream" -H "$AUTH" -H 'content-type: application/json' \
    -d "{\"question\":\"$1\"}" | grep -E '^data: \{"cache"' | cut -c1-160
}
ask "What does ERR-5003 mean?"
ask "what does err-5003 mean"
ask "Which ticket queue handles suspended merchant accounts?"
