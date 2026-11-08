#!/usr/bin/env bash
# Runs the base harness's checks with the fixture profile in place of One
# Code's: a product replaces profile/ with its own, so the base must
# typecheck and pass its tests on any profile that fills the contract.
#
# The repository is copied (without node_modules, which is linked) to a
# temporary folder, profile/ is replaced by test/fixtures/profile/, and
# One Code's own tests (profile/test/) go with it. Then tsc and vitest run
# there. The working tree is never touched.
#
# Usage: scripts/test-base.sh [vitest args…]   (KEEP=1 keeps the copy)
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/base-suite.XXXXXX")"
cleanup() { if [ "${KEEP:-}" = 1 ]; then echo "kept: $work"; else rm -rf "$work"; fi; }
trap cleanup EXIT

rsync -a --exclude node_modules --exclude /.git --exclude '/.git-*' --exclude /profile "$repo/" "$work/"
ln -s "$repo/node_modules" "$work/node_modules"
if [ -d "$repo/app/node_modules" ]; then ln -s "$repo/app/node_modules" "$work/app/node_modules"; fi
cp -R "$repo/test/fixtures/profile" "$work/profile"

cd "$work"
echo "base suite on the fixture profile, in $work"
npx tsc --noEmit
npx vitest run "$@"
