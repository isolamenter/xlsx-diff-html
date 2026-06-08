# CLAUDE.md

`.xlsx` 文件的 Git diff 工具：把表格转成 CSV，再用 `daff` 渲染成 HTML diff。

## 组成

数据流：`xlsx → xlsx2csv → CSV → daff → HTML`

- **CLI** — `xlsx-diff-html.mjs`（根目录，Node ES 模块）。比较 Git 仓库里改动的 `.xlsx`，对每个文件生成 `*.diff.html`。
- **lib/** — 核心模块：`engine.mjs`（runDiff、xlsxBufferToCsv）、`daff.mjs`（csvDiffToHtml）、`git.mjs`（spawnGit、parseGitStatus）。
- **Web UI** — `xlsx-diff-html-web/app/`
  - `server.mjs` — 仅监听 `127.0.0.1` 的 Node HTTP 服务，启动时随机生成 `token`，所有 `/api/*` 与 `/diff/*` 请求都要带 token。直接 import `lib/` 模块，无子进程依赖（git 除外）。
  - `public/` — 前端 `index.html` / `app.js` / `styles.css`（中英双语）。
- **Tauri 桌面 App** — `xlsx-diff-html-tauri/`
  - `src-tauri/src/main.rs` — Rust 壳：spawn Node SEA sidecar，读 ready file 拿 URL，WebviewWindow 加载。
  - sidecar 二进制 `src-tauri/binaries/server-<triple>` 由 `npm run build:sidecar` 生成（esbuild 打包 + Node SEA 编译）。

## 依赖

- Node ≥ 20（已在 v20.19.6 验证）
- npm 依赖：`daff@1.4.2`、`xlsx`(SheetJS，从 CDN tarball 装)，`npm install` 后在 `node_modules/` 下可用。
- Tauri 构建链：Rust stable、`@tauri-apps/cli`（在 `xlsx-diff-html-tauri/` 下 `npm install` 安装）。

## 本地运行（dev，已验证）

CLI：

```bash
npm install
node xlsx-diff-html.mjs --changed   # 比较 git status 报告的所有改动 .xlsx
# 也可：node xlsx-diff-html.mjs [options] FILE.xlsx [FILE2.xlsx ...]
```

Web 服务：

```bash
XLSX_DIFF_HTML_ROOT="$PWD" node xlsx-diff-html-web/app/server.mjs
# 打印形如 http://127.0.0.1:<port>/?token=<token> 的地址
```

Tauri 桌面 App（先构建 sidecar，再 `tauri dev` 或 `tauri build`）：

```bash
npm run build:sidecar                        # 生成 Node SEA 二进制
cd xlsx-diff-html-tauri && npm run dev       # dev 模式
cd xlsx-diff-html-tauri && npm run build     # 生产构建 → src-tauri/target/release/bundle/
```

## CLI 关键行为

- `cd` 到 `git rev-parse --show-toplevel`，文件路径相对仓库根解析。
- 默认比较 `HEAD vs 工作区`；`--staged` 改为 `HEAD vs 暂存区`。
- `--changed` 用 `git status --porcelain=v1 -z --untracked-files=all -- '*.xlsx'` 收集改动文件。
- 缺省单文件输出到 `<git-dir>/xlsx-diff-html/<safe-name>.diff.html`；`--output` 可指定文件(单输入)或目录(多输入)。
- 默认 `--open` 用 `open` 打开浏览器；脚本/服务调用应传 `--no-open`。
- 默认导出第 1 个 sheet；`--all` 导出全部、`--sheet N` 指定；默认保留隐藏行列，`--skip-hidden` 跳过。
- **日期默认归一化为 `yyyy-mm-dd`**（`date_format` 默认即 `yyyy-mm-dd`），好处是忽略「仅日期显示格式变化」的假 diff。`--date-format <code>` 换其他 Excel 格式码；`--date-format ""`（空串）则保留每个单元格自身的显示格式。Web 端对应：`#dateFormat` 输入框预填 `yyyy-mm-dd`，清空=保留原格式；`server.mjs` 的 `readDiffOptions` 在未传 `dateFormat` 时也回退到 `yyyy-mm-dd`。
- daff 返回非 0 但仍生成了 HTML 时只 warn 不报错。

## Web 服务端点（均需 token）

- `GET /api/root` — 根路径与平台信息
- `GET /api/list?path=` — 列目录（`.xlsx` 文件 + 子目录，标记 `hasGit`）
- `GET /api/repo/status?repo=&mode=working|staged` — 仓库里改动的 `.xlsx`
- `POST /api/diff/git` — 对仓库内某文件做 HEAD vs 工作区/暂存区 diff（直接调 `lib/engine.mjs:runDiff`）
- `POST /api/diff/files` — 任意两个 `.xlsx` 文件对比（直接调 `xlsxBufferToCsv` + `csvDiffToHtml`）
- `GET /diff/<id>` — 取生成的 HTML

安全约束：所有路径都限制在 `XLSX_DIFF_HTML_ROOT` 内（`isInside` + `realpath` 双重校验，拒绝 `..`、绝对路径、符号链接逃逸）；只接受 `.xlsx`。改路径处理时务必保持这些校验。

## 约定

- 回答用中文或英文。
- 改动 diff 逻辑 → `lib/engine.mjs`；改 UI/HTTP → `xlsx-diff-html-web/app/server.mjs`。两个 `*.diff` 行为应保持一致（CLI 与 web 均调同一 `runDiff`）。
- 改 Tauri 壳 → `xlsx-diff-html-tauri/src-tauri/src/main.rs`；改 sidecar 构建 → `scripts/build-sidecar.sh`。
