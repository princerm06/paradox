#!/bin/bash
# Builds the Factory Droid DEMO app (demo-only, not a hardened release): the portable
# Paradox.app plus a bundled Node runtime, the built Droid SDK adapter and the Droid CLI.
# Output: release-droid-demo/Paradox-Droid-Demo-arm64.zip. Never touches the scripted
# recording build (release/Paradox-arm64.zip). No Factory key is ever bundled.
set -euo pipefail
if [ "${PARADOX_BUILD_CLEAN:-}" != 1 ]; then
  exec /usr/bin/env -i HOME="$HOME" USER="$(id -un)" TMPDIR="${TMPDIR:-/tmp}" \
    PATH="$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    PARADOX_BUILD_CLEAN=1 PARADOX_PORTABLE_CACHE="${PARADOX_PORTABLE_CACHE:-$HOME/paradox-portable-cache}" \
    PARADOX_DEMO_NODE="${PARADOX_DEMO_NODE:-/usr/local/bin/node}" \
    PARADOX_DEMO_DROID="${PARADOX_DEMO_DROID:-$HOME/.local/bin/droid}" \
    PARADOX_RECORDING_ZIP="${PARADOX_RECORDING_ZIP:-$HOME/paradox-worktrees/desktop-portable/apps/desktop/release/Paradox-arm64.zip}" \
    PARADOX_DEMO_KEY_SERVICE="paradox-offline-build-$(uuidgen)" /bin/bash "$0" "$@"
fi
HERE="$(cd "$(dirname "$0")/.." && pwd -P)"          # apps/desktop
REPO="$(cd "$HERE/../.." && pwd -P)"
CACHE="${PARADOX_PORTABLE_CACHE:-$HOME/paradox-portable-cache}"
PBS_NAME="cpython-3.9.25+20251031-aarch64-apple-darwin-install_only.tar.gz"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20251031/cpython-3.9.25%2B20251031-aarch64-apple-darwin-install_only.tar.gz"
PBS_SHA256="$(grep " $PBS_NAME\$" "$HERE/python-build-standalone.sha256" | cut -d' ' -f1)"
STAGE="$HERE/engine-bundle-droid-demo"
FALLBACK="$PARADOX_RECORDING_ZIP"
FALLBACK_SHA256="977061a6eb62f13cdc9e604ad1d07c9fbf1f680e7dfa2dfe00e4e802b38e9595"
verify_fallback() { echo "$FALLBACK_SHA256  $FALLBACK" | shasum -a 256 -c -; }
verify_fallback
trap 'status=$?; verify_fallback || exit 1; exit "$status"' EXIT
git -C "$REPO" diff --quiet HEAD -- apps/desktop apps/studio engine demo_app tests/fixtures/scripted_agent
SOURCE_SHA="$(git -C "$REPO" rev-parse HEAD)"
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
echo "ed4fc8782d87cabd781b81d35cc48a194365616463c24b9e0f2d1e6379dddc13  $STAGE/node/bin/node" | shasum -a 256 -c -
echo "fc61a51b3b65d913d828eebb10ebb441915d453cd6c6ae3cab78a16e459e4038  $STAGE/bin/droid" | shasum -a 256 -c -
"$STAGE/node/bin/node" --version >/dev/null
ADAPTER="$P/engine/droid_adapter"
[ -f "$ADAPTER/dist/adapter.js" ] || { echo "adapter not built: run npm ci && npm run build in engine/droid_adapter" >&2; exit 1; }
cp "$REPO/engine/droid_adapter/package.json" "$REPO/engine/droid_adapter/package-lock.json" "$ADAPTER/"
rsync -a "$REPO/engine/droid_adapter/node_modules" "$ADAPTER/"
(cd "$ADAPTER" && npm prune --omit=dev --no-audit --no-fund >/dev/null)
{
  echo "node $("$STAGE/node/bin/node" --version) sha256=$(shasum -a 256 "$STAGE/node/bin/node" | cut -d' ' -f1)"
  echo "droid 0.249.0 (SHA-pinned input; CLI not executed during packaging) sha256=$(shasum -a 256 "$STAGE/bin/droid" | cut -d' ' -f1)"
  echo "droid-sdk $(cd "$ADAPTER" && "$STAGE/node/bin/node" -p 'require("./node_modules/@factory/droid-sdk/package.json").version')"
} > "$STAGE/DROID-DEMO-COMPONENTS.txt"
printf '%s\n' "$SOURCE_SHA" > "$STAGE/SOURCE_SHA"
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
echo "built $APP"
du -sh "$APP" "$OUT/Paradox-Droid-Demo-arm64.zip"
shasum -a 256 "$OUT/Paradox-Droid-Demo-arm64.zip"
