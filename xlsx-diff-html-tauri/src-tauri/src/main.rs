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

fn as_compare_args(args: Vec<String>) -> Option<Vec<String>> {
    if args.len() == 2 && args.iter().all(|arg| !arg.starts_with('-')) {
        return Some(args);
    }
    None
}

/// Return CLI-compatible arguments for external diff mode.
fn find_compare_args() -> Option<Vec<String>> {
    as_compare_args(std::env::args().skip(1).collect())
}

fn run_external_diff(args: Vec<String>) -> ! {
    let executable = std::env::current_exe().expect("failed to locate application executable");
    let sidecar = executable
        .parent()
        .expect("application executable has no parent directory")
        .join(format!("server{}", std::env::consts::EXE_SUFFIX));
    let invocation_cwd = std::env::current_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();

    let status = std::process::Command::new(sidecar)
        .args(args)
        .env("XLSX_DIFF_HTML_ONESHOT", "1")
        .env("XLSX_DIFF_INVOCATION_CWD", invocation_cwd)
        .status();

    match status {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("Error: failed to run external diff sidecar: {error}");
            std::process::exit(1);
        }
    }
}

fn main() {
    if let Some(args) = find_compare_args() {
        run_external_diff(args);
    }

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

#[cfg(test)]
mod tests {
    use super::as_compare_args;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn detects_bare_compare_mode() {
        assert!(as_compare_args(args(&["old.xlsx", "new.xlsx"])).is_some());
    }

    #[test]
    fn rejects_options_and_non_compare_invocations() {
        assert!(as_compare_args(Vec::new()).is_none());
        assert!(as_compare_args(args(&["--no-open"])).is_none());
        assert!(as_compare_args(args(&["--compare", "old.xlsx", "new.xlsx"])).is_none());
        assert!(as_compare_args(args(&["--no-open", "old.xlsx", "new.xlsx"])).is_none());
    }
}
