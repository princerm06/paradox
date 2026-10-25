// Paradox Droid demo shell: the bundled Feed demo with genuine Factory Droid.
//
// Demo-only build (not a hardened release). Same shell as the portable recording
// build, plus a bundled Node runtime and Droid CLI. The Factory key is never in the
// app: it is read at launch from the user's own Keychain item (service
// `paradox-demo-factory-key`) and handed to the engine. Without it, Droid reports
// unavailable and the app stays scripted. Droid writes stay confined by the engine's
// existing write sandbox.
//
// Starts a private Paradox engine as a child process, serves
// the studio build from an http://localhost origin (so the engine's existing
// CORS allowlist applies unchanged), injects a random per-launch token, and
// stops the engine when the app exits. The browser demo (engine :8000, studio
// :5173, its own state) is never touched: this shell uses :8120/:5192 and its
// own state directory, and refuses to start if either port is taken.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const ENGINE_PORT: u16 = 8120;
const UI_PORT: u16 = 5192;
/// The engine ships inside the app: Contents/Resources/engine/{python,paradox}.
/// Nothing refers to the source checkout it was built from.
const ENGINE_DIR: &str = "engine";

/// Exits (status 3) when the shell's end of stdin closes, i.e. if the shell
/// dies without a clean shutdown; the engine's own children die with it.
const LAUNCHER: &str = "import os, sys, threading; \
threading.Thread(target=lambda: (sys.stdin.buffer.read(), os._exit(3)), daemon=True).start(); \
sys.path.insert(0, os.environ['PARADOX_DESKTOP_REPO']); \
import uvicorn; from pathlib import Path; from engine.api import create_app; \
uvicorn.run(create_app(state_dir=Path(os.environ['PARADOX_STATE_DIR']), runtime_port=0), \
host='127.0.0.1', port=int(os.environ['PARADOX_DESKTOP_PORT']), log_level='warning')";

struct Sidecar(Mutex<Option<Child>>);

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

/// Keychain service for the demo key. Use a disposable, low-budget key and revoke it after
/// the demo. PARADOX_DEMO_KEY_SERVICE overrides the service name (tests use a dummy item).
fn demo_factory_key() -> Option<String> {
    let service = std::env::var("PARADOX_DEMO_KEY_SERVICE").unwrap_or_else(|_| "paradox-demo-factory-key".into());
    let account = std::env::var("USER").ok()?;
    let output = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", &service, "-a", &account, "-w"])
        .env_clear()
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let key = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (output.status.success() && !key.is_empty()).then_some(key)
}

fn start_engine(bundle: &Path, data: &Path, token: &str) -> std::io::Result<Child> {
    let python = bundle.join("python/bin/python3.9");
    let repo = bundle.join("paradox");
    let state = data.join("state");
    fs::create_dir_all(&state)?;
    let log = File::create(data.join("engine.log"))?;
    let origins = format!("http://localhost:{UI_PORT},http://127.0.0.1:{UI_PORT}");
    // Bundled Node and Droid CLI first, so the engine's provider finds exactly these.
    let path = format!("{}:{}:/usr/bin:/bin:/usr/sbin:/sbin", bundle.join("node/bin").display(), bundle.join("bin").display());
    let key = demo_factory_key();
    let mut command = Command::new(python);
    command
        .args(["-I", "-c", LAUNCHER])
        .current_dir(&repo)
        // A clean environment: nothing inherited from the user's shell. The demo key, if
        // configured, comes only from the Keychain item above.
        .env_clear()
        .env("PATH", &path)
        .env("HOME", std::env::var_os("HOME").unwrap_or_default())
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PARADOX_DESKTOP_REPO", &repo)
        .env("PARADOX_DESKTOP_PORT", ENGINE_PORT.to_string())
        .env("PARADOX_STATE_DIR", &state)
        .env("PARADOX_AGENT", if key.is_some() { "droid" } else { "scripted" })
        .env("PARADOX_SCRIPTED_RECIPES", repo.join("tests/fixtures/scripted_agent"))
        .env("PARADOX_TOKEN", token)
        .env("PARADOX_CORS_ORIGINS", origins)
        .stdin(Stdio::piped())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0);
    if let Some(key) = &key {
        command.env("FACTORY_API_KEY", key);
    }
    command.spawn()
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
  addEventListener("load", () => setTimeout(report, 500));
}})();"#
    )
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_localhost::Builder::new(UI_PORT).build())
        .setup(|app| {
            let bundle = app
                .path()
                .resource_dir()
                .ok()
                .map(|resources| resources.join(ENGINE_DIR))
                .and_then(|dir| fs::canonicalize(dir).ok())
                .filter(|dir| {
                    dir.join("python/bin/python3.9").is_file()
                        && dir.join("paradox/engine/api.py").is_file()
                        && dir.join("node/bin/node").is_file()
                        && dir.join("bin/droid").is_file()
                })
                .unwrap_or_else(|| fail("the bundled engine is missing from the app; reinstall Paradox"));
            if !port_free(ENGINE_PORT) {
                fail(&format!("port {ENGINE_PORT} is already in use; another Paradox desktop engine may still be running"));
            }
            let data = app.path().app_data_dir()?;
            fs::create_dir_all(&data)?;
            let token = random_token()?;
            let mut child = start_engine(&bundle, &data, &token).unwrap_or_else(|error| fail(&format!("the engine could not be launched: {error}")));
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

            let base = format!("http://127.0.0.1:{ENGINE_PORT}");
            // Bind the studio to this engine and its token; drop any stale engine override.
            let init = format!(
                "try {{ localStorage.removeItem('paradox.apiBase'); localStorage.setItem('paradox.token:{base}', '{token}'); }} catch (e) {{}}"
            );
            let url = format!("http://localhost:{UI_PORT}").parse().expect("static url");
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Paradox · Factory Droid demo")
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
