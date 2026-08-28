fn main() {
  tauri_build::try_build(
    tauri_build::Attributes::new().app_manifest(
      tauri_build::AppManifest::new().commands(&[
        "native_info",
        "read_desktop_url",
        "write_desktop_url",
        "clear_desktop_url",
        "open_external_url",
        "open_worktree_folder",
        "set_menu_bar_mode",
      ]),
    ),
  )
  .expect("failed to build LiveTree app metadata")
}
