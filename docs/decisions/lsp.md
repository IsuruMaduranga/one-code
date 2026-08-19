# LSP

Part of [Decisions](../decisions.md).

## LSP: our own client, not a package

Originally adopted **`pi-lsp-extension`** (MIT). It worked, but proved fragile in
four ways, all of which needed workarounds on our side:

1. A stale transitive import (`vscode-languageserver-protocol/node.js`, an export
   removed in 3.18) had to be pinned with an npm `override`.
2. Its language servers kept the process alive after the final turn, so `pi -p`
   **never exited**. We had to gate the whole extension off in one-shot runs,
   which meant no diagnostics there at all.
3. Its auto-append hook only fired when a server was *already* running, and
   servers started lazily on the first file **read** — so an edit as the first
   action of a session silently produced nothing.
4. Against TypeScript 7 (whose native compiler dropped `lib/tsserver.js`) the
   server failed and diagnostics **silently** degraded to tree-sitter syntax
   checks, with no signal that type checking was gone.

It also carried far more than we need: ~7000 lines and twelve tools, including
tree-sitter search, a workspace index, completions, and code actions. Claude Code
has **no** LSP tools — it only receives diagnostics after edits — so eleven of
those were beyond parity, and their schemas would crowd the prompt.

`extensions/lsp/` is now our own, ~600 lines with **zero dependencies**:
`protocol.ts` (Content-Length framing), `servers.ts` (language/server/root
detection, table taken from pi-lsp-extension), `client.ts` (spawn, initialize,
document sync, diagnostics), `format.ts` (rendering), `index.ts` (wiring).
Two behaviors only: error diagnostics appended to `edit`/`write` results, and a
deferred `lsp_diagnostics` tool. Adding hover or definition later is one
`client.request(...)` each.

Each fragility above is addressed by design:

- **No dependencies**, so no transitive protocol conflicts to pin.
- Child process and stdio handles are `unref`'d and shut down on
  `session_shutdown`, so one-shot runs exit — **the argv gate is gone and
  diagnostics now work in `-p` too**.
- Content is pushed with `didOpen`/`didChange` before every read, so an edit as
  the session's first action is covered, and answers reflect current content
  rather than whatever the server happened to cache.
- `getDiagnostics` awaits the server's next publish for that document (timeout
  plus last-known fallback) instead of sleeping a fixed interval.
- A TypeScript preflight detects the missing `tsserver.js` and returns a
  sentence explaining it, rather than degrading silently.

Diagnostics are still delivered in the tool result rather than through our
system-reminder queue: that is where the model needs them, and it costs one
delivery instead of two.

Verified end-to-end in one-shot mode: an edit introducing a type error appended
`src/index.ts:5:30 error: Argument of type 'number' is not assignable to
parameter of type 'string'. (2345) [typescript]` — matching `tsc` — the run
exited in 16s, no language-server processes leaked, the deferred tool loaded and
answered on demand, and a TypeScript 7 project returned the preflight
explanation.

## Plugin LSP servers + the diagnostics watcher (2026-08-19)

Two changes landed together; findings §18 holds the mechanics both implement
against.

**Plugin-provided servers layer on top of the built-in table, and win.**
`extensions/lsp/plugin-servers.ts` (pure) resolves each enabled plugin's
`.lsp.json` / manifest `lspServers` into `plugin:<plugin>:<server>` entries
routed by `extensionToLanguage`; an extension claimed by a plugin bypasses the
built-in table entirely — installing the plugin is explicit user intent, and
it's the only way to override a built-in server without forking the table.
Plugin servers root at `workspaceFolder ?? cwd` (the way Claude Code does —
no root-marker walk); the built-in table keeps root markers, preserving our
zero-config edge. Collisions between plugins resolve deterministically
(key-sorted, first wins) and surface in `/lsp` plus a one-time notify.
Unsupported config (`transport: "socket"`, `shutdownTimeout`,
`restartOnCrash`, `maxRestarts`, `${user_config.*}`) rejects the server loudly
with a named reason — never a plausible-but-wrong spawn. Routing is built
lazily on the first file touched, not at session_start (findings §15).

**`LspClient` refactor.** `languageId` moved from a constructor field to a
per-document parameter (`syncFile`/`getDiagnostics`) — one plugin server
process can serve several extensions with different language ids. The client
gained per-server `options` (`env` merged over process.env,
`initializationOptions` in `initialize`, `settings` answering
`workspace/configuration` via the pure `configurationResponse` helper,
`startupTimeoutMs`). Also fixed in passing: `stop()` nulled `this.child`
before `send()` read it, so shutdown/exit were never actually sent — the 1s
SIGKILL race was doing all the work.

**The per-edit `<diagnostics>` append is gone; a session watcher replaced it.**
Claude Code has no per-edit append — its passive pipeline stores every
`publishDiagnostics` and injects only the *new* ones (content-hash dedup per
file, delivered-set cleared when the file is edited again, LRU 500 files,
caps 10/file + 30 total + 4000 chars with errors surviving truncation) into
whatever turn comes next, cross-file and all severities. `extensions/lsp/
watcher.ts` (pure) implements exactly that; delivery is
`pi.sendMessage({customType: "lsp-new-diagnostics", …}, {deliverAs: "steer",
triggerTurn: false})` from a `tool_result` hook on ALL tools — pi delivers
steer messages after the current turn's tool calls, before the next LLM call,
which is the same mid-turn injection point — plus a `before_agent_start`
sweep for diagnostics that finished publishing while idle (wakeup turns,
resume). `triggerTurn` stays false: diagnostics attach to the next turn, they
never wake an idle agent. One pipeline means the double-reporting question
never arises; the `lsp_diagnostics` tool marks what it returned as delivered
so the watcher doesn't repeat it.

**One deliberate divergence:** file headers are cwd-relative, not Claude
Code's basenames — basenames make two same-named files (two `index.ts:`
sections in one block) indistinguishable, and a bug-for-bug port of a known
ambiguity isn't fidelity worth keeping.
