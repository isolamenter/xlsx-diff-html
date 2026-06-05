#!/usr/bin/env bash
set -euo pipefail

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
WEB_SRC="$ROOT_DIR/xlsx-diff-html-web"
DIST_DIR="${DIST_DIR:-$ROOT_DIR/dist}"
BUILD_DIR="$DIST_DIR/build"
PAYLOAD_SRC_DIR="$BUILD_DIR/xlsx-diff-html-web"
APP_DIR="$BUILD_DIR/XlsxDiffHtml.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
PAYLOAD_DIR="$RESOURCES_DIR/xlsx-diff-html-web"
APP_DMG="$DIST_DIR/XlsxDiffHtml.dmg"
DMG_STAGING_DIR="$BUILD_DIR/dmg"
BUNDLE_ID="${BUNDLE_ID:-com.local.xlsx-diff-html}"
APP_VERSION="${APP_VERSION:-1.0.0}"
MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"

[[ "$(uname -s)" == "Darwin" ]] || die "app bundle target is macOS"
[[ "$(uname -m)" == "arm64" ]] || die "app bundle target is macOS arm64"
command -v codesign >/dev/null 2>&1 || die "codesign was not found"
command -v ditto >/dev/null 2>&1 || die "ditto was not found"
command -v hdiutil >/dev/null 2>&1 || die "hdiutil was not found"
command -v clang >/dev/null 2>&1 || die "clang was not found"

[[ -d "$WEB_SRC" ]] || die "missing source directory: $WEB_SRC"
[[ -x "$ROOT_DIR/xlsx-diff-html" ]] || die "missing executable CLI engine: $ROOT_DIR/xlsx-diff-html"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || die "node was not found"
NODE_PREFIX="${NODE_PREFIX:-$(cd "$(dirname "$NODE_BIN")/.." >/dev/null 2>&1 && pwd)}"
[[ -x "$NODE_PREFIX/bin/node" ]] || die "invalid Node prefix: $NODE_PREFIX"

DAFF_PACKAGE="${DAFF_PACKAGE:-$ROOT_DIR/node_modules/daff}"
NODE_MODULES_DIR="${NODE_MODULES_DIR:-$ROOT_DIR/node_modules}"
[[ -f "$DAFF_PACKAGE/package.json" ]] || die "daff package was not found: $DAFF_PACKAGE"
[[ -d "$NODE_MODULES_DIR/xlsx" ]] || die "xlsx (SheetJS) package was not found under $NODE_MODULES_DIR; run npm install"
DAFF_VERSION="$("$NODE_PREFIX/bin/node" -e "process.stdout.write(require(process.argv[1]).version || '')" "$DAFF_PACKAGE/package.json")"
[[ "$DAFF_VERSION" == "1.4.2" ]] || die "expected daff 1.4.2, found ${DAFF_VERSION:-unknown} at $DAFF_PACKAGE; run npm install"

rm -rf "$BUILD_DIR" "$APP_DMG"
mkdir -p "$BUILD_DIR" "$DIST_DIR"
ditto "$WEB_SRC" "$PAYLOAD_SRC_DIR"

cp "$ROOT_DIR/xlsx-diff-html" "$PAYLOAD_SRC_DIR/app/bin/xlsx-diff-html-engine"
chmod +x "$PAYLOAD_SRC_DIR/app/bin/xlsx-diff-html"
chmod +x "$PAYLOAD_SRC_DIR/app/bin/xlsx-diff-html-engine"
chmod +x "$PAYLOAD_SRC_DIR/app/vendor/bin/daff"
chmod +x "$PAYLOAD_SRC_DIR/app/vendor/bin/xlsx2csv"

rm -rf "$PAYLOAD_SRC_DIR/app/vendor/node" "$PAYLOAD_SRC_DIR/app/vendor/daff" "$PAYLOAD_SRC_DIR/app/vendor/node_modules"
mkdir -p "$PAYLOAD_SRC_DIR/app/vendor"
ditto "$NODE_PREFIX" "$PAYLOAD_SRC_DIR/app/vendor/node"
ditto "$DAFF_PACKAGE" "$PAYLOAD_SRC_DIR/app/vendor/daff"
ditto "$NODE_MODULES_DIR" "$PAYLOAD_SRC_DIR/app/vendor/node_modules"

[[ -d "$PAYLOAD_SRC_DIR" ]] || die "app payload was not staged: $PAYLOAD_SRC_DIR"
[[ -x "$PAYLOAD_SRC_DIR/app/vendor/node/bin/node" ]] || die "app payload is missing bundled Node"
[[ -d "$PAYLOAD_SRC_DIR/app/vendor/node_modules/xlsx" ]] || die "app payload is missing xlsx (SheetJS)"
[[ -f "$PAYLOAD_SRC_DIR/app/vendor/xlsx2csv-node.mjs" ]] || die "app payload is missing Node XLSX converter"
[[ ! -e "$PAYLOAD_SRC_DIR/app/vendor/bin/xlsx2csv-bin" ]] || die "app payload still contains xlsx2csv-bin"

mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
ditto "$PAYLOAD_SRC_DIR" "$PAYLOAD_DIR"

cat >"$MACOS_DIR/XlsxDiffHtml.sh" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail

alert_error() {
  local message="$1"
  if command -v osascript >/dev/null 2>&1; then
    osascript \
      -e 'on run argv' \
      -e 'display dialog (item 1 of argv) buttons {"OK"} default button "OK" with icon stop' \
      -e 'end run' \
      "$message" >/dev/null 2>&1 || true
  fi
  printf 'Error: %s\n' "$message" >&2
}

resolve_script_dir() {
  local source="${BASH_SOURCE[0]}"
  local dir=""

  while [[ -L "$source" ]]; do
    dir="$(cd -P "$(dirname "$source")" >/dev/null 2>&1 && pwd)"
    source="$(readlink "$source")"
    [[ "$source" != /* ]] && source="$dir/$source"
  done

  cd -P "$(dirname "$source")" >/dev/null 2>&1 && pwd
}

choose_root() {
  local default_root="$1"
  osascript - "$default_root" <<'APPLESCRIPT'
on run argv
  set defaultRoot to item 1 of argv
  try
    set folderAlias to choose folder with prompt "Choose the folder xlsx-diff-html may read." default location (POSIX file defaultRoot)
    return POSIX path of folderAlias
  on error number -128
    return ""
  end try
end run
APPLESCRIPT
}

read_config_root() {
  "$NODE_BIN" -e 'const fs=require("fs");try{const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(typeof c.root==="string")process.stdout.write(c.root)}catch{}' "$CONFIG_FILE"
}

write_config_root() {
  "$NODE_BIN" -e 'const fs=require("fs");const path=require("path");const file=process.argv[1];const root=process.argv[2];fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({root,updatedAt:new Date().toISOString()},null,2)+"\n")' "$CONFIG_FILE" "$ACCESS_ROOT"
}

SCRIPT_DIR="$(resolve_script_dir)"
CONTENTS_DIR="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"
APP_BUNDLE="$(cd "$CONTENTS_DIR/.." >/dev/null 2>&1 && pwd)"
APP_PARENT="$(cd "$APP_BUNDLE/.." >/dev/null 2>&1 && pwd)"
PAYLOAD_DIR="$CONTENTS_DIR/Resources/xlsx-diff-html-web"
APP_PAYLOAD_DIR="$PAYLOAD_DIR/app"
NODE_BIN="$APP_PAYLOAD_DIR/vendor/node/bin/node"
SERVER="$APP_PAYLOAD_DIR/server.mjs"
CONFIG_FILE="$HOME/Library/Application Support/XlsxDiffHtml/config.json"

if [[ ! -x "$NODE_BIN" ]]; then
  alert_error "Bundled Node runtime was not found."
  exit 1
fi

if [[ ! -f "$SERVER" ]]; then
  alert_error "Bundled server was not found."
  exit 1
fi

if [[ -n "${XLSX_DIFF_HTML_ROOT:-}" ]]; then
  ACCESS_ROOT="$XLSX_DIFF_HTML_ROOT"
else
  ACCESS_ROOT="$(read_config_root)"
  if [[ -z "$ACCESS_ROOT" || ! -d "$ACCESS_ROOT" ]]; then
    DEFAULT_ROOT="$APP_PARENT"
    if [[ "$DEFAULT_ROOT" == "/Applications" || "$DEFAULT_ROOT" == "/Applications/" ]]; then
      DEFAULT_ROOT="$HOME"
    fi
    ACCESS_ROOT="$(choose_root "$DEFAULT_ROOT")"
    if [[ -z "$ACCESS_ROOT" ]]; then
      exit 0
    fi
    write_config_root
  fi
fi

if [[ ! -d "$ACCESS_ROOT" ]]; then
  alert_error "Selected root no longer exists: $ACCESS_ROOT"
  exit 1
fi

TOKEN="$("$NODE_BIN" -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")"
READY_FILE="${TMPDIR:-/tmp}/xlsx-diff-html-ready.$$"
LOG_FILE="${TMPDIR:-/tmp}/xlsx-diff-html-server.$$.log"

cleanup() {
  local status=$?
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$READY_FILE"
  exit "$status"
}

trap cleanup INT TERM EXIT

XLSX_DIFF_HTML_ROOT="$ACCESS_ROOT" \
XLSX_DIFF_HTML_TOKEN="$TOKEN" \
XLSX_DIFF_HTML_READY_FILE="$READY_FILE" \
"$NODE_BIN" "$SERVER" >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

for _ in {1..100}; do
  if [[ -s "$READY_FILE" ]]; then
    URL="$(cat "$READY_FILE")"
    if [[ "${XLSX_DIFF_HTML_NO_OPEN:-0}" == "1" ]]; then
      printf 'Open this URL manually: %s\n' "$URL"
    elif command -v open >/dev/null 2>&1; then
      open "$URL" >/dev/null 2>&1 || alert_error "Failed to open browser. Open this URL manually: $URL"
    else
      alert_error "Open this URL manually: $URL"
    fi
    wait "$SERVER_PID"
    exit $?
  fi

  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    SERVER_LOG="$(cat "$LOG_FILE" 2>/dev/null || true)"
    alert_error "Server failed to start. ${SERVER_LOG}"
    exit 1
  fi

  sleep 0.1
done

SERVER_LOG="$(cat "$LOG_FILE" 2>/dev/null || true)"
alert_error "Server did not become ready in time. ${SERVER_LOG}"
exit 1
LAUNCHER

chmod +x "$MACOS_DIR/XlsxDiffHtml.sh"

cat >"$MACOS_DIR/XlsxDiffHtmlLauncher.c" <<'C'
#include <crt_externs.h>
#include <mach-o/dyld.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/param.h>
#include <unistd.h>

int main(int argc, char **argv) {
  char executable[PATH_MAX];
  uint32_t size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &size) != 0) {
    fprintf(stderr, "executable path is too long\n");
    return 1;
  }

  char resolved[PATH_MAX];
  if (realpath(executable, resolved) == NULL) {
    perror("realpath");
    return 1;
  }

  char *lastSlash = strrchr(resolved, '/');
  if (lastSlash == NULL) {
    fprintf(stderr, "invalid executable path\n");
    return 1;
  }
  *lastSlash = '\0';

  char script[PATH_MAX];
  if (snprintf(script, sizeof(script), "%s/XlsxDiffHtml.sh", resolved) >= (int)sizeof(script)) {
    fprintf(stderr, "launcher script path is too long\n");
    return 1;
  }

  char **childArgv = calloc((size_t)argc + 2, sizeof(char *));
  if (childArgv == NULL) {
    perror("calloc");
    return 1;
  }
  childArgv[0] = "/bin/bash";
  childArgv[1] = script;
  for (int i = 1; i < argc; i += 1) {
    childArgv[i + 1] = argv[i];
  }

  execve("/bin/bash", childArgv, *_NSGetEnviron());
  perror("execve");
  return 1;
}
C

clang -Os -Wall -Wextra -mmacosx-version-min="$MACOSX_DEPLOYMENT_TARGET" -o "$MACOS_DIR/XlsxDiffHtml" "$MACOS_DIR/XlsxDiffHtmlLauncher.c"
rm -f "$MACOS_DIR/XlsxDiffHtmlLauncher.c"

cat >"$CONTENTS_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>XlsxDiffHtml</string>
  <key>CFBundleExecutable</key>
  <string>XlsxDiffHtml</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>XlsxDiffHtml</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$APP_VERSION</string>
  <key>CFBundleVersion</key>
  <string>$APP_VERSION</string>
  <key>LSMinimumSystemVersion</key>
  <string>$MACOSX_DEPLOYMENT_TARGET</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

printf 'APPL????' >"$CONTENTS_DIR/PkgInfo"

"$PAYLOAD_DIR/app/vendor/node/bin/node" - "$RESOURCES_DIR/XlsxDiffHtml.iconset" <<'NODE'
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const outDir = process.argv[2];
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function roundedRect(x, y, w, h, r, px, py) {
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  return (px - cx) ** 2 + (py - cy) ** 2 <= r ** 2;
}

function setPixel(pixels, width, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= width) return;
  const i = (y * width + x) * 4;
  pixels[i] = color[0];
  pixels[i + 1] = color[1];
  pixels[i + 2] = color[2];
  pixels[i + 3] = color[3];
}

function drawPng(size, file) {
  const pixels = Buffer.alloc(size * size * 4);
  const bg = [34, 105, 107, 255];
  const bg2 = [47, 138, 120, 255];
  const sheet = [248, 252, 249, 255];
  const line = [181, 205, 198, 255];
  const accent = [222, 95, 76, 255];
  const shadow = [17, 49, 54, 80];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const t = (x + y) / (size * 2);
      setPixel(pixels, size, x, y, [
        Math.round(bg[0] * (1 - t) + bg2[0] * t),
        Math.round(bg[1] * (1 - t) + bg2[1] * t),
        Math.round(bg[2] * (1 - t) + bg2[2] * t),
        255,
      ]);
    }
  }

  const margin = Math.round(size * 0.18);
  const docX = margin;
  const docY = Math.round(size * 0.12);
  const docW = size - margin * 2;
  const docH = Math.round(size * 0.76);
  const radius = Math.max(2, Math.round(size * 0.055));

  for (let y = docY + Math.round(size * 0.025); y < docY + docH + Math.round(size * 0.025); y += 1) {
    for (let x = docX + Math.round(size * 0.025); x < docX + docW + Math.round(size * 0.025); x += 1) {
      if (roundedRect(docX, docY, docW, docH, radius, x - Math.round(size * 0.025), y - Math.round(size * 0.025))) {
        setPixel(pixels, size, x, y, shadow);
      }
    }
  }

  for (let y = docY; y < docY + docH; y += 1) {
    for (let x = docX; x < docX + docW; x += 1) {
      if (roundedRect(docX, docY, docW, docH, radius, x, y)) setPixel(pixels, size, x, y, sheet);
    }
  }

  const headerH = Math.round(size * 0.14);
  for (let y = docY; y < docY + headerH; y += 1) {
    for (let x = docX; x < docX + docW; x += 1) {
      if (roundedRect(docX, docY, docW, docH, radius, x, y)) setPixel(pixels, size, x, y, [61, 151, 120, 255]);
    }
  }

  const gridLeft = docX + Math.round(size * 0.1);
  const gridRight = docX + docW - Math.round(size * 0.1);
  const gridTop = docY + headerH + Math.round(size * 0.08);
  const gridBottom = docY + docH - Math.round(size * 0.18);
  const stroke = Math.max(1, Math.round(size * 0.01));
  for (let n = 0; n < 4; n += 1) {
    const x = Math.round(gridLeft + (gridRight - gridLeft) * n / 3);
    for (let yy = gridTop; yy <= gridBottom; yy += 1) {
      for (let s = 0; s < stroke; s += 1) setPixel(pixels, size, x + s, yy, line);
    }
  }
  for (let n = 0; n < 5; n += 1) {
    const y = Math.round(gridTop + (gridBottom - gridTop) * n / 4);
    for (let xx = gridLeft; xx <= gridRight; xx += 1) {
      for (let s = 0; s < stroke; s += 1) setPixel(pixels, size, xx, y + s, line);
    }
  }

  const x0 = Math.round(docX + docW * 0.28);
  const x1 = Math.round(docX + docW * 0.72);
  const y0 = Math.round(docY + docH * 0.62);
  const y1 = Math.round(docY + docH * 0.84);
  const xStroke = Math.max(2, Math.round(size * 0.045));
  for (let i = 0; i <= x1 - x0; i += 1) {
    const yA = Math.round(y0 + (y1 - y0) * i / (x1 - x0));
    const yB = Math.round(y1 - (y1 - y0) * i / (x1 - x0));
    for (let dx = -xStroke; dx <= xStroke; dx += 1) {
      for (let dy = -xStroke; dy <= xStroke; dy += 1) {
        if (dx * dx + dy * dy <= xStroke * xStroke) {
          setPixel(pixels, size, x0 + i + dx, yA + dy, accent);
          setPixel(pixels, size, x0 + i + dx, yB + dy, accent);
        }
      }
    }
  }

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path.join(outDir, file), png);
}

for (const [size, name] of [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
]) {
  drawPng(size, name);
}
NODE

if command -v iconutil >/dev/null 2>&1; then
  if iconutil --convert icns --output "$RESOURCES_DIR/AppIcon.icns" "$RESOURCES_DIR/XlsxDiffHtml.iconset"; then
    rm -rf "$RESOURCES_DIR/XlsxDiffHtml.iconset"
  else
    printf 'Warning: failed to generate AppIcon.icns; using the default app icon.\n' >&2
    rm -rf "$RESOURCES_DIR/XlsxDiffHtml.iconset" "$RESOURCES_DIR/AppIcon.icns"
    /usr/libexec/PlistBuddy -c 'Delete :CFBundleIconFile' "$CONTENTS_DIR/Info.plist" >/dev/null 2>&1 || true
  fi
else
  printf 'Warning: iconutil was not found; using the default app icon.\n' >&2
  rm -rf "$RESOURCES_DIR/XlsxDiffHtml.iconset"
  /usr/libexec/PlistBuddy -c 'Delete :CFBundleIconFile' "$CONTENTS_DIR/Info.plist" >/dev/null 2>&1 || true
fi

chmod +x "$PAYLOAD_DIR/app/bin/xlsx-diff-html"
chmod +x "$PAYLOAD_DIR/app/bin/xlsx-diff-html-engine"
chmod +x "$PAYLOAD_DIR/app/vendor/bin/daff"
chmod +x "$PAYLOAD_DIR/app/vendor/bin/xlsx2csv"
chmod +x "$PAYLOAD_DIR/app/vendor/node/bin/node"

sign_file_if_possible() {
  local target="$1"
  [[ -e "$target" ]] || return 0
  codesign --force --sign - "$target" >/dev/null 2>&1 || true
}

sign_file_if_possible "$PAYLOAD_DIR/app/vendor/node/bin/node"
sign_file_if_possible "$PAYLOAD_DIR/app/vendor/bin/daff"
sign_file_if_possible "$PAYLOAD_DIR/app/vendor/bin/xlsx2csv"
sign_file_if_possible "$PAYLOAD_DIR/app/bin/xlsx-diff-html"
sign_file_if_possible "$PAYLOAD_DIR/app/bin/xlsx-diff-html-engine"
sign_file_if_possible "$MACOS_DIR/XlsxDiffHtml"

codesign --force --deep --sign - "$APP_DIR"
codesign --verify --deep --strict --verbose=4 "$APP_DIR"

mkdir -p "$DMG_STAGING_DIR"
ditto "$APP_DIR" "$DMG_STAGING_DIR/XlsxDiffHtml.app"
ln -s /Applications "$DMG_STAGING_DIR/Applications"
hdiutil create \
  -volname XlsxDiffHtml \
  -srcfolder "$DMG_STAGING_DIR" \
  -ov \
  -format UDZO \
  "$APP_DMG"

printf 'DMG: %s\n' "$APP_DMG"
printf 'Signature:\n'
codesign -dv --verbose=4 "$APP_DIR" 2>&1 | sed -n '/Signature=/p;/Authority=/p;/TeamIdentifier=/p'
rm -rf "$BUILD_DIR"
