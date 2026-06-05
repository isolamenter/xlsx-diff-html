# XlsxDiffHtml

XlsxDiffHtml builds a macOS Apple Silicon DMG for a local browser UI that compares changed `.xlsx` files in Git repositories and renders HTML diffs with `daff`.

The app bundles Node, `daff`, and `xlsx` (SheetJS) into `XlsxDiffHtml.app`, then packages the app into a DMG.

## Build

Requirements:

- macOS on Apple Silicon
- `clang`
- `codesign`
- `hdiutil`
- Node.js with `npm`

Project npm dependencies:

- `daff`
- `xlsx` (SheetJS, installed from the SheetJS CDN tarball)

Install project dependencies:

```bash
npm install
```

Build the DMG:

```bash
npm run build:dmg
```

The output is:

```text
dist/XlsxDiffHtml.dmg
```

You can override build metadata:

```bash
BUNDLE_ID=com.example.XlsxDiffHtml APP_VERSION=1.0.0 ./scripts/build-dmg.sh
```

## Signing

The build uses ad-hoc signing:

```text
Signature=adhoc
```

This is enough for local packaging and testing, but it is not Developer ID signing or notarization. Apps distributed outside a trusted environment may still require a manual Gatekeeper allow step.

## Runtime

On first launch, the app asks which folder the Web UI may read. The selected root is stored in:

```text
~/Library/Application Support/XlsxDiffHtml/config.json
```

For one launch, override the root from Terminal:

```bash
XLSX_DIFF_HTML_ROOT=/path/to/root /Applications/XlsxDiffHtml.app/Contents/MacOS/XlsxDiffHtml
```

The generated DMG contains `XlsxDiffHtml.app` and an `Applications` shortcut.
