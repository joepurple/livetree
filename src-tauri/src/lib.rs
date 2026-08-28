#[cfg(desktop)]
use serde::Deserialize;
use serde::Serialize;
use std::{fs, sync::Mutex};
use tauri::{Emitter, Manager};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSWindow, NSWindowButton};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSRect, NSSize};
#[cfg(target_os = "macos")]
use tauri::{
  menu::{Menu, MenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  window::Color,
  LogicalSize, PhysicalPosition, PhysicalSize,
};
#[cfg(target_os = "macos")]
use tauri_plugin_positioner::{Position, WindowExt};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_opener::OpenerExt;
#[cfg(desktop)]
use std::{
  env,
  io::{Read, Write},
  net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream},
  path::PathBuf,
  process::Command,
  thread,
  time::Duration,
};
#[cfg(desktop)]
use tauri::RunEvent;

#[cfg(desktop)]
use tauri_plugin_shell::{
  process::{CommandChild, CommandEvent},
  ShellExt,
};

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum NativeServerMode {
  Starting,
  Background,
  Bundled,
  #[default]
  Disconnected,
  Error,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeInfo {
  platform: String,
  server_mode: NativeServerMode,
  server_url: Option<String>,
  tailnet_url: Option<String>,
  error: Option<String>,
  menu_bar_mode: bool,
}

struct AppState {
  info: Mutex<NativeInfo>,
  #[cfg(target_os = "macos")]
  regular_window_placement: Mutex<Option<WindowPlacement>>,
  #[cfg(desktop)]
  child: Mutex<Option<CommandChild>>,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
struct WindowPlacement {
  /// AppKit's complete decorated frame, in its native coordinate system.
  frame: NSRect,
  maximized: bool,
}

#[cfg(target_os = "macos")]
fn appkit_window<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<&NSWindow, String> {
  let pointer = window.ns_window().map_err(|error| error.to_string())?.cast::<NSWindow>();
  if pointer.is_null() {
    return Err("Could not access the native LiveTree window.".into());
  }
  // Tauri owns this NSWindow for at least as long as the borrowed
  // WebviewWindow, so the native pointer is valid for this borrow.
  Ok(unsafe { &*pointer })
}

#[cfg(target_os = "macos")]
fn set_appkit_window_frame<R: tauri::Runtime>(
  window: &tauri::WebviewWindow<R>,
  frame: NSRect,
  window_buttons_visible: bool,
) -> Result<(), String> {
  let native_window = window.clone();
  window
    .run_on_main_thread(move || match appkit_window(&native_window) {
      Ok(window) => {
        for button in [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton] {
          if let Some(button) = window.standardWindowButton(button) {
            button.setHidden(!window_buttons_visible);
          }
        }
        window.setFrame_display(frame, true);
      }
      Err(error) => log::error!("Unable to update the native LiveTree window: {error}"),
    })
    .map_err(|error| error.to_string())
}

impl Default for AppState {
  fn default() -> Self {
    Self {
      info: Mutex::new(NativeInfo {
        platform: if cfg!(target_os = "ios") { "ios" } else { "macos" }.into(),
        server_mode: if cfg!(target_os = "ios") { NativeServerMode::Disconnected } else { NativeServerMode::Starting },
        menu_bar_mode: false,
        ..NativeInfo::default()
      }),
      #[cfg(target_os = "macos")]
      regular_window_placement: Mutex::new(None),
      #[cfg(desktop)]
      child: Mutex::new(None),
    }
  }
}

#[tauri::command]
fn native_info(state: tauri::State<'_, AppState>) -> NativeInfo {
  state.info.lock().expect("native info lock poisoned").clone()
}

fn desktop_url_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
  app.path().app_data_dir().map(|directory| directory.join("desktop-url")).map_err(|error| error.to_string())
}

fn menu_bar_mode_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
  app.path().app_data_dir().map(|directory| directory.join("menu-bar-mode")).map_err(|error| error.to_string())
}

fn read_menu_bar_mode(app: &tauri::AppHandle) -> Result<bool, String> {
  match fs::read_to_string(menu_bar_mode_file(app)?) {
    Ok(value) => Ok(value.trim() == "true"),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
    Err(error) => Err(error.to_string()),
  }
}

fn write_menu_bar_mode(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
  let path = menu_bar_mode_file(app)?;
  let directory = path.parent().ok_or_else(|| "Could not resolve app data directory.".to_string())?;
  fs::create_dir_all(directory).map_err(|error| error.to_string())?;
  let temporary = path.with_extension("tmp");
  fs::write(&temporary, enabled.to_string()).map_err(|error| error.to_string())?;
  fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
const MENU_BAR_TRAY_ID: &str = "livetree-menu-bar";

#[cfg(target_os = "macos")]
fn show_main_window(app: &tauri::AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    if app.state::<AppState>().info.lock().expect("native info lock poisoned").menu_bar_mode {
      let _ = window.move_window(Position::TrayCenter);
    }
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
  }
}

#[cfg(target_os = "macos")]
fn compact_main_window(app: &tauri::AppHandle) -> Result<(), String> {
  let Some(window) = app.get_webview_window("main") else {
    return Err("Could not find the LiveTree window.".into());
  };
  let state = app.state::<AppState>();
  let mut placement = state.regular_window_placement.lock().expect("window placement lock poisoned");
  if placement.is_none() {
    *placement = Some(WindowPlacement {
      frame: appkit_window(&window)?.frame(),
      maximized: window.is_maximized().map_err(|error| error.to_string())?,
    });
  }
  let regular_frame = placement.as_ref().expect("regular window placement was just initialized").frame;
  drop(placement);

  window.unmaximize().map_err(|error| error.to_string())?;
  let compact_frame = NSRect::new(regular_frame.origin, NSSize::new(468.0, 758.0));
  set_appkit_window_frame(&window, compact_frame, false)?;
  window.set_resizable(false).map_err(|error| error.to_string())?;
  window.set_maximizable(false).map_err(|error| error.to_string())?;
  window.set_minimizable(false).map_err(|error| error.to_string())?;
  window.set_always_on_top(true).map_err(|error| error.to_string())?;
  window.set_visible_on_all_workspaces(true).map_err(|error| error.to_string())?;
  window.set_background_color(Some(Color(0, 0, 0, 0))).map_err(|error| error.to_string())?;
  window.set_shadow(false).map_err(|error| error.to_string())?;
  Ok(())
}

#[cfg(target_os = "macos")]
fn restore_main_window(app: &tauri::AppHandle) -> Result<(), String> {
  let Some(window) = app.get_webview_window("main") else {
    return Err("Could not find the LiveTree window.".into());
  };
  let state = app.state::<AppState>();
  let placement = state
    .regular_window_placement
    .lock()
    .expect("window placement lock poisoned")
    .take();

  window.set_always_on_top(false).map_err(|error| error.to_string())?;
  window.set_visible_on_all_workspaces(false).map_err(|error| error.to_string())?;
  window.set_min_size(Some(LogicalSize::new(360.0, 500.0))).map_err(|error| error.to_string())?;
  window.set_max_size(None::<LogicalSize<f64>>).map_err(|error| error.to_string())?;
  window.set_resizable(true).map_err(|error| error.to_string())?;
  window.set_maximizable(true).map_err(|error| error.to_string())?;
  window.set_minimizable(true).map_err(|error| error.to_string())?;
  if let Some(placement) = placement {
    window.unmaximize().map_err(|error| error.to_string())?;
    set_appkit_window_frame(&window, placement.frame, true)?;
  }
  let background = match window.theme() {
    Ok(tauri::Theme::Dark) => Color(11, 13, 16, 255),
    _ => Color(242, 244, 242, 255),
  };
  window.set_background_color(Some(background)).map_err(|error| error.to_string())?;
  window.set_shadow(true).map_err(|error| error.to_string())?;
  if placement.is_some_and(|placement| placement.maximized) {
    window.maximize().map_err(|error| error.to_string())?;
  }
  Ok(())
}

#[cfg(target_os = "macos")]
fn toggle_menu_bar_window(app: &tauri::AppHandle, tray_rect: tauri::Rect) {
  if !app.state::<AppState>().info.lock().expect("native info lock poisoned").menu_bar_mode {
    return;
  }
  let Some(window) = app.get_webview_window("main") else {
    return;
  };
  if window.is_visible().unwrap_or(false) {
    let _ = window.hide();
    return;
  }
  if let (Ok(window_size), Ok(scale_factor)) = (window.outer_size(), window.scale_factor()) {
    let tray_position: PhysicalPosition<f64> = tray_rect.position.to_physical(1.0);
    let tray_size: PhysicalSize<f64> = tray_rect.size.to_physical(1.0);
    let tray_center = tray_position.x + tray_size.width / 2.0;
    if let Ok(Some(monitor)) = window.monitor_from_point(tray_center, tray_position.y) {
      let monitor_left = f64::from(monitor.position().x);
      let monitor_right = monitor_left + f64::from(monitor.size().width);
      let window_width = f64::from(window_size.width);
      let desired_left = tray_center - window_width / 2.0;
      let constrained_left = desired_left.clamp(monitor_left, (monitor_right - window_width).max(monitor_left));
      let anchor = ((tray_center - constrained_left) / scale_factor).clamp(32.0, window_width / scale_factor - 32.0);
      let script = format!("document.documentElement.style.setProperty('--menu-bar-anchor-x', '{anchor}px')");
      if let Err(error) = window.eval(&script) {
        log::error!("Unable to align menu bar window anchor: {error}");
      }
    }
  }
  if let Err(error) = window.move_window_constrained(Position::TrayCenter) {
    log::error!("Unable to position menu bar window: {error}");
  }
  let _ = window.show();
  let _ = window.unminimize();
  let _ = window.set_focus();
}

#[cfg(target_os = "macos")]
fn menu_bar_tree_icon(source: &tauri::image::Image<'_>) -> tauri::image::Image<'static> {
  let width = source.width();
  let height = source.height();
  let mut alpha = Vec::with_capacity((width * height) as usize);
  let mut bounds = (width, height, 0_u32, 0_u32);
  for (index, pixel) in source.rgba().chunks_exact(4).enumerate() {
    let tree_alpha = u16::from(pixel[3]) * u16::from(pixel[0].max(pixel[1]).max(pixel[2])) / 255;
    let tree_alpha = tree_alpha as u8;
    alpha.push(tree_alpha);
    if tree_alpha > 0 {
      let x = index as u32 % width;
      let y = index as u32 / width;
      bounds = (bounds.0.min(x), bounds.1.min(y), bounds.2.max(x), bounds.3.max(y));
    }
  }

  let padding = ((bounds.3 - bounds.1 + 1) / 32).max(1);
  let left = bounds.0.saturating_sub(padding);
  let top = bounds.1.saturating_sub(padding);
  let right = (bounds.2 + padding).min(width - 1);
  let bottom = (bounds.3 + padding).min(height - 1);
  let cropped_width = right - left + 1;
  let cropped_height = bottom - top + 1;
  let mut rgba = Vec::with_capacity((cropped_width * cropped_height * 4) as usize);
  for y in top..=bottom {
    for x in left..=right {
      rgba.extend_from_slice(&[255, 255, 255, alpha[(y * width + x) as usize]]);
    }
  }
  tauri::image::Image::new_owned(rgba, cropped_width, cropped_height)
}

#[cfg(target_os = "macos")]
fn install_menu_bar_item(app: &tauri::AppHandle) -> Result<(), String> {
  if app.tray_by_id(MENU_BAR_TRAY_ID).is_some() {
    return Ok(());
  }

  let move_to_window = MenuItem::with_id(app, "menu-bar-move-to-window", "Move to window", true, None::<&str>)
    .map_err(|error| error.to_string())?;
  let quit = MenuItem::with_id(app, "menu-bar-quit", "Quit LiveTree", true, None::<&str>)
    .map_err(|error| error.to_string())?;
  let menu = Menu::with_items(app, &[&move_to_window, &quit]).map_err(|error| error.to_string())?;
  let mut tray = TrayIconBuilder::with_id(MENU_BAR_TRAY_ID)
    .menu(&menu)
    .tooltip("LiveTree")
    .show_menu_on_left_click(false)
    .icon_as_template(true);
  if let Some(icon) = app.default_window_icon() {
    tray = tray.icon(menu_bar_tree_icon(icon));
  }
  tray.build(app)
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn set_menu_bar_appearance(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
  if enabled {
    install_menu_bar_item(app)?;
    if let Err(error) = compact_main_window(app) {
      app.remove_tray_by_id(MENU_BAR_TRAY_ID);
      return Err(error);
    }
    if let Err(error) = app.set_activation_policy(tauri::ActivationPolicy::Accessory) {
      let _ = restore_main_window(app);
      app.remove_tray_by_id(MENU_BAR_TRAY_ID);
      return Err(error.to_string());
    }
    if let Some(window) = app.get_webview_window("main") {
      window.hide().map_err(|error| error.to_string())?;
    }
  } else {
    app.set_activation_policy(tauri::ActivationPolicy::Regular).map_err(|error| error.to_string())?;
    if let Err(error) = restore_main_window(app) {
      let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
      return Err(error);
    }
    app.remove_tray_by_id(MENU_BAR_TRAY_ID);
  }
  Ok(())
}

#[cfg(target_os = "macos")]
fn handle_menu_bar_event(app: &tauri::AppHandle, id: &str) {
  match id {
    "menu-bar-move-to-window" => {
      if let Err(error) = apply_menu_bar_mode(app, false, true) {
        log::error!("Unable to leave menu bar mode: {error}");
      }
      show_main_window(app);
    }
    "menu-bar-quit" => app.exit(0),
    _ => {}
  }
}

#[cfg(target_os = "macos")]
fn apply_menu_bar_mode(app: &tauri::AppHandle, enabled: bool, persist: bool) -> Result<(), String> {
  let previous = {
    let state = app.state::<AppState>();
    let mut info = state.info.lock().expect("native info lock poisoned");
    let previous = info.menu_bar_mode;
    info.menu_bar_mode = enabled;
    previous
  };
  if let Err(error) = set_menu_bar_appearance(app, enabled) {
    app.state::<AppState>().info.lock().expect("native info lock poisoned").menu_bar_mode = previous;
    return Err(error);
  }

  if persist {
    if let Err(error) = write_menu_bar_mode(app, enabled) {
      app.state::<AppState>().info.lock().expect("native info lock poisoned").menu_bar_mode = previous;
      let _ = set_menu_bar_appearance(app, previous);
      return Err(error);
    }
  }
  let info = app.state::<AppState>().info.lock().expect("native info lock poisoned").clone();
  if let Err(error) = app.emit("native-info-changed", info) {
    log::error!("Unable to notify the dashboard of its window mode: {error}");
  }
  Ok(())
}

#[tauri::command]
fn set_menu_bar_mode(app: tauri::AppHandle, enabled: bool) -> Result<NativeInfo, String> {
  #[cfg(target_os = "macos")]
  apply_menu_bar_mode(&app, enabled, true)?;

  #[cfg(not(target_os = "macos"))]
  {
    let _ = enabled;
    return Err("Menu bar mode is only available on macOS.".into());
  }

  Ok(app.state::<AppState>().info.lock().expect("native info lock poisoned").clone())
}

fn allowed_desktop_url(url: &str) -> bool {
  if url.chars().any(char::is_whitespace) {
    return false;
  }
  if let Some(host) = url.strip_prefix("https://") {
    return !host.is_empty();
  }
  ["http://localhost", "http://127.0.0.1", "http://[::1]"].iter().any(|origin| {
    url.strip_prefix(origin).is_some_and(|rest| rest.is_empty() || rest.starts_with(':') || rest.starts_with('/'))
  })
}

#[tauri::command]
fn read_desktop_url(app: tauri::AppHandle) -> Result<Option<String>, String> {
  let path = desktop_url_file(&app)?;
  match fs::read_to_string(path) {
    Ok(url) => Ok(Some(url)),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(error) => Err(error.to_string()),
  }
}

#[tauri::command]
fn write_desktop_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
  if !allowed_desktop_url(&url) {
    return Err("Only HTTPS or local development URLs can be saved.".into());
  }
  let path = desktop_url_file(&app)?;
  let directory = path.parent().ok_or_else(|| "Could not resolve app data directory.".to_string())?;
  fs::create_dir_all(directory).map_err(|error| error.to_string())?;
  let temporary = path.with_extension("tmp");
  fs::write(&temporary, url).map_err(|error| error.to_string())?;
  fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_desktop_url(app: tauri::AppHandle) -> Result<(), String> {
  match fs::remove_file(desktop_url_file(&app)?) {
    Ok(()) => Ok(()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(error) => Err(error.to_string()),
  }
}

fn allowed_external_url(url: &str) -> bool {
  let Some((scheme, _)) = url.split_once(':') else {
    return false;
  };
  let mut chars = scheme.chars();
  if !chars.next().is_some_and(|character| character.is_ascii_alphabetic())
    || !chars.all(|character| character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.'))
  {
    return false;
  }

  !matches!(
    scheme.to_ascii_lowercase().as_str(),
    "about"
      | "asset"
      | "blob"
      | "chrome"
      | "chrome-extension"
      | "data"
      | "file"
      | "ipc"
      | "javascript"
      | "tauri"
      | "vbscript"
  )
}

#[tauri::command]
fn open_external_url(_app: tauri::AppHandle, url: String) -> Result<(), String> {
  if !allowed_external_url(&url) {
    return Err("Unsupported external URL scheme.".into());
  }

  #[cfg(target_os = "macos")]
  {
    let output = Command::new("/usr/bin/open").arg(url).output().map_err(|error| error.to_string())?;
    if output.status.success() {
      return Ok(());
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
    return Err(if message.is_empty() { "No application can open this shortcut.".into() } else { message });
  }

  #[cfg(not(target_os = "macos"))]
  _app.opener().open_url(url, None::<&str>).map_err(|error| error.to_string())
}

#[tauri::command]
fn open_worktree_folder(path: String) -> Result<(), String> {
  let folder = std::path::PathBuf::from(path);
  if !folder.is_absolute() {
    return Err("Worktree folder path must be absolute.".into());
  }
  if !folder.is_dir() {
    return Err("Worktree folder no longer exists.".into());
  }

  #[cfg(target_os = "macos")]
  {
    let output = Command::new("/usr/bin/open").arg(folder).output().map_err(|error| error.to_string())?;
    if output.status.success() {
      return Ok(());
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
    return Err(if message.is_empty() { "Finder could not open the worktree folder.".into() } else { message });
  }

  #[cfg(not(target_os = "macos"))]
  Err("Opening a worktree folder is only available on macOS.".into())
}

#[cfg(desktop)]
fn update_from_line(app: &tauri::AppHandle, line: &str, is_stderr: bool) {
  let state = app.state::<AppState>();
  let mut info = state.info.lock().expect("native info lock poisoned");
  if let Some(url) = line.strip_prefix("Dashboard: ") {
    info.server_url = Some(url.trim().to_string());
    if info.server_mode == NativeServerMode::Starting {
      info.server_mode = NativeServerMode::Bundled;
    }
    info.error = None;
  } else if let Some(url) = line.strip_prefix("Tailnet dashboard: ") {
    info.tailnet_url = Some(url.trim().to_string());
  } else if let Some(error) = line.strip_prefix("Tailnet dashboard unavailable: ") {
    info.error = Some(error.trim().to_string());
  } else if is_stderr && info.server_url.is_none() && !line.trim().is_empty() {
    info.error = Some(line.trim().to_string());
  }
}

#[cfg(desktop)]
fn login_shell_path() -> Option<String> {
  const MARKER: &str = "__LIVETREE_PATH__";
  let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
  let output = Command::new(shell)
    .args(["-ilc", "printf '__LIVETREE_PATH__%s\\n' \"$PATH\""])
    .output()
    .ok()?;
  if !output.status.success() {
    return None;
  }
  String::from_utf8_lossy(&output.stdout)
    .lines()
    .find_map(|line| line.strip_prefix(MARKER))
    .filter(|path| !path.is_empty())
    .map(str::to_owned)
}

#[cfg(desktop)]
fn command_path() -> String {
  let mut paths = Vec::new();
  if let Some(path) = login_shell_path() {
    paths.push(path);
  }
  if let Ok(path) = env::var("PATH") {
    if !path.is_empty() {
      paths.push(path);
    }
  }
  paths.push("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into());
  paths.join(":")
}

#[cfg(desktop)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundServeInfo {
  pid: u32,
  local_url: String,
  tailnet_url: Option<String>,
  #[serde(default)]
  tailnet_error: Option<String>,
}

#[cfg(desktop)]
fn livetree_home() -> Option<PathBuf> {
  env::var_os("LIVETREE_HOME")
    .filter(|value| !value.is_empty())
    .map(PathBuf::from)
    .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".livetree")))
}

#[cfg(desktop)]
fn local_dashboard_port(url: &str) -> Option<u16> {
  let port = url.strip_prefix("http://127.0.0.1:")?.split('/').next()?;
  port.parse().ok()
}

#[cfg(desktop)]
fn background_dashboard_is_healthy(url: &str, expected_pid: u32) -> bool {
  for attempt in 0..3 {
    if probe_background_dashboard(url, expected_pid) {
      return true;
    }
    if attempt < 2 {
      thread::sleep(Duration::from_millis(150));
    }
  }
  false
}

#[cfg(desktop)]
fn probe_background_dashboard(url: &str, expected_pid: u32) -> bool {
  let Some(port) = local_dashboard_port(url) else {
    return false;
  };
  let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
  let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(1_500)) else {
    return false;
  };
  let _ = stream.set_read_timeout(Some(Duration::from_millis(1_500)));
  let _ = stream.set_write_timeout(Some(Duration::from_millis(1_500)));
  if stream.write_all(b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").is_err() {
    return false;
  }

  let mut response = String::new();
  if stream.take(64 * 1024).read_to_string(&mut response).is_err() {
    return false;
  }
  let Some((headers, body)) = response.split_once("\r\n\r\n") else {
    return false;
  };
  if !headers.lines().next().is_some_and(|status| status.contains(" 200 ")) {
    return false;
  }
  serde_json::from_str::<serde_json::Value>(body)
    .ok()
    .map(|value| {
      value.get("service").and_then(|service| service.as_str()) == Some("livetree")
        && value.get("pid").and_then(|pid| pid.as_u64()) == Some(u64::from(expected_pid))
    })
    .unwrap_or(false)
}

#[cfg(desktop)]
fn existing_background_livetree() -> Option<NativeInfo> {
  let info: BackgroundServeInfo = serde_json::from_str(&fs::read_to_string(livetree_home()?.join("serve.json")).ok()?).ok()?;
  if !allowed_desktop_url(&info.local_url) || !background_dashboard_is_healthy(&info.local_url, info.pid) {
    return None;
  }
  Some(NativeInfo {
    platform: "macos".into(),
    server_mode: NativeServerMode::Background,
    server_url: Some(info.local_url),
    tailnet_url: info.tailnet_url.filter(|url| allowed_desktop_url(url)),
    error: info.tailnet_error,
    menu_bar_mode: false,
  })
}

#[cfg(desktop)]
fn start_livetree(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
  if let Some(info) = existing_background_livetree() {
    app.state::<AppState>().info.lock().expect("native info lock poisoned").clone_from(&info);
    return Ok(());
  }

  let script = app.path().resource_dir()?.join("livetree/dist/cli.js");
  let script_path = script.to_string_lossy().into_owned();
  let parent_pid = std::process::id().to_string();
  let path = command_path();
  let (mut events, child) = app
    .shell()
    .sidecar("livetree-node")?
    .args([
      script_path.as_str(),
      "server",
      "start",
      "--foreground",
      "--tailscale-optional",
      "--port",
      "0",
      "--parent-pid",
      parent_pid.as_str(),
    ])
    .env("PATH", path)
    .spawn()?;

  *app.state::<AppState>().child.lock().expect("child lock poisoned") = Some(child);
  let handle = app.clone();
  tauri::async_runtime::spawn(async move {
    let mut stdout = String::new();
    let mut stderr = String::new();
    while let Some(event) = events.recv().await {
      match event {
        CommandEvent::Stdout(bytes) => consume_lines(&handle, &mut stdout, &bytes, false),
        CommandEvent::Stderr(bytes) => consume_lines(&handle, &mut stderr, &bytes, true),
        CommandEvent::Terminated(payload) => {
          consume_trailing_line(&handle, &mut stdout, false);
          consume_trailing_line(&handle, &mut stderr, true);
          let state = handle.state::<AppState>();
          let mut info = state.info.lock().expect("native info lock poisoned");
          let had_started = info.server_url.take().is_some();
          info.tailnet_url = None;
          info.server_mode = NativeServerMode::Error;
          let status = payload.code
            .map(|code| format!("with exit code {code}"))
            .unwrap_or_else(|| "after being terminated by macOS".to_string());
          info.error = Some(format!(
            "LiveTree service exited {} {status}.",
            if had_started { "unexpectedly" } else { "before starting" }
          ));
        }
        _ => {}
      }
    }
  });
  Ok(())
}

#[cfg(desktop)]
fn consume_trailing_line(app: &tauri::AppHandle, buffer: &mut String, is_stderr: bool) {
  if buffer.is_empty() {
    return;
  }
  let line = std::mem::take(buffer);
  update_from_line(app, line.trim_end_matches('\r'), is_stderr);
}

#[cfg(desktop)]
fn consume_lines(app: &tauri::AppHandle, buffer: &mut String, bytes: &[u8], is_stderr: bool) {
  buffer.push_str(&String::from_utf8_lossy(bytes));
  while let Some(index) = buffer.find('\n') {
    let line = buffer[..index].trim_end_matches('\r').to_string();
    buffer.drain(..=index);
    update_from_line(app, &line, is_stderr);
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .manage(AppState::default())
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
    .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build());
  #[cfg(target_os = "macos")]
  let builder = builder
    .plugin(tauri_plugin_positioner::init())
    .on_menu_event(|app, event| handle_menu_bar_event(app, event.id().as_ref()))
    .on_tray_icon_event(|app, event| {
      tauri_plugin_positioner::on_tray_event(app, &event);
      if let TrayIconEvent::Click { id, rect, button, button_state, .. } = event {
        if id.as_ref() == MENU_BAR_TRAY_ID && button == MouseButton::Left && button_state == MouseButtonState::Up {
          toggle_menu_bar_window(app, rect);
        }
      }
    });
  #[cfg(desktop)]
  let builder = builder.plugin(tauri_plugin_shell::init());

  let app = builder
    .invoke_handler(tauri::generate_handler![native_info, read_desktop_url, write_desktop_url, clear_desktop_url, open_external_url, open_worktree_folder, set_menu_bar_mode])
    .on_window_event(|window, event| {
      #[cfg(target_os = "macos")]
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.state::<AppState>().info.lock().expect("native info lock poisoned").menu_bar_mode {
          api.prevent_close();
          let _ = window.hide();
        }
      }
      #[cfg(target_os = "macos")]
      if let tauri::WindowEvent::Focused(false) = event {
        if window.label() == "main" && window.state::<AppState>().info.lock().expect("native info lock poisoned").menu_bar_mode {
          let _ = window.hide();
        }
      }
    })
    .setup(|_app| {
      #[cfg(desktop)]
      if let Err(error) = start_livetree(_app.handle()) {
        let state = _app.state::<AppState>();
        let mut info = state.info.lock().expect("native info lock poisoned");
        info.server_mode = NativeServerMode::Error;
        info.error = Some(error.to_string());
      }
      #[cfg(target_os = "macos")]
      match read_menu_bar_mode(_app.handle()) {
        Ok(true) => {
          if let Err(error) = apply_menu_bar_mode(_app.handle(), true, false) {
            log::error!("Unable to restore menu bar mode: {error}");
            show_main_window(_app.handle());
          }
        }
        Ok(false) => {
          if let Err(error) = set_menu_bar_appearance(_app.handle(), false) {
            log::error!("Unable to prepare regular window mode: {error}");
          }
          show_main_window(_app.handle());
        }
        Err(error) => {
          log::error!("Unable to read menu bar preference: {error}");
          if let Err(error) = set_menu_bar_appearance(_app.handle(), false) {
            log::error!("Unable to prepare regular window mode: {error}");
          }
          show_main_window(_app.handle());
        }
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|_handle, _event| {
    #[cfg(desktop)]
    if matches!(_event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
      if let Some(child) = _handle.state::<AppState>().child.lock().expect("child lock poisoned").take() {
        // Give the Node service a graceful shutdown so it can stop its
        // foreground Tailscale Serve child before this app exits.
        let _ = Command::new("/bin/kill").args(["-TERM", &child.pid().to_string()]).status();
      }
    }
  });
}

#[cfg(test)]
mod tests {
  use super::{allowed_desktop_url, allowed_external_url, NativeServerMode};
  #[cfg(desktop)]
  use super::{background_dashboard_is_healthy, local_dashboard_port};
  #[cfg(desktop)]
  use std::{io::{Read, Write}, net::TcpListener, thread};

  #[test]
  fn allows_web_and_app_deep_links() {
    assert!(allowed_external_url("https://example.com/path"));
    assert!(allowed_external_url("my-app-development://open?url=https%3A%2F%2Fexample.com"));
  }

  #[test]
  fn rejects_unsafe_or_malformed_urls() {
    for url in [
      "file:///tmp/private",
      "javascript:alert(1)",
      "data:text/html,bad",
      "blob:https://example.com/id",
      "missing-scheme.example.com",
      "1invalid://example.com",
      "invalid_scheme://example.com",
    ] {
      assert!(!allowed_external_url(url), "unexpectedly allowed {url}");
    }
  }

  #[test]
  fn accepts_tailnet_and_local_desktop_urls_only() {
    assert!(allowed_desktop_url("https://my-mac.example.ts.net"));
    assert!(allowed_desktop_url("http://localhost:43117"));
    assert!(allowed_desktop_url("http://127.0.0.1:43117"));
    assert!(!allowed_desktop_url("http://localhost.example.com"));
    assert!(!allowed_desktop_url("http://remote.example.com"));
    assert!(!allowed_desktop_url("https://"));
  }

  #[test]
  fn serializes_native_server_modes_for_the_dashboard() {
    assert_eq!(serde_json::to_string(&NativeServerMode::Starting).unwrap(), r#""starting""#);
    assert_eq!(serde_json::to_string(&NativeServerMode::Background).unwrap(), r#""background""#);
    assert_eq!(serde_json::to_string(&NativeServerMode::Bundled).unwrap(), r#""bundled""#);
    assert_eq!(serde_json::to_string(&NativeServerMode::Disconnected).unwrap(), r#""disconnected""#);
    assert_eq!(serde_json::to_string(&NativeServerMode::Error).unwrap(), r#""error""#);
  }

  #[cfg(desktop)]
  #[test]
  fn extracts_only_loopback_dashboard_ports() {
    assert_eq!(local_dashboard_port("http://127.0.0.1:43117/"), Some(43117));
    assert_eq!(local_dashboard_port("http://localhost:43117/"), None);
    assert_eq!(local_dashboard_port("https://example.com/"), None);
    assert_eq!(local_dashboard_port("http://127.0.0.1:not-a-port/"), None);
  }

  #[cfg(desktop)]
  #[test]
  fn verifies_the_livetree_health_response() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
    let port = listener.local_addr().expect("test server address").port();
    let server = thread::spawn(move || {
      let (mut stream, _) = listener.accept().expect("accept health request");
      let mut request = [0_u8; 1024];
      let size = stream.read(&mut request).expect("read health request");
      assert!(String::from_utf8_lossy(&request[..size]).starts_with("GET /api/health HTTP/1.0"));
      let body = format!(r#"{{"ok":true,"service":"livetree","pid":{}}}"#, std::process::id());
      write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body)
        .expect("write health response");
    });

    assert!(background_dashboard_is_healthy(&format!("http://127.0.0.1:{port}/"), std::process::id()));
    server.join().expect("health test server");
  }

}
