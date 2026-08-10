# Distribution & dependencies

Part of [Decisions](../decisions.md).

## Two artifacts from one codebase: the app and the package (2026-08-10, unreviewed)

One Code ships two npm packages built from this single repo:

| npm name | What it is | pi relationship |
|---|---|---|
| **`one-code`** (`app/`) | the bundled app — a `one-code` bin | **exact-pins** pi (`0.84.1`) as a dependency |
| **`one-code-extension`** (repo root) | the pi package | **peerDependency** range; runs on the user's own pi |

The split exists because the two installs need opposite dependency stances
(reproducible pin vs. ride-the-user's-pi), and nothing else: the app is a thin
launcher over the same extension set. `one-code-extension` was chosen over
`one-code-pi`, which reads as "one-code *with* pi bundled" — the opposite of
what it is. A Homebrew tap (`brew install IsuruMaduranga/one-code/one-code`)
delivers the same app and solves the Node ≥22.19 requirement via
`depends_on "node"`; a single compiled binary is not viable (pi-tui ships
per-platform native modules).

**How the app loads the extensions — package registration, not
`extensionFactories`.** The bin sets `PI_CODING_AGENT_DIR=~/.one-code/agent`
(pi's env override for its config dir) and idempotently registers the
`one-code-extension` directory from its own `node_modules` as a local-path
package in the isolated `settings.json`, then calls pi's public `main(argv)`.
pi resolves local-path package sources **in place** (no copying), so the
manifest drives everything exactly as a `pi install` would: extensions in
their load-bearing order, `pi.themes`, and the bundled agents (which resolve
relative to the extension files). The alternative — passing our factories via
`main(argv, { extensionFactories })` — was prototyped and rejected: it loads
no themes without extra plumbing, and our extensions are TypeScript that only
pi's jiti loader handles; a plain Node bin cannot import them. Verified live
from packed tarballs: themes, agents, permission prompts, session resume, and
full state isolation (`~/.one-code` created, `~/.pi` untouched, and a stale
`packages` entry in a user's pi settings cannot double-load us because the
isolated dir never reads them).

**Version drift is guarded at runtime, not by the peer range.** pi renames
settings/flags between minors (0.83→0.84: `uiMode`→`tuiMode`, and 0.84 rejects
the old flag), so the package variant warns at startup when the running pi is
outside the tested range (`extensions/lib/pi-version.ts`, wired in branding's
`session_start`; fail-silent on unparseable versions). The app never warns —
its pin is inside the range by construction. The peer range stays loose
(`>=0.83.0`); a hard range would make `pi install` fail instead of warn.

**Branding: a surgical stdout rewrite in the bin.** pi prints its own command
name from `APP_NAME` (fork-gated, resolved from pi's *own* package.json) in
two plain-stdout places: the post-TUI resume hint and `--help`. Under
isolation the resume hint `pi --session <id>` is not just mis-branded but
broken (stock pi cannot see `~/.one-code` sessions), so the bin rewrites
` pi --session ` → ` one-code --session ` on that line (matched on the label,
which carries ANSI dim codes) and standalone-word `pi` in help output only.
Nothing else is touched — TUI escape streams pass through byte-identical.
Verified: the rewritten resume command actually resumes the session. The real
fix is an upstream `PI_APP_NAME` env override PR; the rewrite shrinks then.

**Updates: pi's check suppressed, ours added.** The bin sets
`PI_SKIP_VERSION_CHECK=1` (pi's endpoint is hardcoded to its own registry) and
injects one inline JS extension (`app/update-check.mjs`) via
`extensionFactories`: a non-blocking, fail-silent fetch of
`registry.npmjs.org/one-code/latest` on session start, notifying with an
install-aware hint (`brew upgrade one-code` when the bin resolves under a
Homebrew prefix, else `npm i -g one-code`). pi's semver helpers are not
exported from the package root, so the dotted-numeric compare lives in the
app. `one-code --version` reports the app version with the pinned pi in
parentheses. Both paths live-verified (drift warning and update notice each
fired against a real TUI).

Registering the package also seeds first-run settings (`theme: "one-code"`,
`quietStartup: true`), which doubles as skipping pi's stock first-time theme
picker — the branded first run. Three hardcoded `~/.pi` paths found during
this work (quiet-startup detection, the skills listing, the Anthropic-OAuth
check) now resolve through pi's `getAgentDir()`, which honours the isolation
env var.

## Distribution: pi package, not a wrapper binary

*(Partially superseded 2026-08-10 by the two-artifact model above: a wrapper
**app** now exists alongside the package. What still stands: never fork, and
the package variant remains first-class.)*

pi's `piConfig` rebranding (app name, config dir) resolves from pi's *own*
installed `package.json`, so a dependent package cannot rebrand it. Shipping as
a pi package (`pi install npm:pi-claude-code`) costs nothing extra and keeps
upstream pi upgrades a version bump away. All Claude-Code-shaped paths
(`.claude/settings.json`, `.claude/commands`, `.claude/agents`) are discovered
by our own code rather than by changing pi's `.pi` namespace.

## Community packages: adopted where they work

Per project directive, prefer ecosystem packages over new code.

- **Adopted:** `pi-ask-user` for the AskUserQuestion role (option lists,
  multi-select, freeform, headless fallback). Bundled as a dependency and
  re-exported from `extensions/ask-user`, so users get it automatically.
- **Rejected: `pi-subagents` (0.40.0).** Its child processes were SIGKILLed by
  the parent ~29 ms after spawn in this environment (macOS, Node 26,
  pi 0.83.0), in both print and RPC mode, with our extensions absent and the
  same failure when spawning through an explicit `PI_SUBAGENT_PI_BINARY`
  wrapper. The identical child command line runs fine standalone, so the fault
  is in the package's parent-side lifecycle management, not our integration.
  `extensions/subagents` is therefore our own implementation, modeled on pi's
  official `examples/extensions/subagent`: spawn `pi --mode json -p`, parse the
  event stream, return the child's final text. Worth re-evaluating the package
  on a future release.

## Publish readiness (Phase 7)

`npm pack` produces a 69 kB / 47-file tarball: `extensions/`, `agents/`, `types/`,
README, LICENSE and `docs/decisions.md`. Every path in the `pi.extensions`
manifest is checked to be present in the tarball.

**A path install does not fetch dependencies.** Verified by installing the packed
copy from a directory: pi registered it, then every extension importing a
dependency failed to load (`Cannot find module '@modelcontextprotocol/sdk/...'`).
`pi install npm:<name>` is fine, because npm resolves the dependency tree — so
the README tells anyone installing from a checkout to run `npm install` first.

The published path was verified by simulating its layout: `npm install <tarball>`
into a scratch project (348 packages resolved), then `pi install
<scratch>/node_modules/pi-claude-code`. A fresh run listed all bundled and plugin
agents correctly.

**Portability**: `web_fetch` through `tool_search` was exercised on
`gpt-5.4`, `gpt-5.5` and `gpt-5.6-terra` — a pre-native-deferred-loading model,
a native one, and a newer family — all correct. Anthropic's `defer_loading` path
and the non-native fallback remain unexercised for lack of a credential.

**Declined:** the CC-style UI packages (`pi-cc-header`, `pi-cc-extensions`). They
are cosmetic and would add a dependency for appearance only, which fails our own
adopt-vs-build checklist.
