# Decisions

Short notes on choices that aren't obvious from the code.

## Distribution: pi package, not a wrapper binary

pi's `piConfig` rebranding (app name, config dir) resolves from pi's *own*
installed `package.json`, so a dependent package cannot rebrand it. Shipping as
a pi package (`pi install npm:pi-claude-code`) costs nothing extra and keeps
upstream pi upgrades a version bump away. All Claude-Code-shaped paths
(`.claude/settings.json`, `.claude/commands`, `.claude/agents`) are discovered
by our own code rather than by changing pi's `.pi` namespace.

## System prompt: per-turn `before_agent_start`, not a static override

`DefaultResourceLoader.systemPromptOverride` requires SDK composition (which
would mean re-implementing pi's CLI) and is fixed at resource-load time. The
`before_agent_start` event hands us `systemPromptOptions` every turn, reflecting
the currently active tool set — needed because plan mode and deferred loading
change it. The environment block is cached per (cwd, model) so the prompt stays
byte-identical across turns and provider prompt caching still pays off.

## Tool names stay pi-idiomatic (snake_case)

pi keys its built-in overrides and typed `tool_call` events on `read`, `bash`,
`edit`, `write`, `grep`, `find`, `ls`. We register custom tools in the same
style (`todo_write`, `enter_plan_mode`, `subagent`). Users' Claude Code
permission rules still work: `matcher.ts` maps `Bash`, `Glob`, `WebFetch`,
`Task`, … onto our names. pi's Anthropic OAuth mode separately renames tools to
Claude Code's casing on the wire, so nothing is lost there either.

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

## Deferred tools (ToolSearch)

`extensions/lib/deferred.ts` holds a registry; any extension defers its own
tools by emitting `pi-claude-code:defer-tool` on the event bus. `tool-search`
deactivates them at session start, announces the names in an every-turn
`<system-reminder>` (as Claude Code does), and activates matches additively so
pi can use native deferred loading.

**Load order is load-bearing:** `tool-search` must appear before any extension
that defers a tool, because those emit during extension loading and pi's event
bus only delivers to already-registered listeners. Deferred tools also omit
`promptSnippet`/`promptGuidelines` — activating a tool that has them rebuilds
the system prompt and invalidates the cached prefix, defeating the purpose.

Verified on OpenAI (gpt-5.5): after `tool_search`, pi injected native
`tool_search_call` / `tool_search_output` items at the load point rather than
appending the schema to the request's tool array, and the model then called the
tool successfully. The Anthropic `defer_loading` path and the non-native
fallback are pi-owned code paths that could not be exercised here (no second
provider credential configured).

## Web tools

- `web_search` comes from **`pi-web-search`**: it calls the *current model
  provider's own* search API (OpenAI/Codex, Anthropic, Gemini), so there is no
  extra API key and no scraping. This is as close to Claude Code's server-side
  search as an extension can get.
- `fetch_content` comes from **`pi-web-access`** (URL → markdown, GitHub repos,
  PDFs, YouTube, images).
- Both packages register a tool named `web_search`. `extensions/web/index.ts`
  loads pi-web-access **first** so pi-web-search's zero-config provider-native
  version wins the name, while `fetch_content` is retained. Reordering those two
  lines silently switches you to the key-requiring implementation.
- All three tools (`web_search`, `fetch_content`, `url_context`) are deferred
  behind `tool_search`.
- pi-web-search also drives `setActiveTools` (to hide Gemini-only
  `url_context`). It composes with our deferral because `tool-search` loads
  earlier, so its session_start deactivation runs first and pi-web-search
  snapshots the already-reduced set.

## LSP

From **`pi-lsp-extension`** (wildcard peer ranges, unlike `lsp-pi` which pins
`pi-ai ^0.74`). Its twelve query tools are deferred; the Claude-Code-like
behavior — a `tool_result` hook that appends error diagnostics to `write`/`edit`
results — needs no tool and stays active. That hook is why diagnostics are *not*
routed through our system-reminder queue as originally planned: the package
already delivers them at a better position (in the tool result), and duplicating
the delivery would just spend tokens twice.

Three environment findings worth knowing:

1. **Gated to non-one-shot runs.** In `-p` / `--mode json` runs the language
   servers keep the process alive after the final turn (it never exits) and a
   cold server has no diagnostics for a single edit anyway. `isOneShotInvocation`
   inspects argv, because tools must be registered before any event exposes
   `ctx.mode`. RPC and TUI still get LSP; subagent children never do.
2. **Requires TypeScript 5.x for TS projects.** `typescript-language-server`
   needs `typescript/lib/tsserver.js`, which TypeScript 7's native compiler no
   longer ships — the status line reads "typescript failed" and diagnostics
   silently fall back to tree-sitter syntax checks.
3. **The auto-append hook only fires when a server is already running**, and the
   server starts lazily on the first file *read*. A read-then-edit sequence gets
   diagnostics; an edit as the very first action in a session does not.
   Verified end-to-end: an edit introducing a type error produced
   `src/index.ts:5:30 error: Argument of type 'number' is not assignable to
   parameter of type 'string'. (2345)`, matching `tsc`.

## Permission modes and subagents

Permission mode lives in the permissions extension and is exported to child
processes via `CC_PERMISSION_MODE`; a child (marked by `PI_SUBAGENT_CHILD=1`)
inherits it unless a flag overrides. Plan mode is enforced twice on purpose —
the `tool_call` gate blocks mutations, and an every-turn `<system-reminder>`
tells the model not to attempt them.
