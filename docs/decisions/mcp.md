# MCP

Part of [Decisions](../decisions.md).

## MCP — our own client on the official SDK

pi ships no MCP support by design, so this is `extensions/mcp/` (~500 lines) on
top of `@modelcontextprotocol/sdk`. That split is the point: the SDK carries the
protocol (a genuine standard, worth depending on), and we own the thin part —
config discovery, namespacing, lifecycle, deferral.

Both community options were rejected on the checklist:

- **`pi-mcp-extension`** still peers on the pre-rename `@mariozechner/pi-*`
  packages, i.e. it has not been touched since pi moved to Earendil.
- **`pi-mcp-adapter`** is 19,284 lines with twelve dependencies including a
  native keyring binding, a browser launcher, and a TOML parser — the same
  surface-far-past-the-need profile as the packages already removed.

Design notes:

- **Config is Claude Code's format**, merged lowest-to-highest from
  `~/.claude.json`, then `.mcp.json` walked from cwd up to the repo root
  (so a monorepo root config applies in subdirectories), then
  `.claude/settings.local.json`. `$VAR`/`${VAR}` are expanded in commands, args,
  env, urls and headers. Both stdio (`command`) and remote (`url`) servers work;
  a `disabled: true` entry *removes* a server inherited from a broader scope.
- **Tools are namespaced `mcp__<server>__<tool>`**, sanitised to legal tool-name
  characters, so users' existing Claude Code permission rules match. Verified:
  a `deny: ["mcp__fixture__add_numbers"]` rule blocked the call.
- **Every MCP tool is deferred.** A few servers can contribute dozens of tools;
  putting those schemas in the prompt is what `tool_search` exists to prevent.
- **JSON Schema is converted to TypeBox explicitly** (`schema.ts`) rather than
  passing raw schemas through and hoping TypeBox's runtime checks accept them.
  Unrecognised constructs degrade to permissive types, so an unusual server
  schema means arguments pass through rather than every call being rejected.
- Servers connect once at `session_start` (their tool lists are needed before
  anything can be registered), in parallel, each with a timeout, and close on
  `session_shutdown`. A failing server is reported by name and does not affect
  the others.

One bug worth remembering, caught only by the end-to-end test: `resources/read`
returns resource *contents* (`{uri, mimeType, text|blob}`) — **not** the typed
content blocks that `tools/call` returns. Running them through the content-block
formatter yielded `[undefined content]`. They now have their own formatter, which
also summarises binary blobs instead of dumping base64 into the context.

Verified against a fixture stdio server: `.mcp.json` discovered, tool loaded via
`tool_search` and called (`mcp__fixture__add_numbers` → `SUM_IS_42`), resources
listed and read, the deny rule enforced, and the run exited in 16s with no
lingering processes.

## MCP servers with unset credentials

Found from a real run: the `github` plugin's config is
`Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}"`, and with the variable
unset our expansion produced the literal `"Bearer "`. The server then failed with
"Authorization header is badly formatted" — a confusing protocol error for what is
really a missing token.

`missingEnvVars()` now reports variables a config references but that are not set
(across command, args, env, url and headers), and such servers are **skipped with
an explanatory message** rather than connected with an empty credential:
`MCP server "github" failed: not started — GITHUB_PERSONAL_ACCESS_TOKEN not set in
the environment`.

## Background connect: session_start no longer blocks the prompt (2026-08-10)

The connect ran as an awaited `session_start` handler — and pi awaits every
extension's `session_start` serially before the interactive input loop opens
(findings §15). With two remote HTTP servers configured (user-level deepwiki
plus the context7 plugin), that made the MCP handshake **the entire perceived
startup**: 4.9s to a usable prompt measured with `PI_STARTUP_BENCHMARK`, of
which everything-but-mcp was 0.24s.

**Decision:** in the interactive main session, `connectAll` runs in the
background — `session_start` kicks it off and returns. Tools register as each
server answers (late registration is what `tool-search` was already built to
handle for exactly this producer), `/mcp` reports `still connecting` until the
connect settles, and per-server failures surface through the existing
notify-on-failure path. Measured after: 501ms to a usable prompt; both remote
servers connected and registered their tools a few seconds later while the
session was already live.

Two paths deliberately still **await** the connect:

- **Print-mode one-shots** (`!ctx.hasUI`): the single turn starts immediately
  and would race past tools that are not registered yet.
- **Subagent RPC children** (`PI_SUBAGENT_CHILD=1` — they have `hasUI: true`,
  so the env var is the discriminator): same race, and a child is often
  spawned specifically to use an MCP tool.

Hardening that came with the change: the background promise is caught (an
unhandled rejection would crash Node; per-server failures were already
collected, so the catch only guards setup bugs and surfaces them loud via
notify), and a connection that lands after `session_shutdown` is closed
immediately instead of leaking its transport. The MCP SDK import also moved
into the first `connect()` call — ~70-80ms off every startup, and a session
with zero configured servers never loads it.

Accepted trade-off: the first turn(s) of an interactive session may run before
MCP `instructions` reminders and tool registrations exist. The tools are
deferred behind `tool_search` anyway, so the model discovers them on first
search after registration.

## The /mcp panel and MCP OAuth (2026-08-20)

`/mcp` is now a Claude Code-style interactive manager instead of a one-shot
status dump. It docks below the transcript (bounded height, like `/skills` and
`/plugins`) with two views: a grouped server list ("Manage MCP servers" — User /
Project / Plugin groups, each carrying its config path) and a per-server detail
view (Status / Issue / Auth / URL / Config location + a numbered, navigable
action list). Pure state/render/keys live in `extensions/mcp/panel/`; the wiring
in `index.ts` owns the live connection state and the async actions. Because the
panel is imported by the mcp extension (one jiti module graph), it reads that
state directly — no cross-extension status bus needed (the `MCP_STATUS_*` bus
stays for `/plugins`). `deriveStatus` is the single source of truth shared by the
panel entries, the `/plugins` snapshot, and the text fallback.

**Actions.** Reconnect closes and re-runs the connect. Enable/Disable persist
across sessions through `lib/mcp-overrides.ts` → `~/.one-code` (user scope for a
server from `~/.claude.json`, else per-repo), never by writing `disabled:true`
into the user's `~/.claude.json` or a plugin's `.mcp.json` — those are borrowed
config One Code only reads (memory-state.md). A disabled server is still
discovered and listed; the mcp extension just skips connecting it.

**Authenticate = real OAuth.** The detail view's Authenticate action runs the MCP
OAuth 2.1 flow using the SDK's own `authProvider` on
`StreamableHTTPClientTransport` (v1.30.0 carries discovery, dynamic client
registration, PKCE, token exchange + refresh). We add only the host pieces:
`oauth/store.ts` (per-server credentials under `~/.one-code/mcp-auth/`, collision-
free filenames), `oauth/provider.ts` (the `OAuthClientProvider` over that store),
`oauth/callback.ts` (an ephemeral loopback catcher for the redirect — RFC 8252
§7.3 lets loopback use any port), `oauth/browser.ts` (platform browser open, no
dep), and `oauth/flow.ts` (orchestration → `finishAuth(code)` → silent reconnect).

**Startup never pops a browser.** An http server is connected *with* the provider
only when a token is already stored; otherwise it connects with *no* provider so
a 401 throws `UnauthorizedError` (no redirect) and the server is marked
`authNeeded` (OAuth kind). Two authNeeded kinds are distinguished: `oauth` (401,
`canAuthenticate` true — Authenticate opens the browser) vs `env` (a referenced
credential env var is unset, `canAuthenticate` false — the Issue line names the
variable; Authenticate can't help). Reconnect/Disable are offered instead there.

Verified live (list/detail/Disable-persist/Enable-reconnect) via the onecode-tui
driver; the OAuth browser round-trip is unit-tested (store/provider/callback) but
its live end-to-end still needs a real OAuth-backed MCP server driven through tmux.

Hardening (from review): the loopback callback buffers its result so a redirect
that lands before `waitForCode()` isn't lost (an IdP with a live session redirects
instantly); panel actions carry an in-flight guard so a double-press can't start
two concurrent connects (leaking a client) or two OAuth flows (corrupting the
shared PKCE verifier); disabling/disconnecting the last server carrying MCP
`instructions` now removes that every-turn reminder instead of leaving it stale;
the OAuth provider caches the parsed token file (the SDK reads `tokens()` per
request); and `isUnauthorized` uses `instanceof` the SDK's `UnauthorizedError`
(which sets no `.name`, so a name/message check was unreliable).
