#!/usr/bin/env bash
# Runs this harness with another profile folder in place of profile/, to try a
# product's profile during development without touching the working tree.
#
# The files git tracks or would track are copied to a folder kept per profile
# (node_modules is linked), profile/ is replaced by the given folder, and pi
# starts from that copy with an agent directory of its own inside it: its own
# settings and sessions, with this machine's logins and model list linked in.
# The session runs in the directory the script was called from.
#
# The brand comes with the profile (the product's name, state folder and
# event ids), so a profile tried this way keeps its state apart from One
# Code's. The copy is refreshed on every run; KEEP_STATE=0 also clears its
# agent directory first.
#
# Usage: scripts/run-with-profile.sh <profile-dir> [pi args…]
#   e.g. scripts/run-with-profile.sh test/fixtures/profile --mode json -p "hello"
#        scripts/run-with-profile.sh ~/wso2/bi-copilot/profile
set -euo pipefail

if [ $# -lt 1 ] || [ ! -f "$1/index.ts" ] || [ ! -f "$1/brand.json" ]; then
	echo "usage: $0 <profile-dir> [pi args…]   (the folder must hold index.ts and brand.json)" >&2
	exit 2
fi

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
profile="$(cd "$1" && pwd)"
shift
start="$PWD"

key="$(printf '%s' "$profile" | shasum | cut -c1-12)"
work="${TMPDIR:-/tmp}/profile-run-$key"
mkdir -p "$work"
# The copy is rebuilt on every run, so a file renamed or deleted in the repo does not linger in it; the session state stays.
find "$work" -mindepth 1 -maxdepth 1 ! -name .agent ! -name node_modules -exec rm -rf {} +

# A tracked file deleted in the working tree is left out, as a checkout of it would be.
git -C "$repo" ls-files -z --cached --others --exclude-standard -- . ':!profile' |
	while IFS= read -r -d '' file; do if [ -e "$repo/$file" ]; then printf '%s\0' "$file"; fi; done |
	rsync -a --from0 --files-from=- "$repo/" "$work/"
[ -e "$work/node_modules" ] || ln -s "$repo/node_modules" "$work/node_modules"
rsync -a --delete "$profile/" "$work/profile/"

agent="$work/.agent"
if [ "${KEEP_STATE:-1}" = 0 ]; then rm -rf "$agent"; fi
mkdir -p "$agent"
# This machine's logins and models, read through links; everything else is the copy's own.
real="$(cd "$repo" && node --input-type=module -e 'console.log((await import("@earendil-works/pi-coding-agent")).getAgentDir())')"
for file in auth.json models.json models-store.json; do
	if [ -e "$real/$file" ] && [ ! -e "$agent/$file" ]; then ln -s "$real/$file" "$agent/$file"; fi
done
# The settings the bundled app would write: this copy as the only package, pi's replaced built-ins off.
node --input-type=module - "$work" "$agent" <<'EOF'
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [work, agent] = process.argv.slice(2);
const load = (file) => import(pathToFileURL(join(work, "extensions/lib/app", file)).href);
const { withReplacedBuiltinsOff } = await load("replaced-builtins.mjs");
const { withCompactionKeepBackfilled } = await load("compaction-keep.mjs");
const path = join(agent, "settings.json");
const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { quietStartup: true };
const settings = withCompactionKeepBackfilled({ ...current, packages: [work], extensions: withReplacedBuiltinsOff(current.extensions).extensions }).settings;
writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
EOF

echo "profile $profile, copy in $work" >&2
cd "$start"
PI_CODING_AGENT_DIR="$agent" exec node "$work/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"
