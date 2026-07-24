#!/usr/bin/env bash
# ANP Chat launcher (macOS: double-click me). Requires Node.js.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。https://nodejs.org からインストールしてください。"
  read -r -p "Enter を押して終了"
  exit 1
fi
ANP_OPEN=1 node server.mjs
