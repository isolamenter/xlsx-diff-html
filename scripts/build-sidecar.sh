#!/usr/bin/env bash
# Build the Node SEA sidecar for Tauri.
# Run from the project root: bash scripts/build-sidecar.sh
set -euo pipefail
cd "$(dirname "$0")/.."

TRIPLE=$(rustc -Vv | grep host | awk '{print $2}')
BINARIES_DIR="xlsx-diff-html-tauri/src-tauri/binaries"
mkdir -p "$BINARIES_DIR" dist

# 1. Bundle everything into a single CJS file
echo "==> Bundling server.mjs with esbuild..."
node_modules/.bin/esbuild xlsx-diff-html-web/app/server.mjs \
  --bundle \
  --platform=node \
  --format=cjs \
  --minify \
  --define:'import.meta.url=__import_meta_url' \
  --banner:js="var __import_meta_url = require('node:url').pathToFileURL(typeof __filename !== 'undefined' ? __filename : process.execPath).href;" \
  --outfile=dist/server-bundle.cjs

# 2. Create Node SEA config
cat > dist/sea-config.json <<'JSON'
{
  "main": "dist/server-bundle.cjs",
  "output": "dist/sea-prep.blob",
  "disableExperimentalSEAWarning": true
}
JSON

# 3. Generate the blob
echo "==> Generating SEA blob..."
node --experimental-sea-config dist/sea-config.json

# 4. Copy node binary and inject the blob
echo "==> Injecting blob into node binary..."
cp "$(which node)" dist/server-sea
node_modules/.bin/postject dist/server-sea NODE_SEA_BLOB dist/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  --macho-segment-name NODE_SEA

# 5. Ad-hoc code-sign (macOS requires a valid signature after binary modification)
echo "==> Signing binary..."
codesign --sign - dist/server-sea

# 6. Install into Tauri binaries directory
cp dist/server-sea "${BINARIES_DIR}/server-${TRIPLE}"
chmod +x "${BINARIES_DIR}/server-${TRIPLE}"

echo "==> Done: ${BINARIES_DIR}/server-${TRIPLE}"
