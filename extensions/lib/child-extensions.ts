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
 * Order mirrors the package's load order: the reminder and deferral sinks
 * (system-reminder, tool-search) first, before anything emitting on their
 * channels (the bus does not replay). A caller that loads these must set the
 * loader's `noContextFiles`, because claude-context injects `# claudeMd` itself.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export const CHILD_EXTENSIONS = ["system-reminder", "tool-search", "claude-context", "file-tracker", "search-tools", "skill", "web", "web-fetch", "notebook"];

export const CHILD_EXTENSION_PATHS = CHILD_EXTENSIONS.map((name) => join(EXTENSIONS_DIR, name, "index.ts"));
