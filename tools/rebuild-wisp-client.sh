#!/usr/bin/env bash
# Rebuild the LGPL client from the included readable source and pinned tools.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/vendor-src/wisp-js"
npm ci --ignore-scripts
npx webpack --mode=production --config-name client
cp dist/wisp-client.js dist/wisp-client.js.map "$ROOT/web/vendor/"
printf '%s\n' 'Rebuilt the separate LGPL client; restart/reload the standalone test host.'
