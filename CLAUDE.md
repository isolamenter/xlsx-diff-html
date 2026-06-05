# CLAUDE.md

`.xlsx` 文件的 Git diff 工具：把表格转成 CSV，再用 `daff` 渲染成 HTML diff。

> **当前关注范围：仅 CLI 与 Web(HTML) 两部分。macOS `.app` / DMG 打包暂时全部忽略**
> （即 `scripts/build-dmg.sh`、`.app` bundle、`vendor/node`、`vendor/daff` 的内嵌与签名/公证，目前都不在工作范围内）。

## 组成

数据流：`xlsx → xlsx2csv → CSV → daff → HTML`

- **CLI** — `./xlsx-diff-html`（根目录，bash 脚本，是真正的引擎）。比较 Git 仓库里改动的 `.xlsx`，对每个文件生成 `*.diff.html`。
- **Web UI** — `xlsx-diff-html-web/app/`
  - `server.mjs` — 仅监听 `127.0.0.1` 的 Node HTTP 服务，启动时随机生成 `token`，所有 `/api/*` 与 `/diff/*` 请求都要带 token。
  - `public/` — 前端 `index.html` / `app.js` / `styles.css`（中英双语）。
  - `bin/xlsx-diff-html` — **薄壳**，只是 `exec` 到根目录的 CLI 引擎（不要在这里加逻辑）。
  - `vendor/xlsx2csv-node.mjs` — 基于 SheetJS(`xlsx`) 的 `xlsx2csv` 实现，输出 Excel 显示文本（`--raw` 才输出原始值）。
  - `vendor/bin/{xlsx2csv,daff}` — 包装脚本，优先用内嵌 node，dev 下回退到系统 node / 环境变量。

CLI 与 web shim 的 `bin/xlsx-diff-html` **不是同一个文件**：根目录那个是完整引擎，web 下那个只是转发。改 diff 行为请改根目录的 `./xlsx-diff-html`。

## 依赖

- Node ≥ 20（已在 v20.19.6 验证）
- npm 依赖：`daff@1.4.2`、`xlsx`(SheetJS，从 CDN tarball 装)，`npm install` 后在 `node_modules/.bin/` 下有 `daff`。
- 没有单独的全局 `xlsx2csv`，它就是 `vendor/xlsx2csv-node.mjs`（导入 `xlsx`）。

## 本地运行（dev，已验证）

CLI（根 CLI 需要 PATH 里有 `daff`，并通过 `XLSX2CSV` 指向转换器）：

```bash
npm install
XLSX2CSV="$PWD/xlsx-diff-html-web/app/vendor/bin/xlsx2csv" \
PATH="$PWD/node_modules/.bin:$PATH" \
./xlsx-diff-html --changed            # 比较 git status 报告的所有改动 .xlsx
# 也可： ./xlsx-diff-html [options] FILE.xlsx [FILE2.xlsx ...]
```

Web 服务（dev 下没有内嵌 node/daff，需用环境变量回退）：

```bash
XLSX_DIFF_HTML_DEV_DAFF="$PWD/node_modules/.bin/daff" \
XLSX_DIFF_HTML_ROOT="$PWD" \
node xlsx-diff-html-web/app/server.mjs
# 打印形如 http://127.0.0.1:<port>/?token=<token> 的地址
```

- `server.mjs` 经 `bin/xlsx-diff-html` shim 调到根 CLI；`xlsx2csv-node.mjs` 通过 Node 模块解析向上找到根 `node_modules/xlsx`，所以 dev 下无需内嵌 vendor。
- `vendor/bin/daff` 在 dev 没有内嵌 node 时不会自动回退到 `node_modules`，必须设 `XLSX_DIFF_HTML_DEV_DAFF`。

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
- `POST /api/diff/git` — 对仓库内某文件做 HEAD vs 工作区/暂存区 diff（内部调根 CLI）
- `POST /api/diff/files` — 任意两个 `.xlsx` 文件对比（直接调 `xlsx2csv` + `daff`）
- `GET /diff/<id>` — 取生成的 HTML

安全约束：所有路径都限制在 `XLSX_DIFF_HTML_ROOT` 内（`isInside` + `realpath` 双重校验，拒绝 `..`、绝对路径、符号链接逃逸）；只接受 `.xlsx`。改路径处理时务必保持这些校验。

## 约定

- 回答用中文或英文。
- 改动 diff 逻辑 → 根 `./xlsx-diff-html`；改 UI/HTTP → `xlsx-diff-html-web/app/`。两个 `*.diff` 行为应保持一致（CLI 与 web 选项映射见 `server.mjs` 的 `diffArgsFromOptions` / `convertXlsx`）。
- 暂不要碰 DMG/`.app`/签名相关代码。
