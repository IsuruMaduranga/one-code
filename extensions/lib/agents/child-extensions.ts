/**
 * The curated extensions every in-process child session loads: a subagent
 * (agents/subagents/runner.ts) and a workflow agent (agents/workflow/agent-session.ts) alike.
 * They go in through `additionalExtensionPaths`, which the loader loads even
 * under `noExtensions`. Broadly Claude Code's model: a child gets project
 * context, file freshness and a working toolset (search, skills, web, notebook),
 * but NOT the frontier chrome (banner, spinner, recap) or the orchestration
 * extensions. Nested spawning is an injected tool instead (agents/subagents/index.ts).
 *
 * `lsp` is deliberately NOT here (matching Claude Code, findings §17.3): a child
 * session is torn down with the raw `AgentSession.dispose()`, which never fires
 * `session_shutdown`, so lsp's cleanup would never run and any language server
 * it started would leak for the life of the parent session. MCP is not listed
 * either: its tools are shared in from the parent as customTools
 * (lib/plugins/mcp-share.ts `watchMcpTools`), not reconnected.
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
 * loader's `noContextFiles`, because instructions injects `# claudeMd` itself.
 */

import { join } from "node:path";
import { EXTENSIONS_DIR } from "../core/package-root.ts";
import { memoOn } from "../core/text-spans.ts";
import { featureOfEntry, TOOL_FEATURES } from "../profile/features.ts";
import type { LiveTools } from "../profile/live-tools.ts";
import { brandedId } from "../profile/brand.mjs";
import { activeProfile, requireText, type ResolvedProfile } from "../profile/profile.ts";
import type { ProfileText } from "../profile/profile-contract.ts";

// Entry files under `extensions/`. A `child.ts` entry is child-specific:
// `tool-call-corruption/child.ts` blocks damaged OpenRouter calls like the main session's, before the hook and
// permission gates (which load after these paths), but prints nothing. The
// shell tools are One Code's, as in the main session: without them a child ran
// pi's built-in bash (timeout in seconds, no default) while a fork advertised
// ours (milliseconds), and had no PowerShell tool. A child binds without a UI
// (mode "print"), so `run_in_background` runs blocking there and nothing a
// child starts outlives it (Claude Code kills an agent's shells as it exits).
export const CHILD_EXTENSIONS = [
	"request/kept-thinking/index.ts", "request/ledger/index.ts", "request/system-reminder/index.ts", "request/tool-search/index.ts", "request/context-management/index.ts", "context/compaction/index.ts", "request/ledger/wire.ts", "request/cache-marks/index.ts", "context/instructions/index.ts", "request/tool-call-corruption/child.ts",
	"safety/file-tracker/index.ts", "tools/search-tools/index.ts", "tools/tool-style/child.ts", "tools/skill/index.ts", "tools/bash/child.ts", "tools/powershell/child.ts", "tools/web/index.ts", "tools/web-fetch/index.ts", "tools/notebook/index.ts",
];

/** Loaded after everything else a child loads, a product's own child extensions included: its `tool_result` handler redacts what theirs return (safety/secret-values). */
export const LAST_CHILD_EXTENSION = "safety/secret-values/index.ts";

const entryPath = (entry: string) => join(EXTENSIONS_DIR, entry);

export const CHILD_EXTENSION_PATHS = [...CHILD_EXTENSIONS, LAST_CHILD_EXTENSION].map(entryPath);

/**
 * What a child session loads under the profile in force: the base entries
 * whose feature is on (an off feature's entry would no-op anyway; leaving it
 * out keeps the child's load list honest), then the profile's own child
 * extensions (`Profile.childExtensions`), after every base entry, then the
 * redaction of secret values, last.
 */
export function childExtensionPaths(): string[] {
	const profile = activeProfile();
	const base = CHILD_EXTENSIONS.filter((entry) => {
		const id = featureOfEntry(entry);
		return id === undefined || profile.features.has(id);
	}).map(entryPath);
	return [...base, ...profile.childExtensionPaths, entryPath(LAST_CHILD_EXTENSION)];
}

/** The features a child session loads an entry of. */
const CHILD_FEATURES = new Set(CHILD_EXTENSIONS.map(featureOfEntry));

/** The tools the subagent runtime hands a child itself: the nested Agent, and SendMessage to its caller (agents/subagents/index.ts). */
const HANDED_TO_CHILDREN: ReadonlySet<string> = new Set(["Agent", "SendMessage"]);

const childView = memoOn((profile: ResolvedProfile): { live: LiveTools; text: ProfileText } => {
	const live: LiveTools = {
		has: (name) => {
			const feature = TOOL_FEATURES[name];
			return profile.live.has(name) && (feature === undefined || CHILD_FEATURES.has(feature) || HANDED_TO_CHILDREN.has(name));
		},
	};
	return { live, text: profile.textFor(live) };
});

/** The channel a session's extensions ask "is this a child session?" on; only a child loader's event bus answers. */
const CHILD_PROBE_CHANNEL = brandedId("child-session-probe");

/**
 * Make `bus` a child session's: it answers the probe. The loader of every
 * in-process child session passes such a bus (lib/agents/agent-loader.ts).
 */
export function markChildBus<B extends { on(channel: string, handler: (data: unknown) => void): unknown }>(bus: B): B {
	bus.on(CHILD_PROBE_CHANNEL, (data) => {
		(data as { child: boolean }).child = true;
	});
	return bus;
}

/**
 * What a session's extension reads the profile through: the tools the
 * session can have and the profile's text built for them. A child session
 * loads the same module copies as the main one (pi caches an entry's
 * factory per directory), so nothing at module scope can tell the two
 * apart; the session's own event bus can. Every entry a child loads reads
 * the profile through this (`child-session-view.test.ts`), never through
 * `toolLive` or `requireText`, which answer for the main session.
 */
export interface SessionView {
	child: boolean;
	live: LiveTools;
	/** The profile's text group for this session's tools; stops the process when the profile lacks it, as `requireText` does. */
	text<K extends keyof ProfileText>(group: K): NonNullable<ProfileText[K]>;
}

export function sessionView(pi: { events: { emit(channel: string, data: unknown): void } }): SessionView {
	const probe = { child: false };
	pi.events.emit(CHILD_PROBE_CHANNEL, probe);
	if (!probe.child) return { child: false, live: activeProfile().live, text: requireText };
	const view = childView(activeProfile());
	return { child: true, live: view.live, text: (group) => view.text[group] ?? requireText(group) };
}

/**
 * Which tools a child session can have: a tool the profile leaves on whose
 * feature a child loads (no background, task, plan-mode, ask-user or
 * workflow tools), and the two a subagent is handed. A workflow agent has
 * neither of those two; the shell text names them only to forbid one, which
 * a subagent must still hear. A resident's cron proxies count as absent: no
 * text of a child's own tools names them.
 */
export const childLive = (): LiveTools => childView(activeProfile()).live;

/**
 * The profile's text for a child session's tools (`childLive`), for the
 * tools a child registers itself. A fork still sends the parent's tool
 * definitions, from the parent's captured request (agents/subagents/fork-cache.ts).
 */
export const childText = (): ProfileText => childView(activeProfile()).text;
