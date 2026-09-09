#!/usr/bin/env bash
# Smoke-test the BUNDLED APP the way users actually install it, exercising pi's
# LIBRARY loader path — the one path no other check covers.
#
# Why this exists (distribution review 2026-09-09, H1): the app does
# `await import("@earendil-works/pi-coding-agent")`, which loads pi's unbundled
# dist and takes jiti's `alias` branch for extension imports. That branch
# rewrites `@earendil-works/pi-ai/<subpath>` by prefix onto pi-ai's compat entry,
# so a deep pi-ai import in an extension resolves to a dead path and the whole
# extension set fails to load — in the app only. `tsc`, vitest, the dev `pi` CLI
# and the `pi install` extension path all resolve those subpaths and never see
# the failure. This packs both tarballs, installs the app into a throwaway
# prefix, and launches `onecode -p` under a throwaway HOME, asserting the
# extension set loaded (no "Failed to load extension" on stderr).
#
# Run before every publish and after every pi pin bump.
#
# Usage: test/e2e/app-smoke.sh
# Env:   NODE_BIN_DIR to override the Node on PATH (default: the repo's nvm Node).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_BIN_DIR="${NODE_BIN_DIR:-/Users/isuruWij/.nvm/versions/node/v26.3.1/bin}"
export PATH="$NODE_BIN_DIR:$PATH"

S="$(mktemp -d "${TMPDIR:-/tmp}/onecode-app-smoke.XXXXXX")"
cleanup() { rm -rf "$S"; }
trap cleanup EXIT

echo "smoke: packing tarballs into $S"
(cd "$REPO" && npm pack --silent --pack-destination "$S" >/dev/null)
(cd "$REPO/app" && npm pack --silent --pack-destination "$S" >/dev/null)

EXT_TGZ="$(ls "$S"/one-code-extension-*.tgz)"
APP_TGZ="$(ls "$S"/one-ai-one-code-*.tgz)"

# The app exact-pins one-code-extension at a version that is not on the registry
# during development, so rewrite that dependency to the packed extension tarball,
# then repack the app — the faithful global-install layout (appendix A of the
# review).
mkdir -p "$S/app-copy"
cp "$REPO"/app/{bin.mjs,update-check.mjs,README.md,LICENSE} "$S/app-copy/"
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  p.dependencies["one-code-extension"] = "file:" + process.argv[2];
  fs.writeFileSync(process.argv[3], JSON.stringify(p, null, "\t") + "\n");
' "$REPO/app/package.json" "$EXT_TGZ" "$S/app-copy/package.json"
(cd "$S/app-copy" && npm pack --silent --pack-destination "$S" >/dev/null)
APP_LOCAL_TGZ="$(ls -t "$S"/one-ai-one-code-*.tgz | head -1)"

echo "smoke: installing the app into $S/gprefix"
npm install -g --silent --prefix "$S/gprefix" "$APP_LOCAL_TGZ" >/dev/null
BIN="$S/gprefix/bin/onecode"
[ -x "$BIN" ] || { echo "FAIL: $BIN not installed"; exit 1; }

# Scratch git project as cwd, and a throwaway HOME so nothing touches real state.
mkdir -p "$S/proj"
(cd "$S/proj" && git init -q && printf '# Smoke project\n' > CLAUDE.md && git add . && git commit -qm init)

echo "smoke: launching onecode -p (no credentials expected)"
OUT="$S/out.txt"
set +e
env -i HOME="$S/home" PATH="$PATH" TERM=xterm-256color \
  "$BIN" -p "Reply with the single word ok" >"$OUT" 2>&1
STATUS=$?
set -e

echo "--- onecode output (exit $STATUS) ---"
cat "$OUT"
echo "-------------------------------------"

if grep -q "Failed to load extension" "$OUT"; then
	echo "FAIL: an extension failed to load under the app's library loader (H1 regression)."
	exit 1
fi

# Exit 0 (ran) or the no-credential message (loaded fine, just no provider) both
# prove the extension set loaded. Anything else is a real failure.
if [ "$STATUS" -eq 0 ] || grep -q "No API key found" "$OUT"; then
	echo "PASS: extension set loaded under the bundled app."
	exit 0
fi

echo "FAIL: unexpected launch failure (exit $STATUS, no known good signal)."
exit 1
