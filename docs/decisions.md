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

## Permission modes and subagents

Permission mode lives in the permissions extension and is exported to child
processes via `CC_PERMISSION_MODE`; a child (marked by `PI_SUBAGENT_CHILD=1`)
inherits it unless a flag overrides. Plan mode is enforced twice on purpose —
the `tool_call` gate blocks mutations, and an every-turn `<system-reminder>`
tells the model not to attempt them.
