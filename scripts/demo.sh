#!/usr/bin/env bash
#
# Launch an ANP demo: build the client, run the relay, and expose it publicly
# through a Cloudflare Tunnel. Prints the public URL. Works locally and in CI.
#
# Env:
#   PORT           relay port (default 8787)
#   DURATION       seconds to keep the tunnel up (default 3600; 0 = forever)
#   ANP_POW_BITS   JOIN proof-of-work difficulty (default 12)
#   CF_TUNNEL_TOKEN  if set, run a NAMED tunnel with this token (stable
#                    hostname you configured in Cloudflare). Otherwise a
#                    throwaway *.trycloudflare.com quick tunnel is used.
#
# Requires: node, npm, and `cloudflared` on PATH (the workflow installs it).
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-8787}"
DURATION="${DURATION:-3600}"
export ANP_POW_BITS="${ANP_POW_BITS:-12}"
export HOST="127.0.0.1"
export ANP_TRUST_PROXY=1
export PORT

log() { printf '\033[36m[demo]\033[0m %s\n' "$*"; }

cleanup() {
  log "shutting down"
  [[ -n "${RELAY_PID:-}" ]] && kill "$RELAY_PID" 2>/dev/null || true
  [[ -n "${CF_PID:-}" ]] && kill "$CF_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found on PATH. Install it first (the GitHub workflow does this automatically)." >&2
  exit 1
fi

log "building client bundle"
npm run build >/dev/null

log "starting relay on 127.0.0.1:$PORT (PoW ${ANP_POW_BITS} bits, trust-proxy on)"
npx tsx src/relay/server.ts &
RELAY_PID=$!

# wait for the relay to answer /health
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null || { echo "relay failed to start" >&2; exit 1; }
log "relay healthy"

CF_LOG="$(mktemp)"
PUBLIC_URL=""

if [[ -n "${CF_TUNNEL_TOKEN:-}" ]]; then
  log "starting NAMED Cloudflare Tunnel"
  cloudflared tunnel --no-autoupdate run --token "$CF_TUNNEL_TOKEN" >"$CF_LOG" 2>&1 &
  CF_PID=$!
  PUBLIC_URL="${CF_PUBLIC_URL:-<your configured tunnel hostname>}"
else
  log "starting quick Cloudflare Tunnel (throwaway *.trycloudflare.com)"
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >"$CF_LOG" 2>&1 &
  CF_PID=$!
  # cloudflared prints the assigned URL to its log within a few seconds
  for _ in $(seq 1 40); do
    URL="$(grep -Eo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$CF_LOG" | head -n1 || true)"
    if [[ -n "$URL" ]]; then PUBLIC_URL="$URL"; break; fi
    sleep 0.5
  done
fi

if [[ -z "$PUBLIC_URL" ]]; then
  echo "failed to obtain a tunnel URL; cloudflared log:" >&2
  cat "$CF_LOG" >&2
  exit 1
fi

log "PUBLIC URL: $PUBLIC_URL"
echo "$PUBLIC_URL" > .demo-url

# GitHub Actions step summary
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "## 🌐 ANP デモが起動しました"
    echo ""
    echo "**公開URL:** [$PUBLIC_URL]($PUBLIC_URL)"
    echo ""
    echo "同じURLを複数のブラウザ(または別プロファイル)で開くと、招待制P2Pネットワークを試せます。"
    echo ""
    echo "1. 1つ目: 「ネットワークを作成して参加」"
    echo "2. 2つ目: 「参加リクエストコードを作成」→ コードを1つ目に渡す"
    echo "3. 1つ目: 「招待を発行」→ 招待リンクを2つ目で開く"
    echo ""
    echo "- JOIN PoW: ${ANP_POW_BITS} bits"
    echo "- このトンネルは約 $((DURATION / 60)) 分後に自動停止します。"
  } >> "$GITHUB_STEP_SUMMARY"
fi

log "tunnel up; keeping alive for ${DURATION}s (0 = forever)"
if [[ "$DURATION" == "0" ]]; then
  wait "$CF_PID"
else
  # exit early if either process dies
  SECONDS=0
  while (( SECONDS < DURATION )); do
    kill -0 "$RELAY_PID" 2>/dev/null || { echo "relay died" >&2; exit 1; }
    kill -0 "$CF_PID" 2>/dev/null || { echo "cloudflared died; log:" >&2; cat "$CF_LOG" >&2; exit 1; }
    sleep 5
  done
fi

log "duration elapsed"
