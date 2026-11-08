#!/usr/bin/env bash
# Runs the base harness's checks with the fixture profile in place of One
# Code's: a product replaces profile/ with its own, so the base must
# typecheck and pass its tests on any profile that fills the contract.
#
# The files git tracks or would track (what a checkout holds; node_modules
# is linked) are copied to a temporary folder, profile/ is replaced by
# test/fixtures/profile/, and One Code's own tests (profile/test/) go with
# it. Then tsc and vitest run there. The working tree is never touched.
#
# Usage: scripts/test-base.sh [vitest args…]   (KEEP=1 keeps the copy)
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/base-suite.XXXXXX")"
cleanup() { if [ "${KEEP:-}" = 1 ]; then echo "kept: $work"; else rm -rf "$work"; fi; }
trap cleanup EXIT

# A tracked file deleted in the working tree is left out, as a checkout of it would be.
git -C "$repo" ls-files -z --cached --others --exclude-standard -- . ':!profile' |
	while IFS= read -r -d '' file; do if [ -e "$repo/$file" ]; then printf '%s\0' "$file"; fi; done |
	rsync -a --from0 --files-from=- "$repo/" "$work/"
ln -s "$repo/node_modules" "$work/node_modules"
if [ -d "$repo/app/node_modules" ]; then ln -s "$repo/app/node_modules" "$work/app/node_modules"; fi
cp -R "$repo/test/fixtures/profile" "$work/profile"

cd "$work"
echo "base suite on the fixture profile, in $work"
npx tsc --noEmit
npx vitest run "$@"
