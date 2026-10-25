#!/bin/bash
# Builds the Factory Droid DEMO app (demo-only, not a hardened release): the portable
# Paradox.app plus a bundled Node runtime, the built Droid SDK adapter and the Droid CLI.
# Output: release-droid-demo/Paradox-Droid-Demo-arm64.zip. Never touches the scripted
# recording build (release/Paradox-arm64.zip). No Factory key is ever bundled.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd -P)"          # apps/desktop
REPO="$(cd "$HERE/../.." && pwd -P)"
CACHE="${PARADOX_PORTABLE_CACHE:-$HOME/paradox-portable-cache}"
PBS_NAME="cpython-3.9.25+20251031-aarch64-apple-darwin-install_only.tar.gz"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20251031/cpython-3.9.25%2B20251031-aarch64-apple-darwin-install_only.tar.gz"
PBS_SHA256="$(grep " $PBS_NAME\$" "$HERE/python-build-standalone.sha256" | cut -d' ' -f1)"
STAGE="$HERE/engine-bundle-droid-demo"
FALLBACK="$HERE/release/Paradox-arm64.zip"
fallback_hash() { [ -f "$FALLBACK" ] && shasum -a 256 "$FALLBACK" | cut -d" " -f1 || echo absent; }
FALLBACK_BEFORE="$(fallback_hash)"
NODE_SRC="${PARADOX_DEMO_NODE:-$(command -v node)}"
DROID_SRC="${PARADOX_DEMO_DROID:-$(readlink -f "$HOME/.local/bin/droid")}"
export PATH="$HOME/.cargo/bin:$PATH"

mkdir -p "$CACHE"
[ -f "$CACHE/$PBS_NAME" ] || curl -fsSL -o "$CACHE/$PBS_NAME" "$PBS_URL"
echo "$PBS_SHA256  $CACHE/$PBS_NAME" | shasum -a 256 -c - >/dev/null

rm -rf "$STAGE" && mkdir -p "$STAGE"
tar -xzf "$CACHE/$PBS_NAME" -C "$STAGE"                 # -> $STAGE/python
PY="$STAGE/python/bin/python3.9"
"$PY" -I -m pip install --quiet --no-cache-dir --only-binary=:all: --no-warn-script-location -r "$HERE/engine-requirements.txt"
# Trim what the engine never uses.
L="$STAGE/python/lib/python3.9"
rm -rf "$L/test" "$L/idlelib" "$L/tkinter" "$L/turtledemo" "$L/ensurepip" "$L/lib2to3/tests" \
       "$STAGE/python/lib/tcl"* "$STAGE/python/lib/tk"* "$STAGE/python/lib/itcl"* "$STAGE/python/lib/thread"* \
       "$STAGE/python/include" "$STAGE/python/share"
find "$STAGE/python" -name "__pycache__" -prune -exec rm -rf {} +
# pip's console scripts carry absolute shebangs to this staging dir; the engine uses `python -m`.
find "$STAGE/python/bin" -type f ! -name "python3.9" -delete
find "$STAGE/python/bin" -type l ! -name python ! -name python3 -delete

P="$STAGE/paradox"
mkdir -p "$P/tests/fixtures"
rsync -a --exclude node_modules --exclude __pycache__ --exclude research "$REPO/engine" "$P/"
rsync -a --exclude __pycache__ "$REPO/demo_app" "$P/"
rsync -a "$REPO/tests/fixtures/scripted_agent" "$P/tests/fixtures/"
# Droid demo additions: Node (thinned to arm64), the Droid CLI, the adapter with production deps.
mkdir -p "$STAGE/node/bin" "$STAGE/bin"
lipo "$NODE_SRC" -thin arm64 -output "$STAGE/node/bin/node" 2>/dev/null || cp "$NODE_SRC" "$STAGE/node/bin/node"
cp "$DROID_SRC" "$STAGE/bin/droid"
chmod 0755 "$STAGE/node/bin/node" "$STAGE/bin/droid"
"$STAGE/node/bin/node" --version >/dev/null
ADAPTER="$P/engine/droid_adapter"
[ -f "$ADAPTER/dist/adapter.js" ] || { echo "adapter not built: run npm ci && npm run build in engine/droid_adapter" >&2; exit 1; }
cp "$REPO/engine/droid_adapter/package.json" "$REPO/engine/droid_adapter/package-lock.json" "$ADAPTER/"
rsync -a "$REPO/engine/droid_adapter/node_modules" "$ADAPTER/"
(cd "$ADAPTER" && npm prune --omit=dev --no-audit --no-fund >/dev/null)
{
  echo "node $("$STAGE/node/bin/node" --version) sha256=$(shasum -a 256 "$STAGE/node/bin/node" | cut -d' ' -f1)"
  echo "droid $("$STAGE/bin/droid" --version 2>/dev/null | head -1) sha256=$(shasum -a 256 "$STAGE/bin/droid" | cut -d' ' -f1)"
  echo "droid-sdk $(cd "$ADAPTER" && "$STAGE/node/bin/node" -p 'require("./node_modules/@factory/droid-sdk/package.json").version')"
} > "$STAGE/DROID-DEMO-COMPONENTS.txt"
# Precompile with build-machine paths stripped from the bytecode.
"$PY" -I -m compileall -q -f -s "$STAGE" -p "/engine" "$STAGE/python/lib/python3.9" "$P" >/dev/null || true

# Self-check the staged interpreter before bundling.
"$PY" -I -c "import sys; sys.path.insert(0, '$P'); import engine.api, fastapi, uvicorn, httpx, pytest, pydantic_core; print('engine-bundle ok', sys.version.split()[0])"
PATH="$STAGE/node/bin:$STAGE/bin:/usr/bin:/bin" "$STAGE/node/bin/node" "$P/engine/droid_adapter/dist/adapter.js" --probe >/dev/null && echo "adapter probe ok"

cd "$HERE"
npm run dist:studio >/dev/null
npx tauri build --bundles app >/dev/null
APP="$HERE/src-tauri/target/release/bundle/macos/Paradox Droid Demo.app"
rm -rf "$APP/Contents/Resources/engine"
ditto "$STAGE" "$APP/Contents/Resources/engine"
xattr -cr "$APP"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
OUT="$HERE/release-droid-demo"
mkdir -p "$OUT"
rm -f "$OUT/Paradox-Droid-Demo-arm64.zip"
ditto -c -k --keepParent "$APP" "$OUT/Paradox-Droid-Demo-arm64.zip"
FALLBACK_AFTER="$(fallback_hash)"
[ "$FALLBACK_BEFORE" = "$FALLBACK_AFTER" ] || { echo "recording build changed: $FALLBACK_BEFORE -> $FALLBACK_AFTER" >&2; exit 1; }
echo "built $APP"
du -sh "$APP" "$OUT/Paradox-Droid-Demo-arm64.zip"
shasum -a 256 "$OUT/Paradox-Droid-Demo-arm64.zip"
