#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

struct NodeProcess(Mutex<Option<CommandChild>>);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .manage(NodeProcess(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();

            let ready_file = std::env::temp_dir()
                .join(format!("xlsx-diff-html-ready-{}.url", std::process::id()));

            let server_mjs = server_mjs_path(&handle);
            let root = dirs::home_dir()
                .unwrap_or_else(|| std::env::current_dir().expect("cwd"));
            let node = node_binary();

            eprintln!("[xlsx-diff-html] node={node} server={}", server_mjs.display());

            let (mut rx, child) = handle
                .shell()
                .command(&node)
                .args([server_mjs.to_str().expect("server path")])
                .env("XLSX_DIFF_HTML_READY_FILE", ready_file.to_str().unwrap())
                .env("XLSX_DIFF_HTML_ROOT", root.to_str().unwrap())
                .spawn()
                .expect("failed to spawn node — is node installed?");

            *handle.state::<NodeProcess>().0.lock().unwrap() = Some(child);

            // drain stdout/stderr so node never blocks on a full pipe
            tauri::async_runtime::spawn(async move {
                while rx.recv().await.is_some() {}
            });

            // Wait synchronously for the server ready file (setup() runs on main thread,
            // so the window is created on the main thread too — no threading issues)
            let url = match wait_for_ready_file_sync(&ready_file, Duration::from_secs(20)) {
                Some(u) => u,
                None => {
                    kill_node(&handle);
                    return Err("Node server did not become ready within 20s".into());
                }
            };

            eprintln!("[xlsx-diff-html] server ready: {}", url.trim());

            let web_url: tauri::Url = url.trim().parse()
                .map_err(|e| format!("invalid server URL: {e}"))?;

            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(web_url),
            )
            .title("xlsx-diff-html")
            .inner_size(1280.0, 820.0)
            .min_inner_size(800.0, 600.0)
            .build()?;

            // Kill node when the main window is destroyed
            let handle2 = handle.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Destroyed = event {
                    kill_node(&handle2);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── helpers ──────────────────────────────────────────────────────────────

fn server_mjs_path(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("XLSX_DIFF_HTML_SERVER_MJS") {
        return PathBuf::from(p);
    }
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("server.mjs");
        if p.exists() {
            return p;
        }
    }
    let exe = std::env::current_exe().unwrap_or_default();
    for ancestor in exe.ancestors() {
        let candidate = ancestor.join("xlsx-diff-html-web/app/server.mjs");
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from("xlsx-diff-html-web/app/server.mjs")
}

fn node_binary() -> String {
    if let Ok(p) = std::env::var("XLSX_DIFF_HTML_NODE") {
        if std::path::Path::new(&p).exists() {
            return p;
        }
    }
    // nvm installs node under ~/.nvm/versions/node/<version>/bin/node
    if let Some(home) = dirs::home_dir() {
        let nvm_dir = home.join(".nvm/versions/node");
        if let Ok(rd) = nvm_dir.read_dir() {
            // pick the first version directory
            if let Some(Ok(entry)) = rd.into_iter().next() {
                let candidate = entry.path().join("bin/node");
                if candidate.exists() {
                    return candidate.to_string_lossy().to_string();
                }
            }
        }
    }
    for p in ["/usr/local/bin/node", "/opt/homebrew/bin/node"] {
        if std::path::Path::new(p).exists() {
            return p.to_string();
        }
    }
    "node".to_string()
}

fn kill_node(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<NodeProcess>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}

fn wait_for_ready_file_sync(path: &std::path::Path, timeout: Duration) -> Option<String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if path.exists() {
            return std::fs::read_to_string(path).ok();
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    None
}
