/**
 * Agent definition discovery (pure) — Claude Code's `.claude/agents/*.md`
 * layout: YAML frontmatter (name, description, tools, disallowedTools, model)
 * plus a system prompt body.
 *
 * Tool names in `tools`/`disallowedTools` are Claude Code's (`Read`, `Edit`,
 * `Bash`, `Grep`, `Glob`, `WebFetch`, …) in every real agent file, and pi's
 * allowlist is an exact-name set over pi's snake_case names — passing CC names
 * through verbatim gave the child NO tools at all (SUBAGENT-REVIEW H2). Both
 * lists are therefore normalized through the shared CC↔pi alias table at parse
 * time; pi names and `mcp__*` names pass through unchanged.
 *
 * Precedence: user (~/.claude/agents) < project (<cwd>/.claude/agents).
 * Subdirectories are searched recursively.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatterLoosely } from "../lib/frontmatter.ts";
import { claudeUserDir } from "../lib/paths.ts";
import { normalizeToolName } from "../permissions/matcher.ts";

export interface AgentDefinition {
	name: string;
	description: string;
	/** Tool allowlist for the child (pi names); undefined means the child's defaults. */
	tools?: string[];
	/**
	 * Tool denylist (pi names): the child gets its default toolset MINUS these —
	 * Claude Code's "All tools except …" grant shape (its Explore/Plan agents),
	 * spelled `disallowedTools` in CC frontmatter; `excludeTools` is accepted as
	 * a synonym for definitions written against earlier One Code builds. Filters
	 * built-ins, extension tools, and injected custom tools alike (pi's
	 * excludeTools). Combinable with `tools`, though agents use one or the other.
	 */
	excludeTools?: string[];
	/** Model override (pi model id, e.g. "anthropic/claude-sonnet-5"). */
	model?: string;
	systemPrompt: string;
	source: string;
}

function collectMarkdownFiles(dir: string, out: string[] = []): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out; // missing or unreadable directory: nothing to discover
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		// A dangling symlink or an unreadable entry must not take the whole
		// catalog (and every Agent call) down with it — skip it (review L1).
		let isDirectory: boolean;
		try {
			isDirectory = statSync(full).isDirectory();
		} catch {
			continue;
		}
		if (isDirectory) {
			collectMarkdownFiles(full, out);
		} else if (entry.endsWith(".md")) {
			out.push(full);
		}
	}
	return out;
}

/**
 * A frontmatter tool list (comma string or YAML list) as pi tool names: Claude
 * Code spellings map through the alias table (`Glob` → `find`, `WebFetch` →
 * `web_fetch`, `Task` → `Agent`, …), pi names and `mcp__*` pass through,
 * duplicates collapse. Exported for tests.
 */
export function parseToolList(raw: unknown): string[] | undefined {
	const list =
		typeof raw === "string"
			? raw
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean)
			: Array.isArray(raw)
				? raw.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean)
				: undefined;
	if (!list || list.length === 0) return undefined;
	return [...new Set(list.map(normalizeToolName))];
}

export function parseAgentFile(path: string, content: string): AgentDefinition | undefined {
	const { frontmatter, body } = parseFrontmatterLoosely(content);
	const fm = frontmatter;
	const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : basename(path, ".md");
	if (!body.trim()) return undefined;

	// CC's key first; the One Code synonym merges in so neither spelling is lost.
	const disallowed = [...(parseToolList(fm.disallowedTools) ?? []), ...(parseToolList(fm.excludeTools) ?? [])];

	return {
		name,
		description: typeof fm.description === "string" ? fm.description : "",
		tools: parseToolList(fm.tools),
		excludeTools: disallowed.length > 0 ? [...new Set(disallowed)] : undefined,
		// "inherit" is Claude Code's way of saying "use the session model".
		model: typeof fm.model === "string" && fm.model !== "inherit" ? fm.model : undefined,
		systemPrompt: body.trim(),
		source: path,
	};
}

/**
 * Lowest to highest precedence: the catalog bundled with this package, then the
 * user's `~/.claude/agents`, then the project's `.claude/agents`. A user or
 * project definition with the same name replaces a bundled one.
 */
export function agentDirs(cwd: string, home: string, bundled?: string): string[] {
	return [...(bundled ? [bundled] : []), join(claudeUserDir(home), "agents"), join(cwd, ".claude", "agents")];
}

/** A directory whose agents are exposed as `<namespace>:<name>` (plugins). */
export interface AgentSource {
	dir: string;
	namespace?: string;
}

/** Agents defined in code (`one-code-guide`), taken as they are: never copied, so a lazy prompt stays lazy. */
export interface CodeAgents {
	agents: readonly AgentDefinition[];
}

/** Later sources override earlier ones on name collisions. */
export function discoverAgents(sources: Array<string | AgentSource | CodeAgents>): AgentDefinition[] {
	const byName = new Map<string, AgentDefinition>();
	for (const source of sources) {
		if (typeof source !== "string" && "agents" in source) {
			for (const agent of source.agents) byName.set(agent.name, agent);
			continue;
		}
		const { dir, namespace } = typeof source === "string" ? { dir: source, namespace: undefined } : source;
		for (const file of collectMarkdownFiles(dir)) {
			try {
				const agent = parseAgentFile(file, readFileSync(file, "utf-8"));
				if (!agent) continue;
				const name = namespace ? `${namespace}:${agent.name}` : agent.name;
				byName.set(name, { ...agent, name });
			} catch {
				// Unreadable or malformed definition: skip it rather than failing discovery.
			}
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Tools a child cannot function without, re-added when an agent file's `tools`
 * allowlist omits them: pi's allowlist filters built-ins, extension tools AND
 * injected custom tools by exact name, so a CC-style `tools: Read, Grep` would
 * otherwise also strip the child's report channel (`SendMessage` → main), its
 * deferred-tool loader and the runtime's `structured_output`. Claude Code's
 * allowlist never strips its own plumbing either.
 */
const ALLOWLIST_ESSENTIALS = ["SendMessage", "tool_search", "structured_output"];

/** Apply an agent's allowlist to pi's `tools` option, keeping the essentials. */
export function childToolAllowlist(tools: string[] | undefined): string[] | undefined {
	if (!tools) return undefined;
	return [...new Set([...tools, ...ALLOWLIST_ESSENTIALS])];
}

/**
 * The names of an agent's `tools` allowlist that pi actually registered. Empty
 * means the list named no real tool (CC spellings that missed the alias table,
 * typos), which must fail loud rather than run a tool-less agent that
 * "completes" with an excuse. Judged against the agent's OWN list — an agent
 * that deliberately lists only `SendMessage` is narrow, not broken.
 */
export function usableAllowlistedTools(registered: string[], allowlist: string[]): string[] {
	const available = new Set(registered);
	return allowlist.filter((name) => available.has(name));
}
