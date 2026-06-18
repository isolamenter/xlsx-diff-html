fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&["pick_native_path"]));
    tauri_build::try_build(attributes).expect("failed to run Tauri build script");
}
