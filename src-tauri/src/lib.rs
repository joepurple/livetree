use serde::Serialize;
use std::{fs, sync::Mutex};
use tauri::Manager;
#[cfg(not(target_os = "macos"))]
use tauri_plugin_opener::OpenerExt;
#[cfg(desktop)]
use std::{env, process::Command};
#[cfg(desktop)]
use tauri::RunEvent;

#[cfg(desktop)]
use tauri_plugin_shell::{
  process::{CommandChild, CommandEvent},
  ShellExt,
};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeInfo {
  platform: String,
  server_url: Option<String>,
  tailnet_url: Option<String>,
  error: Option<String>,
}

struct AppState {
  info: Mutex<NativeInfo>,
  #[cfg(desktop)]
  child: Mutex<Option<CommandChild>>,
}

impl Default for AppState {
  fn default() -> Self {
    Self {
      info: Mutex::new(NativeInfo {
        platform: if cfg!(target_os = "ios") { "ios" } else { "macos" }.into(),
        ..NativeInfo::default()
      }),
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

#[cfg(desktop)]
fn update_from_line(app: &tauri::AppHandle, line: &str, is_stderr: bool) {
  let state = app.state::<AppState>();
  let mut info = state.info.lock().expect("native info lock poisoned");
  if let Some(url) = line.strip_prefix("Dashboard: ") {
    info.server_url = Some(url.trim().to_string());
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
fn start_livetree(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
  let script = app.path().resource_dir()?.join("livetree/dist/cli.js");
  let script_path = script.to_string_lossy().into_owned();
  let parent_pid = std::process::id().to_string();
  let path = command_path();
  let (mut events, child) = app
    .shell()
    .sidecar("livetree-node")?
    .args([
      script_path.as_str(),
      "serve",
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
          if info.server_url.is_none() && info.error.is_none() {
            let status = payload.code
              .map(|code| format!("with exit code {code}"))
              .unwrap_or_else(|| "after being terminated by macOS".to_string());
            info.error = Some(format!("LiveTree service exited before starting {status}."));
          }
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
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
    .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build());
  #[cfg(desktop)]
  let builder = builder.plugin(tauri_plugin_shell::init());

  let app = builder
    .invoke_handler(tauri::generate_handler![native_info, read_desktop_url, write_desktop_url, clear_desktop_url, open_external_url])
    .setup(|_app| {
      #[cfg(desktop)]
      if let Err(error) = start_livetree(_app.handle()) {
        _app.state::<AppState>().info.lock().expect("native info lock poisoned").error = Some(error.to_string());
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
  use super::{allowed_desktop_url, allowed_external_url};

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
}
