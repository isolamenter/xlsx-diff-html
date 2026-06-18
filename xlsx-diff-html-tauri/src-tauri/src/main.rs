#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::{process::CommandChild, ShellExt};

struct NodeProcess(Mutex<Option<CommandChild>>);

#[tauri::command]
async fn pick_native_path(app: tauri::AppHandle, kind: String) -> Result<Option<String>, String> {
    let dialog = app.dialog().file();
    let selected = match kind.as_str() {
        "folder" => dialog.blocking_pick_folder(),
        "file" => dialog
            .add_filter("Excel Files", &["xlsx"])
            .blocking_pick_file(),
        _ => return Err("kind must be 'folder' or 'file'".into()),
    };

    selected
        .map(|file_path| {
            file_path
                .into_path()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|error| error.to_string())
        })
        .transpose()
}

/// Parse `--compare LOCAL REMOTE` or bare two-positional-arg form (`LOCAL REMOTE`).
fn find_compare_files() -> Option<(String, String)> {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // --compare LOCAL REMOTE
    if let Some(i) = args.iter().position(|a| a == "--compare") {
        if i + 2 < args.len() {
            return Some((args[i + 1].clone(), args[i + 2].clone()));
        }
    }

    // Two positional (non-flag) args — what Git GUI clients pass as `$LOCAL $REMOTE`
    let pos: Vec<&str> = args
        .iter()
        .filter(|a| !a.starts_with('-'))
        .map(String::as_str)
        .collect();
    if pos.len() == 2 {
        return Some((pos[0].to_string(), pos[1].to_string()));
    }

    None
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![pick_native_path])
        .manage(NodeProcess(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();

            let ready_file = std::env::temp_dir()
                .join(format!("xlsx-diff-html-ready-{}.url", std::process::id()));

            let root = dirs::home_dir().unwrap_or_else(|| std::env::current_dir().expect("cwd"));

            let cmd = handle
                .shell()
                .sidecar("server")
                .expect("sidecar 'server' not found — run: npm run build:sidecar")
                .env("XLSX_DIFF_HTML_READY_FILE", ready_file.to_str().unwrap())
                .env("XLSX_DIFF_HTML_ROOT", root.to_str().unwrap());

            let cmd = match find_compare_files() {
                Some((local, remote)) => cmd
                    .env("XLSX_DIFF_LOCAL", &local)
                    .env("XLSX_DIFF_REMOTE", &remote),
                None => cmd,
            };

            let cmd = match find_public_dir(&handle) {
                Some(pd) => cmd.env("XLSX_PUBLIC_DIR", pd.to_string_lossy().as_ref()),
                None => cmd,
            };

            let (mut rx, child) = cmd.spawn().expect("failed to spawn server sidecar");

            *handle.state::<NodeProcess>().0.lock().unwrap() = Some(child);

            // Drain stdout/stderr so the sidecar never blocks on a full pipe
            tauri::async_runtime::spawn(async move { while rx.recv().await.is_some() {} });

            let url = match wait_for_ready_file_sync(&ready_file, Duration::from_secs(20)) {
                Some(u) => u,
                None => {
                    kill_node(&handle);
                    return Err("Node server did not become ready within 20s".into());
                }
            };

            eprintln!("[xlsx-diff-html] server ready: {}", url.trim());

            let web_url: tauri::Url = url
                .trim()
                .parse()
                .map_err(|e| format!("invalid server URL: {e}"))?;

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(web_url))
                .title("xlsx-diff-html")
                .inner_size(1280.0, 820.0)
                .min_inner_size(800.0, 600.0)
                .build()?;

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

/// Returns the `public/` directory for the Node server.
/// In release: Resources/public/ (from the .app bundle).
/// In dev: walks up from the exe to find the source tree's public/.
fn find_public_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("public");
        if p.exists() {
            return Some(p);
        }
    }
    let exe = std::env::current_exe().unwrap_or_default();
    for ancestor in exe.ancestors() {
        let p = ancestor.join("xlsx-diff-html-web/app/public");
        if p.exists() {
            return Some(p);
        }
    }
    None
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
