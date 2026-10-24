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

fn start_engine(repo: &Path, data: &Path, token: &str) -> std::io::Result<Child> {
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

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_localhost::Builder::new(UI_PORT).build())
        .setup(|app| {
            let repo = fs::canonicalize(REPO).unwrap_or_else(|_| fail("the repository checkout was not found"));
            if !port_free(ENGINE_PORT) {
                fail(&format!("port {ENGINE_PORT} is already in use; another Paradox desktop engine may still be running"));
            }
            let data = app.path().app_data_dir()?;
            fs::create_dir_all(&data)?;
            let token = random_token()?;
            let mut child = start_engine(&repo, &data, &token).unwrap_or_else(|error| fail(&format!("the engine could not be launched: {error}")));
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
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Paradox (desktop POC · scripted)")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 700.0)
                .initialization_script(&init)
                .build()?;
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
