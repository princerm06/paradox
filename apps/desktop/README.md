# Paradox desktop shell: proof of concept

A Tauri 2 shell for the existing React studio and the local Python engine. **Scripted only, dev machine only, not for merge without approval.**

## What it does

- **On launch:**
  - Refuses to start if port 8100 or 5190 is taken.
  - Generates a random 48-hex token for this launch.
  - Starts a **keyless, scripted** engine from this checkout's `.venv`. The engine gets a cleared environment (no `FACTORY_API_KEY`), `PARADOX_TOKEN`, an ephemeral runtime port, and its own state dir under `~/Library/Application Support/dev.paradox.desktop-poc/`.
  - Waits up to 30 s for `/api/health`.
  - Serves the UI from `http://localhost:5190` with `tauri-plugin-localhost`, so the engine's existing CORS allowlist and Origin guard apply unchanged.
  - Injects the token into the studio's per-engine token slot and clears any stale engine override.
- **On quit:** sends the engine SIGTERM (its normal shutdown and checkpoint), then SIGKILL after 10 s.
- **If the shell itself dies:** the engine exits when its stdin closes, and the engine's runtime and job children die with it.

The browser demo (engine :8000, studio :5173, its own state dir) is untouched and can run at the same time.

## Build and run

Needs Rust (`rustup`, minimal profile), Node 20+, and `.venv` at the repository root (`python3 -m venv .venv && .venv/bin/pip install -e '.[test]'`).

```bash
cd apps/desktop
npm install
npm run dist:placeholder        # placeholder page until the studio build is bundled
PATH="$HOME/.cargo/bin:$PATH" npx tauri build --debug
open "src-tauri/target/debug/bundle/macos/Paradox Desktop POC.app"
```

The placeholder page checks health, the default provider, a 401 without the token and a 201 with it. As a test hook, it also reports those results to `http://127.0.0.1:5191/report` if a listener is running there.

## Limits (proof of concept)

- The engine path is baked in at build time (this checkout's `.venv`), so the `.app` is not portable.
- Unsigned and not notarised. It runs on the machine that built it.
- No App Sandbox: the engine spawns Python, and Droid needs `sandbox-exec`.
- No Droid, no project picker, no repository cloning.
