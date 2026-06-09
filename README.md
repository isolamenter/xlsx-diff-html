# xlsx-diff-html

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2020-blue.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux-lightgrey.svg)](#)

[English](#english) | [中文说明](#中文说明)

---

## English

A powerful and user-friendly tool to generate clean, readable HTML diffs for `.xlsx` files in Git repositories, making spreadsheet version control and code reviews simple. It supports a **CLI tool**, a **Web UI**, and a native **Tauri desktop application**.

```
Data Flow: XLSX → xlsx2csv (SheetJS) → CSV → daff → HTML (Side-by-Side View)
```

### Key Features
* 🔍 **Git Integration**: Diff spreadsheet changes directly from Git status (working tree vs HEAD or staged index vs HEAD).
* 📂 **Direct Comparison**: Compare any two local `.xlsx` files directly without Git context.
* 💻 **Interactive Web UI**: A clean, local web portal with secure token authentication for visual comparison.
* 🖥️ **Tauri Desktop App**: Cross-platform desktop application built using Tauri v2 and a compiled Node.js SEA (Single Executable Application) sidecar.
* ⚙️ **Advanced Normalization**: 
  * Avoid false diffs caused by Excel date display formatting using date formatting normalization (defaulting to `yyyy-mm-dd`).
  * Option to skip hidden rows and columns, ignore empty rows, or compare raw cell values.
  * Side-by-side synchronized scrolling HTML rendering.

---

### Installation & Quick Start

First, clone the repository and install the dependencies:
```bash
git clone https://github.com/yourusername/xlsx-diff-html.git
cd xlsx-diff-html
npm install
```

#### 1. CLI Usage
Run the CLI tool directly from the repository root:

```bash
# Compare all changed xlsx files in the current Git status
node xlsx-diff-html.mjs --changed

# Compare a specific tracked xlsx file (HEAD vs working tree)
node xlsx-diff-html.mjs path/to/file.xlsx

# Compare a specific file in the staged index (HEAD vs staged index)
node xlsx-diff-html.mjs --staged path/to/file.xlsx

# Compare two arbitrary files directly (external difftool mode)
node xlsx-diff-html.mjs --compare local.xlsx remote.xlsx
```

**Common CLI Options:**
* `--all`: Export and compare every sheet in the workbook (default).
* `--sheet N`: Export only sheet `N` (1-based index).
* `--staged`: Compare `HEAD` against the staged index instead of the working tree.
* `--changed`: Batch process all changed `.xlsx` files reported by `git status`.
* `--ignore-empty`: Drop empty rows from the spreadsheet comparison.
* `--skip-hidden`: Exclude rows and columns hidden in the sheet (keeps them by default).
* `--raw`: Export raw values instead of formatted display strings.
* `--date-format <format>`: Render dates using an Excel format code (e.g., `yyyy-mm-dd`). Use `""` to retain individual cells' display formatting.
* `--output <path>`: Output HTML path. If batching multiple files, this must be a directory.
* `--no-open`: Do not automatically launch the browser to view the HTML diff.

---

#### 2. Web UI Mode
Run a local, lightweight server to browse repository changes and compare files interactively in your browser:

```bash
# Start the web server pointing to the repository root
XLSX_DIFF_HTML_ROOT="$PWD" node xlsx-diff-html-web/app/server.mjs
```
The server will boot and print a URL containing a secure, randomly generated access token:
`xlsx-diff-html web server listening on http://127.0.0.1:<port>/?token=<token>`

* **Security Note**: All endpoint accesses and static files are protected by the dynamic session token to prevent unauthorized local file access.

---

#### 3. Tauri Desktop Application
The Tauri app embeds the Web UI with a built-in Node.js server running as a Single Executable Application (SEA) sidecar.

##### macOS (produces `.app` / `.dmg`)
Ensure Node.js ≥ 20, Rust stable, and Git are installed:
```bash
npm install
npm run build:sidecar                    # Bundles and signs the Node SEA binary
cd xlsx-diff-html-tauri && npm install && npm run build
# Outputs in: src-tauri/target/release/bundle/
```

##### Windows (produces `.exe` / `.msi`)
Ensure Node.js ≥ 20, Rust stable (MSVC toolchain), Git, and WebView2 Runtime are installed:
```powershell
npm install
npm run build:sidecar:win                # PowerShell script for Windows Node SEA bundling
cd xlsx-diff-html-tauri; npm install; npm run build
# Outputs in: src-tauri/target/release/bundle/
```

##### Run Desktop App in Dev Mode:
```bash
# Build the sidecar once, then launch Tauri dev environment
# macOS
npm run build:sidecar && cd xlsx-diff-html-tauri && npm run dev
# Windows
npm run build:sidecar:win; cd xlsx-diff-html-tauri; npm run dev
```

---

## 中文说明

将 Git 仓库中变更的 `.xlsx` 表格文件转换为直观、易读的 HTML 对比视图，极大地方便了表格文件的代码审查（Code Review）与版本控制。本项目提供 **CLI 工具**、**Web 浏览器界面** 以及 **Tauri 桌面应用**。

```
数据流向：XLSX → xlsx2csv (SheetJS) → CSV → daff 对比 → HTML (双栏/单栏对比)
```

### 主要特性
* 🔍 **Git 深度整合**：直接比对 Git 暂存区或工作区中发生改动的表格。
* 📂 **任意文件比对**：无需 Git 环境，也可以直接比对本地任意两个 `.xlsx` 文件（如作为外部 difftool 运行）。
* 💻 **本地 Web 控制台**：支持中英双语，提供目录文件浏览、暂存区/工作区比对切换与动态选项调整。
* 🖥️ **Tauri 桌面客户端**：基于 Rust & Webview 封装，侧边进程（sidecar）利用 Node SEA 编译成单可执行二进制，无需用户全局安装 Node。
* ⚙️ **假差异过滤与格式归一化**：
  * **日期格式归一化**：支持设置统一的日期显示编码（默认 `yyyy-mm-dd`），避免因 Excel 内部格式改动产生大量无意义差异。
  * 可选跳过隐藏行、隐藏列或忽略空行，使 diff 更加干净。
  * 支持双栏同步滚动的高亮对比页面。

---

### 安装与快速上手

克隆仓库并安装开发依赖：
```bash
git clone https://github.com/yourusername/xlsx-diff-html.git
cd xlsx-diff-html
npm install
```

#### 1. CLI 命令行工具
在项目根目录使用 Node 直接运行：

```bash
# 对 git status 里所有发生变更的 .xlsx 表格生成 diff html
node xlsx-diff-html.mjs --changed

# 比对指定文件（HEAD vs 工作区）
node xlsx-diff-html.mjs 相对路径/file.xlsx

# 比对已暂存的文件（HEAD vs 暂存区）
node xlsx-diff-html.mjs --staged 相对路径/file.xlsx

# 外部差异工具模式：直接比对任意两个本地 xlsx 文件
node xlsx-diff-html.mjs --compare local.xlsx remote.xlsx
```

**常用命令行选项：**
* `--all`：导出并比对工作簿内的所有 sheet（默认行为）。
* `--sheet N`：只导出第 `N` 个 sheet（从 1 开始）。
* `--staged`：对比 HEAD 和暂存区，而不是工作区。
* `--changed`：自动扫描 `git status` 并对所有变更的 `.xlsx` 进行批量比对。
* `--ignore-empty`：比对时过滤掉所有的空行。
* `--skip-hidden`：跳过隐藏的行和列（默认保留）。
* `--raw`：导出单元格的原始数值，而不是 Excel 格式化后的文本。
* `--date-format <格式>`：将日期归一化为指定 Excel 格式（如 `yyyy-mm-dd`）。传空字符串 `""` 则保持单元格原样格式。
* `--output <路径>`：输出的 HTML 路径。如果是批量比对，这必须是一个目录。
* `--no-open`：生成 HTML 后不自动在浏览器中打开。

---

#### 2. 本地 Web 服务
启动一个轻量级的本地 HTTP 服务，可以在浏览器中以可视化界面操作比对：

```bash
# 指定对比的根目录并启动服务
XLSX_DIFF_HTML_ROOT="$PWD" node xlsx-diff-html-web/app/server.mjs
```
控制台将输出包含随机安全 Token 的访问链接：
`xlsx-diff-html web server listening on http://127.0.0.1:<port>/?token=<token>`

* **安全说明**：为了防止本地敏感文件泄露，所有 API 及资源访问均受到该 Token 保护，且只允许访问 `XLSX_DIFF_HTML_ROOT` 目录内的 `.xlsx` 文件，防止跨目录路径逃逸。

---

#### 3. Tauri 桌面客户端编译
客户端将 Node 服务通过 Node SEA 注入二进制打包成无需依赖的桌面应用。

##### macOS 编译（产出 `.app` / `.dmg`）
确保系统安装有 Node.js ≥ 20, Rust stable 以及 git：
```bash
npm install
npm run build:sidecar                    # 编译并签名 Node SEA 侧边可执行程序
cd xlsx-diff-html-tauri && npm install && npm run build
# 产出目录: src-tauri/target/release/bundle/
```

##### Windows 编译（产出 `.exe` / `.msi` 安装包）
确保系统安装有 Node.js ≥ 20, Rust stable (MSVC 工具链), Git 以及 WebView2 Runtime：
```powershell
npm install
npm run build:sidecar:win                # Windows 下编译 Node SEA 侧边进程
cd xlsx-diff-html-tauri; npm install; npm run build
# 产出目录: src-tauri/target/release/bundle/
```

##### 开发调试模式 (Dev)：
```bash
# macOS
npm run build:sidecar && cd xlsx-diff-html-tauri && npm run dev
# Windows
npm run build:sidecar:win; cd xlsx-diff-html-tauri; npm run dev
```

---

## Project Structure / 项目结构

```
├── lib/                     # Core business logic / 核心比对与 Git 提取模块
│   ├── engine.mjs           # CSV extraction & diff workflow / xlsx转CSV与工作流处理
│   ├── daff.mjs             # Daff layout mapping & HTML renderer / 渲染单双栏HTML
│   └── git.mjs              # Git process wrapper / Git子进程管道通信
├── xlsx-diff-html.mjs       # CLI Tool Entrypoint / 命令行工具入口
├── xlsx-diff-html-web/      # Web Control Center / 浏览器控制中心
│   └── app/                 
│       ├── server.mjs       # Local Node.js server with token auth / 带安全认证的 HTTP 服务
│       └── public/          # SPA Client (HTML/CSS/JS) / 前端静态页面
├── xlsx-diff-html-tauri/    # Desktop client wrapper / 桌面客户端外壳
│   ├── src-tauri/src/       # Tauri rust entrypoint / Rust 窗口管理器
│   └── src-tauri/Cargo.toml # Cargo configs / Rust 依赖管理
├── scripts/                 # Bundling scripts / Node SEA 打包注入脚本
└── LICENSE                  # Open source license (MIT) / 开源协议说明文件
```

---

## Tech Stack & Core Libraries / 技术栈与核心依赖

* **[daff](https://github.com/paulfitz/daff)**: Version control and synchronization library for tables/spreadsheets.
* **[xlsx (SheetJS)](https://sheetjs.com/)**: Reading and parsing `.xlsx` workbooks.
* **[esbuild](https://esbuild.github.io/)** & **[postject](https://github.com/nodejs/postject)**: Packaging client sidecar into Node.js SEA (Single Executable Applications).
* **[Tauri v2](https://tauri.app/)**: Desktop app framework.

---

## License / 开源协议

This project is licensed under the [MIT License](LICENSE).
