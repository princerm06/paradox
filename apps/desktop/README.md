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

The studio is bundled **unchanged**. `npm run dist:studio` runs the studio's own `npm run build` (typecheck plus Vite) with `VITE_PARADOX_API_BASE=http://127.0.0.1:8100` and `VITE_PARADOX_SAFE_PROVIDER=1`, writing to `apps/desktop/dist` (gitignored). It never writes into `apps/studio` sources.

```bash
cd apps/desktop
npm install && (cd ../studio && npm ci)
npm run dist:studio
PATH="$HOME/.cargo/bin:$PATH" npx tauri build          # release .app
open "src-tauri/target/release/bundle/macos/Paradox Desktop POC.app"
```

Quit with ⌘Q; the engine stops with the app. App state lives in `~/Library/Application Support/dev.paradox.desktop-poc/`; delete it for a fresh start, but only while the app is closed.

`npm run dist:placeholder` swaps in a sidecar-only check page instead of the studio.

## Tests

```bash
npm run test:desktop    # needs the release .app built; quits any copy you have open
```

The suite drives the bundle exactly as the app serves it (`http://localhost:5190`), against the engine the app launched, in Playwright WebKit:
1. Fresh launch: isolated state, keyless environment, 401 without the token, 403 from a foreign origin, 422 for an explicit `droid` request.
2. The full studio workflow, with displayed evidence checked against engine records and an inspection sweep that must not mutate or activate.
3. Persistence across quit and relaunch, with a new token and the old one rejected.
4. A shell crash mid-generation, then recovery.
5. A clean quit leaves nothing running.

Debug builds only: `PARADOX_DESKTOP_SELFTEST_PORT=<port>` makes the real WKWebView report its rendered state (bound engine, token present, live timeline, provider, node count, JS errors) to `http://127.0.0.1:<port>/report`. Release builds contain no hook.

## Limits (proof of concept)

- The engine path is baked in at build time (this checkout's `.venv`), so the `.app` is not portable.
- Unsigned and not notarised. It runs on the machine that built it.
- No App Sandbox: the engine spawns Python, and Droid needs `sandbox-exec`.
- No Droid, no project picker, no repository cloning.
