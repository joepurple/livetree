use serde::Serialize;
use std::sync::Mutex;
#[cfg(desktop)]
use tauri::{Manager, RunEvent};

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
fn start_livetree(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
  let script = app.path().resource_dir()?.join("livetree/dist/cli.js");
  let script_path = script.to_string_lossy().into_owned();
  let parent_pid = std::process::id().to_string();
  let inherited_path = std::env::var("PATH").unwrap_or_default();
  let path = format!("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:{inherited_path}");
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
    .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build());
  #[cfg(desktop)]
  let builder = builder.plugin(tauri_plugin_shell::init());

  let app = builder
    .invoke_handler(tauri::generate_handler![native_info])
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
        let _ = child.kill();
      }
    }
  });
}
