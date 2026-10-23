/**
 * The curated extensions every in-process child session loads: a subagent
 * (subagents/runner.ts) and a workflow agent (workflow/agent-session.ts) alike.
 * They go in through `additionalExtensionPaths`, which the loader loads even
 * under `noExtensions`. Broadly Claude Code's model: a child gets project
 * context, file freshness and a working toolset (search, skills, web, notebook),
 * but NOT the frontier chrome (banner, spinner, recap) or the orchestration
 * extensions. Nested spawning is an injected tool instead (subagents/index.ts).
 *
 * `lsp` is deliberately NOT here (matching Claude Code, findings §17.3): a child
 * session is torn down with the raw `AgentSession.dispose()`, which never fires
 * `session_shutdown`, so lsp's cleanup would never run and any language server
 * it started would leak for the life of the parent session. MCP is not listed
 * either: its tools are shared in from the parent as customTools
 * (lib/mcp-share.ts `watchMcpTools`), not reconnected.
 *
 * Order mirrors the package's load order: kept-thinking first (the first
 * `context` hook, before anything reads the messages), the ledger's request
 * side next (it cuts the request to its tail before anything injects), then
 * the reminder and deferral sinks (system-reminder, tool-search), before
 * anything emitting on their channels (the bus does not replay), then
 * context-management and compaction as in the main session (a child's requests
 * carry the same thinking edit, and a fork that crosses its threshold is
 * summarized by replaying its own last request, not by pi's uncached default
 * summarizer), then the ledger's payload side, after every hook that shapes
 * the tail and before cache-marks. A child has its own event bus (pi's
 * resource loader makes one per loader), so its captures never reach the
 * parent's side calls. A fork's file is a copy of the parent's, records included, so
 * its first request extends the parent's last one and reads its cache. A caller that loads these must set the
 * loader's `noContextFiles`, because claude-context injects `# claudeMd` itself.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

// A name with a slash is a child-specific entry file: `tool-call-corruption/child`
// blocks damaged OpenRouter calls like the main session's, before the hook and
// permission gates (which load after these paths), but prints nothing. The
// shell tools are One Code's, as in the main session: without them a child ran
// pi's built-in bash (timeout in seconds, no default) while a fork advertised
// ours (milliseconds), and had no PowerShell tool. A child binds without a UI
// (mode "print"), so `run_in_background` runs blocking there and nothing a
// child starts outlives it (Claude Code kills an agent's shells as it exits).
export const CHILD_EXTENSIONS = [
	"kept-thinking", "ledger", "system-reminder", "tool-search", "context-management", "compaction", "ledger/wire", "cache-marks", "claude-context", "tool-call-corruption/child",
	"file-tracker", "search-tools", "skill", "bash/child", "powershell/child", "web", "web-fetch", "notebook",
];

export const CHILD_EXTENSION_PATHS = CHILD_EXTENSIONS.map((name) =>
	name.includes("/") ? join(EXTENSIONS_DIR, `${name}.ts`) : join(EXTENSIONS_DIR, name, "index.ts"));
