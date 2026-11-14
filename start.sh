#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ is required. Install it from https://nodejs.org/"
  exit 1
fi

if [ ! -d "node_modules/express" ]; then
  echo "First-time setup: installing dependencies and preparing database..."
  node setup.js
fi

node tools/launch.js "$@"
