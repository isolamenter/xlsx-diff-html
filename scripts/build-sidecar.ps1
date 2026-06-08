# Build the Node SEA sidecar for Tauri on Windows.
# Run from the project root: npm run build:sidecar:win
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot)

$TRIPLE  = (rustc -Vv | Select-String "host").ToString().Split()[1]
$BIN_DIR = "xlsx-diff-html-tauri\src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $BIN_DIR, dist | Out-Null

# 1. Bundle everything into a single CJS file
Write-Host "==> Bundling server.mjs with esbuild..."
npx esbuild xlsx-diff-html-web/app/server.mjs `
  --bundle `
  --platform=node `
  --format=cjs `
  --minify `
  "--define:import.meta.url=__import_meta_url" `
  '--banner:js=var __import_meta_url = typeof __filename !== "undefined" ? require("url").pathToFileURL(__filename).href : "";' `
  --outfile=dist/server-bundle.cjs

# 2. Create Node SEA config
'{"main":"dist/server-bundle.cjs","output":"dist/sea-prep.blob","disableExperimentalSEAWarning":true}' |
  Set-Content dist/sea-config.json -Encoding Ascii

# 3. Generate the blob
Write-Host "==> Generating SEA blob..."
node --experimental-sea-config dist/sea-config.json

# 4. Copy node.exe and inject the blob
# No --macho-segment-name on Windows (that flag is macOS-only)
Write-Host "==> Injecting blob into node.exe copy..."
$NodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) {
  $NodeExe = (Get-Command node).Source
}
if ($NodeExe -like "*.cmd" -or $NodeExe -like "*.bat") {
  $NodeDir = Split-Path $NodeExe
  if (Test-Path "$NodeDir\node.exe") {
    $NodeExe = "$NodeDir\node.exe"
  } else {
    $Paths = $env:PATH -split ';'
    foreach ($p in $Paths) {
      if (Test-Path "$p\node.exe") {
        $NodeExe = "$p\node.exe"
        break
      }
    }
  }
}
Copy-Item $NodeExe dist\server-sea.exe -Force
npx postject dist\server-sea.exe NODE_SEA_BLOB dist\sea-prep.blob `
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# 5. Install into Tauri binaries directory (.exe extension required on Windows)
Copy-Item dist\server-sea.exe "$BIN_DIR\server-$TRIPLE.exe" -Force
Write-Host "==> Done: $BIN_DIR\server-$TRIPLE.exe"
