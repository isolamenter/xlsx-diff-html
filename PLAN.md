# 实施计划:bash CLI → Node 移植 + Tauri 套壳

> 目标:把现在「`open` 系统浏览器」的粗糙体验,换成一个轻量原生窗口(系统 WebView),
> 并把唯一不可移植的 bash CLI 移植到 Node,使 CLI 本身三端可跑、Tauri 套壳对三端同一套代码。

## 关键前提(读代码后确认)

`server.mjs` 已经具备 Tauri 套壳所需的全部握手协议,**集成几乎免费**:

- 随机端口:`server.listen(0, '127.0.0.1')`
- 启动时随机生成 `token`
- `READY_FILE` 机制:启动后把完整 URL(含 token)写到 `XLSX_DIFF_HTML_READY_FILE`
- graceful shutdown:已监听 `SIGINT`/`SIGTERM`

前端 `app.js` 用 URL 里的 token 走 fetch,**Tauri 套壳后前端零改动**。

`server.mjs` 里仅有的 Unix 假设(Windows 移植要动的就这些):

- `BASE_PATH` 硬编码 `:` 分隔符与 `/usr/bin /bin /sbin`
- `toolEnv()` 把 `XLSX2CSV` 指向 bash shim
- `ENGINE` 指向 bash shim;`diffFiles` 直接 spawn `vendor/bin/{xlsx2csv,daff}`

---

## 0. 目标架构

```
┌─────────────────────────── Tauri (Rust 壳) ───────────────────────────┐
│  · 启动时 spawn Node sidecar(server.mjs)                              │
│  · 读 READY_FILE 拿到 http://127.0.0.1:<port>/?token=...               │
│  · WebView 窗口加载该 URL(WKWebView/WebView2/WebKitGTK)              │
│  · 窗口关闭 → kill sidecar;单实例锁                                    │
│                                                                        │
│   ┌────────── Node sidecar(现有 server.mjs,跨平台化)──────────┐      │
│   │  HTTP 127.0.0.1 + token  ──►  public/(前端原样)             │      │
│   │           │                                                  │      │
│   │           └─► engine.mjs(由 bash CLI 移植)                 │      │
│   │                   ├─ git(child_process,仍是外部依赖)       │      │
│   │                   ├─ xlsx2csv(import 模块,不再 spawn)      │      │
│   │                   └─ daff(import 模块,不再 spawn)          │      │
│   └──────────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────────┘
```

**核心决策:把三个 bash 可执行(根 `xlsx-diff-html`、`vendor/bin/daff`、`vendor/bin/xlsx2csv`)
全部消灭,改为 Node 模块 in-process 调用。** Windows 上不再依赖 shebang/PATH/shim 解析
(这正是 bash 方案在 Windows 最痛的地方)。`daff@1.4.2` 与 `xlsx`(SheetJS)本就是 JS 库,
有编程 API,直接 `import`。git 仍走 `child_process`(唯一保留的外部依赖)。

---

## 阶段 1 — 把引擎逻辑拆成可导入的 Node 模块

目标:消灭 bash,核心逻辑变成既能 CLI 调用、又能被 `server.mjs` 直接 import 的模块。

新增(建议放根目录 `lib/`):

| 文件 | 内容 | 由谁移植/封装 |
|---|---|---|
| `lib/xlsx2csv.mjs` | `export function xlsxToCsv(input, options): string` | 抽 `vendor/xlsx2csv-node.mjs` 逻辑成导出函数(保留 CLI 入口兼容) |
| `lib/daff.mjs` | `export function csvDiffToHtml(oldCsv, newCsv, opts): string` | 封装 `daff` 库 JS API(替代 spawn `daff.js`) |
| `lib/engine.mjs` | `export async function runDiff({file, mode, options})`、`collectChangedXlsx(repo)` | 移植 447 行 bash 的核心 |
| `xlsx-diff-html.mjs` | 解析 argv → 调 `engine.runDiff`(替代根 `./xlsx-diff-html`) | bash 的参数解析与主流程 |

**bash → Node 逐项对照(engine.mjs 的移植清单):**

| bash 现状 | Node 替代 | 坑 |
|---|---|---|
| `git show HEAD:$file` / `git show :$file` | `spawn('git', [...])` 收 stdout 到 buffer | — |
| `git status --porcelain=v1 -z` 解析 | 按 `\0` split,复用 `server.mjs:parseGitStatus` | null 分隔 + rename 跳一项,server 里已有正确实现,抽出共用 |
| `git ls-files --full-name` / `rev-parse --show-prefix` | `child_process` | 路径分隔符 `\`→`/` 归一 |
| `mktemp -d` | `fs.mkdtemp(os.tmpdir())` | — |
| `cp` / `git show >file` | `fs` 读写 buffer | — |
| `cmp -s a b` | `Buffer.equals` | — |
| `safe_html_name`(`tr`+`sed`) | 等价正则替换 | 保持输出名一致,避免 diff 文件名变化 |
| `open "$html"` | 直接删掉;CLI 模式按平台 `open`/`start`/`xdg-open` | Tauri 下不需要浏览器 |
| `XLSX2CSV` 外部命令 + PATH | `import { xlsxToCsv }`(in-process) | 去掉整个 PATH/shim 依赖 |
| daff via PATH | `import { csvDiffToHtml }`(in-process) | `daff 非0但出了 HTML 只 warn` 的语义在模块里复刻 |

**Windows 增量:** 路径分隔符归一、临时目录用 `os.tmpdir()`、删除 `open`/PATH 假设。

**验证:** 对同一批 `.xlsx` 跑旧 bash 与新 Node,逐字节比对生成的 `*.diff.html`(应完全一致)。

---

## 阶段 2 — 让 server.mjs 跨平台并直连模块

改 `server.mjs`(不动前端):

1. `BASE_PATH`:删硬编码 `/usr/bin` 等与 `:`;改用 `path.delimiter`,只为「找到 `git`」保留系统 PATH。
2. `toolEnv()` / `ENGINE`:不再指向 bash shim。
   - `/api/diff/git`:`import { runDiff }` 直接调用,省掉一次子进程。
   - `/api/diff/files`:`import { xlsxToCsv, csvDiffToHtml }` 直接调用,去掉 spawn。
3. 删除 `vendor/bin/{daff,xlsx2csv}` 两个 bash shim 与 `XLSX2CSV` 环境约定(同步更新 CLAUDE.md)。
4. 复核 Windows 路径安全:`isInside`、`assertRelativePath`(已拒 `\`,Win 上确认不误伤盘符)、
   `realpath`(大小写不敏感卷)。**安全关键,Win 上必须单测。**

**Windows 增量:** 上述 1、4。mac/Linux 下这步基本是「删代码 + 改 import」。

---

## 阶段 3 — Tauri v2 套壳

新建 `xlsx-diff-html-tauri/`(独立于现有 web 目录):

1. `src-tauri/`(Rust)极薄,只做四件事:
   - spawn sidecar:`tauri-plugin-shell` 跑 Node + `server.mjs`,注入
     `XLSX_DIFF_HTML_READY_FILE`、`XLSX_DIFF_HTML_ROOT`。
   - 读 ready 文件拿到 URL(含 token),`WebviewWindow` 加载。
   - 生命周期:窗口关闭/退出 → 给 sidecar 发 SIGTERM;`tauri-plugin-single-instance` 防多开。
   - 兜底:sidecar 起不来时显示错误页。
2. 前端零改动——直接加载 localhost,不用 Tauri IPC(避免 CSP/remote-IPC 复杂度)。
3. 安全维持现状:仍是 `127.0.0.1` + token。

**Windows 增量:** WebView2 runtime(Win10/11 多自带,Tauri 可 bootstrap);
关窗确实杀掉 node 的进程树行为要确认。

---

## 阶段 4 — 打包与运行时内嵌(每平台)

1. 内嵌 Node:推荐 **Node SEA(单可执行)** 或 `bun build --compile` 把 `server.mjs`+依赖编成单文件,
   作为 Tauri sidecar(命名带 target triple),免去单独发 `node` 与 `node_modules`。
   备选:带 `vendor/node/<platform>` 二进制(体积大、每平台一份)。
2. git 依赖:声明前置要求(Windows 装 Git for Windows);不内嵌 portable git。
3. 签名(可后置,当前 CLAUDE.md 明确暂不碰):mac 公证 / Windows 代码签名两套;首版可发未签名。

**Windows 增量:** Node 单可执行的 Windows target、`.msi`/`.exe` 打包、(可选)签名。

---

## 工作量汇总

| 阶段 | mac / mac+Linux | +Windows 增量 |
|---|---|---|
| 1 引擎模块化移植 | 1–2 天(三端共享,本来就该做) | 路径/临时目录归一,含在内 |
| 2 server 直连+跨平台 | 0.5 天 | +0.5 天(路径安全单测) |
| 3 Tauri 套壳 | 1 天 | +0.5 天(WebView2/进程树) |
| 4 打包内嵌 | 0.5–1 天 | +0.5–1 天(Win target/签名) |

**MVP 路线:** 阶段 1+2+3 跑通 mac 即得「精致本地 App」;Windows 只是在已模块化基础上多配
一条打包管线,无逻辑级返工。

---

## 待拍板

1. 阶段 1 走「in-process 模块」(推荐,Windows 更友好、省子进程),还是先「bash→Node 1:1 直译、
   仍 spawn 子进程」的低风险版?
2. 核心逻辑放根 `lib/`(倾向),还是放进 `xlsx-diff-html-web/app/`?
3. Windows 这次做还是先不做(计划已让它退化成纯打包活儿,可阶段 1–3 先只验 mac)。
