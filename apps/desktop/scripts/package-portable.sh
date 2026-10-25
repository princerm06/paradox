#!/bin/bash
# Builds a self-contained Paradox.app: relocatable CPython (python-build-standalone),
# pinned engine dependencies, the engine, demo app and scripted recipes, all inside
# Contents/Resources/engine. Nothing in the app refers to this checkout.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd -P)"          # apps/desktop
REPO="$(cd "$HERE/../.." && pwd -P)"
CACHE="${PARADOX_PORTABLE_CACHE:-$HOME/paradox-portable-cache}"
PBS_NAME="cpython-3.9.25+20251031-aarch64-apple-darwin-install_only.tar.gz"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20251031/cpython-3.9.25%2B20251031-aarch64-apple-darwin-install_only.tar.gz"
PBS_SHA256="$(grep " $PBS_NAME\$" "$HERE/python-build-standalone.sha256" | cut -d' ' -f1)"
STAGE="$HERE/engine-bundle"
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
# Precompile with build-machine paths stripped from the bytecode.
"$PY" -I -m compileall -q -f -s "$STAGE" -p "/engine" "$STAGE/python/lib/python3.9" "$P" >/dev/null || true

# Self-check the staged interpreter before bundling.
"$PY" -I -c "import sys; sys.path.insert(0, '$P'); import engine.api, fastapi, uvicorn, httpx, pytest, pydantic_core; print('engine-bundle ok', sys.version.split()[0])"

cd "$HERE"
npm run dist:studio >/dev/null
npx tauri build --bundles app >/dev/null
APP="$HERE/src-tauri/target/release/bundle/macos/Paradox.app"
rm -rf "$APP/Contents/Resources/engine"
ditto "$STAGE" "$APP/Contents/Resources/engine"
xattr -cr "$APP"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
mkdir -p "$HERE/release"
rm -f "$HERE/release/Paradox-arm64.zip"
ditto -c -k --keepParent "$APP" "$HERE/release/Paradox-arm64.zip"
echo "built $APP"
du -sh "$APP" "$HERE/release/Paradox-arm64.zip"
