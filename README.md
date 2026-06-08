# xlsx-diff-html

把 Git 仓库里变更的 `.xlsx` 文件转成 HTML diff，方便 code review。

数据流：`xlsx → xlsx2csv (SheetJS) → CSV → daff → HTML`

## 使用方式

### CLI

```bash
npm install
node xlsx-diff-html.mjs --changed          # 对 git status 里所有改动的 .xlsx 生成 diff
node xlsx-diff-html.mjs FILE.xlsx          # 单文件（HEAD vs 工作区）
node xlsx-diff-html.mjs --staged FILE.xlsx # HEAD vs 暂存区
```

常用选项：`--all`（所有 sheet）、`--sheet N`、`--skip-hidden`、`--output <dir>`、`--date-format <code>`。

### Web UI（浏览器访问）

```bash
XLSX_DIFF_HTML_ROOT="$PWD" node xlsx-diff-html-web/app/server.mjs
# 输出形如 http://127.0.0.1:<port>/?token=<token> 的地址，用浏览器打开
```

### Tauri 桌面 App

**macOS**（产出 `.app` / `.dmg`）

依赖：Node ≥ 20、Rust stable、git

```bash
npm install
npm run build:sidecar                    # 编译 Node SEA sidecar
cd xlsx-diff-html-tauri && npm install && npm run build
# 输出：src-tauri/target/release/bundle/macos/xlsx-diff-html.app
#        src-tauri/target/release/bundle/dmg/xlsx-diff-html_*.dmg
```

**Windows**（产出 `.exe` / `.msi` 安装包）

依赖：Node ≥ 20、Rust stable（MSVC toolchain）、Git for Windows、WebView2 Runtime（Win10/11 通常已内置）

```powershell
npm install
npm run build:sidecar:win                # 编译 Node SEA sidecar（PowerShell）
cd xlsx-diff-html-tauri; npm install; npm run build
# 输出：src-tauri/target/release/bundle/nsis/xlsx-diff-html_*.exe
#        src-tauri/target/release/bundle/msi/xlsx-diff-html_*.msi
```

**Dev 模式**（sidecar 需先构建一次）：

```bash
# macOS
npm run build:sidecar && cd xlsx-diff-html-tauri && npm run dev

# Windows
npm run build:sidecar:win; cd xlsx-diff-html-tauri; npm run dev
```

## 项目结构

```
lib/                        核心模块（engine.mjs、daff.mjs、git.mjs）
xlsx-diff-html.mjs          CLI 入口
xlsx-diff-html-web/app/
  server.mjs                HTTP 服务（127.0.0.1 + token 鉴权）
  public/                   前端（index.html / app.js / styles.css）
xlsx-diff-html-tauri/
  src-tauri/src/main.rs     Rust 壳（spawn sidecar → WebviewWindow）
  src-tauri/binaries/       Node SEA sidecar（build:sidecar 输出，gitignored）
scripts/
  build-sidecar.sh          macOS/Linux：esbuild → Node SEA → codesign
  build-sidecar.ps1         Windows：esbuild → Node SEA（PowerShell）
```

## 依赖

- `daff@1.4.2` — CSV diff 渲染
- `xlsx` (SheetJS 0.20.3) — xlsx 读取
- `esbuild`、`postject` — sidecar 构建工具（devDependencies）
