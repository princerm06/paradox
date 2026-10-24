fn main() {
    // App commands get generated permissions (allow-select-repository) so a
    // capability can grant exactly this one command to the remote studio page.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["select_repository"])),
    )
    .expect("tauri build script");
}
