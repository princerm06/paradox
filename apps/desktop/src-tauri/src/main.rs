// Paradox desktop shell (proof of concept).
//
// Starts a private, keyless, scripted Paradox engine as a child process, serves
// the studio build from an http://localhost origin (so the engine's existing
// CORS allowlist applies unchanged), injects a random per-launch token, and
// stops the engine when the app exits. The browser demo (engine :8000, studio
// :5173, its own state) is never touched: this shell uses :8100/:5190 and its
// own state directory, and refuses to start if either port is taken.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const ENGINE_PORT: u16 = 8100;
const UI_PORT: u16 = 5190;
/// Dev-machine POC: the engine runs from this checkout's own virtualenv.
const REPO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");

/// Exits (status 3) when the shell's end of stdin closes, i.e. if the shell
/// dies without a clean shutdown; the engine's own children die with it.
const LAUNCHER: &str = "import os, sys, threading; \
threading.Thread(target=lambda: (sys.stdin.buffer.read(), os._exit(3)), daemon=True).start(); \
sys.path.insert(0, os.environ['PARADOX_DESKTOP_REPO']); \
import uvicorn; from pathlib import Path; from engine.api import create_app; \
uvicorn.run(create_app(state_dir=Path(os.environ['PARADOX_STATE_DIR']), runtime_port=0), \
host='127.0.0.1', port=int(os.environ['PARADOX_DESKTOP_PORT']), log_level='warning')";

struct Sidecar(Mutex<Option<Child>>);

/// Per-launch secrets. The bearer token is also given to the page; the shell
/// token never leaves this process and the engine.
struct Tokens {
    bearer: String,
    shell: String,
}

fn random_token() -> std::io::Result<String> {
    let mut bytes = [0u8; 24];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn port_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Minimal HTTP probe so the shell needs no HTTP client dependency.
fn healthy() -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&([127, 0, 0, 1], ENGINE_PORT).into(), Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream.write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut reply = String::new();
    let _ = stream.read_to_string(&mut reply);
    reply.starts_with("HTTP/1.1 200")
}

fn fail(message: &str) -> ! {
    eprintln!("paradox-desktop: {message}");
    let script = format!("display alert \"Paradox desktop could not start\" message \"{}\"", message.replace('"', "'"));
    let _ = Command::new("/usr/bin/osascript").args(["-e", &script]).status();
    std::process::exit(1);
}

fn start_engine(repo: &Path, data: &Path, token: &str, shell_token: &str) -> std::io::Result<Child> {
    let python = std::env::var_os("PARADOX_DESKTOP_PYTHON").map(PathBuf::from).unwrap_or_else(|| repo.join(".venv/bin/python"));
    let state = data.join("state");
    fs::create_dir_all(&state)?;
    let log = File::create(data.join("engine.log"))?;
    let origins = format!("http://localhost:{UI_PORT},http://127.0.0.1:{UI_PORT}");
    Command::new(python)
        .args(["-I", "-c", LAUNCHER])
        .current_dir(repo)
        // A clean environment: no FACTORY_API_KEY or anything else inherited from the user's shell.
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("HOME", std::env::var_os("HOME").unwrap_or_default())
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PARADOX_DESKTOP_REPO", repo)
        .env("PARADOX_DESKTOP_PORT", ENGINE_PORT.to_string())
        .env("PARADOX_STATE_DIR", &state)
        .env("PARADOX_AGENT", "scripted")
        .env("PARADOX_SCRIPTED_RECIPES", repo.join("tests/fixtures/scripted_agent"))
        .env("PARADOX_TOKEN", token)
        .env("PARADOX_SHELL_TOKEN", shell_token)
        .env("PARADOX_CORS_ORIGINS", origins)
        .stdin(Stdio::piped())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0)
        .spawn()
}

/// SIGTERM lets uvicorn run the engine's lifespan shutdown (checkpoint, stop
/// runtime); SIGKILL after 10 s. Dropping the child closes its stdin as well.
fn stop_engine(child: &mut Child) {
    if let Ok(Some(_)) = child.try_wait() {
        return;
    }
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Read-only DOM report from inside the app window, for debug-build self-tests.
#[cfg(debug_assertions)]
fn selftest_script(port: u16) -> String {
    format!(
        r#"(() => {{
  const errors = [];
  addEventListener("error", (e) => errors.push(String(e.message)));
  addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));
  let n = 0;
  const report = () => {{
    const q = (s) => document.querySelector(s);
    const live = [...document.querySelectorAll(".topbar span, header span")].map((e) => e.textContent).find((t) => t && t.startsWith("Live ·")) || null;
    const state = {{
      n: ++n,
      origin: location.origin,
      engine: document.documentElement.getAttribute("data-paradox-engine"),
      tokenSet: (localStorage.getItem("paradox.token:http://127.0.0.1:{ENGINE_PORT}") || "").length,
      live,
      provider: (q("select[aria-label='Agent provider']") || {{}}).value || null,
      nodes: document.querySelectorAll(".future-node").length,
      engineDot: (q("[role=img][aria-label^='Engine']") || {{}}).getAttribute?.("aria-label") || null,
      portal: !!q("iframe[title='Live application']"),
      webkit: navigator.userAgent,
      errors,
    }};
    fetch("http://127.0.0.1:{port}/report?" + encodeURIComponent(JSON.stringify(state)), {{ mode: "no-cors" }}).catch(() => {{}});
    if (n < 15) setTimeout(report, 1000);
  }};
  const ipc = async () => {{
    const tauri = window.__TAURI_INTERNALS__;
    const probe = async (cmd, args) => {{
      try {{ return {{ ok: true, value: await tauri.invoke(cmd, args || {{}}) }}; }} catch (e) {{ return {{ ok: false, error: String(e) }}; }}
    }};
    const out = {{ ipc: !!tauri }};
    if (tauri) {{
      out.select_repository = await probe("select_repository");
      out.select_again = await probe("select_repository");
      const bearer = localStorage.getItem("paradox.token:http://127.0.0.1:{ENGINE_PORT}");
      const page = await fetch("http://127.0.0.1:{ENGINE_PORT}/api/repositories", {{ method: "POST", headers: {{ Authorization: "Bearer " + bearer, "Content-Type": "application/json" }}, body: JSON.stringify({{ path: "/tmp" }}) }}).then((r) => r.status, (e) => String(e));
      out.page_register_without_shell_token = page;
      out.page_list = await fetch("http://127.0.0.1:{ENGINE_PORT}/api/repositories", {{ headers: {{ Authorization: "Bearer " + bearer }} }}).then((r) => r.json(), (e) => String(e));
      out.dialog_open = await probe("plugin:dialog|open", {{ options: {{ directory: true }} }});
      out.fs_read = await probe("plugin:fs|read_text_file", {{ path: "/etc/hosts" }});
      out.shell_open = await probe("plugin:shell|open", {{ path: "https://example.com" }});
    }}
    fetch("http://127.0.0.1:{port}/ipc?" + encodeURIComponent(JSON.stringify(out)), {{ mode: "no-cors" }}).catch(() => {{}});
  }};
  addEventListener("load", () => setTimeout(ipc, 1500));
  addEventListener("load", () => setTimeout(report, 500));
}})();"#
    )
}

/// Native folder picker. The page can trigger it but never supplies a path:
/// the shell registers the chosen folder with its own engine (shell token) and
/// returns the engine's RepositorySummary.
#[tauri::command]
async fn select_repository(app: tauri::AppHandle, tokens: tauri::State<'_, Tokens>) -> Result<serde_json::Value, String> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("PARADOX_DESKTOP_SELFTEST_PICK") {
        return register(PathBuf::from(path), &tokens);
    }
    use tauri_plugin_dialog::DialogExt;
    match app.dialog().file().set_title("Open a project folder").blocking_pick_folder() {
        None => Ok(serde_json::json!({ "cancelled": true })),
        Some(choice) => register(choice.into_path().map_err(|error| error.to_string())?, &tokens),
    }
}

fn register(path: PathBuf, tokens: &Tokens) -> Result<serde_json::Value, String> {
    let canonical = fs::canonicalize(&path).map_err(|_| "the selected folder is not accessible".to_string())?;
    let root = canonical.to_str().ok_or("the folder path is not valid UTF-8")?;
    let body = serde_json::json!({ "path": root }).to_string();
    let (status, reply) = engine_request("POST", "/api/repositories", Some(&body), tokens)?;
    match status {
        201 => Ok(serde_json::json!({ "cancelled": false, "already_registered": false, "repository": reply })),
        // Already registered: return the existing registration, found by its canonical root.
        409 => {
            let (_, listing) = engine_request("GET", "/api/repositories", None, tokens)?;
            let existing = listing["repositories"].as_array().and_then(|all| all.iter().find(|r| r["root"] == root)).cloned();
            existing
                .map(|repository| serde_json::json!({ "cancelled": false, "already_registered": true, "repository": repository }))
                .ok_or_else(|| "the folder is already registered".to_string())
        }
        _ => Err(reply["detail"]["message"].as_str().or(reply["detail"].as_str()).unwrap_or("the engine rejected the folder").to_string()),
    }
}

/// Loopback HTTP/1.0 request to this shell's own engine (no HTTP client dependency).
fn engine_request(method: &str, path: &str, body: Option<&str>, tokens: &Tokens) -> Result<(u16, serde_json::Value), String> {
    let unreachable = |_| "the engine is not reachable".to_string();
    let mut stream = TcpStream::connect_timeout(&([127, 0, 0, 1], ENGINE_PORT).into(), Duration::from_secs(2)).map_err(unreachable)?;
    stream.set_read_timeout(Some(Duration::from_secs(30))).map_err(unreachable)?;
    let body = body.unwrap_or("");
    let request = format!(
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{ENGINE_PORT}\r\nAuthorization: Bearer {}\r\nX-Paradox-Shell-Token: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        tokens.bearer,
        tokens.shell,
        body.len()
    );
    stream.write_all(request.as_bytes()).map_err(unreachable)?;
    let mut reply = Vec::new();
    stream.read_to_end(&mut reply).map_err(unreachable)?;
    let reply = String::from_utf8_lossy(&reply);
    let (head, payload) = reply.split_once("\r\n\r\n").ok_or("malformed engine reply")?;
    let status = head.split(' ').nth(1).and_then(|code| code.parse().ok()).ok_or("malformed engine reply")?;
    // HTTP/1.0 keeps the reply unchunked: the payload is the JSON body (empty for 204).
    Ok((status, serde_json::from_str(payload).unwrap_or(serde_json::Value::Null)))
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_localhost::Builder::new(UI_PORT).build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![select_repository])
        .setup(|app| {
            let repo = fs::canonicalize(REPO).unwrap_or_else(|_| fail("the repository checkout was not found"));
            if !port_free(ENGINE_PORT) {
                fail(&format!("port {ENGINE_PORT} is already in use; another Paradox desktop engine may still be running"));
            }
            let data = app.path().app_data_dir()?;
            fs::create_dir_all(&data)?;
            let token = random_token()?;
            let shell_token = random_token()?;
            let mut child = start_engine(&repo, &data, &token, &shell_token).unwrap_or_else(|error| fail(&format!("the engine could not be launched: {error}")));
            let deadline = Instant::now() + Duration::from_secs(30);
            while !healthy() {
                if let Ok(Some(status)) = child.try_wait() {
                    fail(&format!("the engine exited during startup ({status}); see {}", data.join("engine.log").display()));
                }
                if Instant::now() > deadline {
                    stop_engine(&mut child);
                    fail("the engine did not become healthy within 30 seconds");
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            app.manage(Sidecar(Mutex::new(Some(child))));
            app.manage(Tokens { bearer: token.clone(), shell: shell_token });

            let base = format!("http://127.0.0.1:{ENGINE_PORT}");
            // Bind the studio to this engine and its token; drop any stale engine override.
            let init = format!(
                "try {{ localStorage.removeItem('paradox.apiBase'); localStorage.setItem('paradox.token:{base}', '{token}'); }} catch (e) {{}}"
            );
            let url = format!("http://localhost:{UI_PORT}").parse().expect("static url");
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Paradox (desktop POC · scripted)")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 700.0)
                .initialization_script(&init);
            // Debug builds only: let a local test listener see what the real WKWebView rendered.
            #[cfg(debug_assertions)]
            let builder = match std::env::var("PARADOX_DESKTOP_SELFTEST_PORT").ok().and_then(|p| p.parse::<u16>().ok()) {
                Some(port) => builder.initialization_script(&selftest_script(port)),
                None => builder,
            };
            builder.build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| fail(&format!("the desktop shell failed to start: {error}")));

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(sidecar) = handle.try_state::<Sidecar>() {
                if let Some(mut child) = sidecar.0.lock().unwrap().take() {
                    stop_engine(&mut child);
                }
            }
        }
    });
}
