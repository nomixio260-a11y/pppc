#!/usr/bin/env bash
# ANP Chat launcher (Linux). Run: ./start.sh   (requires Node.js)
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。https://nodejs.org からインストールしてください。"
  exit 1
fi
ANP_OPEN=1 node server.mjs
