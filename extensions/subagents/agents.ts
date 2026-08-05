/**
 * Agent definition discovery (pure) — Claude Code's `.claude/agents/*.md`
 * layout: YAML frontmatter (name, description, tools, model) plus a system
 * prompt body.
 *
 * Precedence: user (~/.claude/agents) < project (<cwd>/.claude/agents).
 * Subdirectories are searched recursively.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentDefinition {
	name: string;
	description: string;
	/** Tool allowlist for the child; undefined means the child's defaults. */
	tools?: string[];
	/** Model override (pi model id, e.g. "anthropic/claude-sonnet-5"). */
	model?: string;
	systemPrompt: string;
	source: string;
}

function collectMarkdownFiles(dir: string, out: string[] = []): string[] {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			collectMarkdownFiles(full, out);
		} else if (entry.endsWith(".md")) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Frontmatter in the wild is not always valid YAML: real Claude Code plugin
 * agents contain unquoted descriptions with `: ` in them, which pi's parser
 * rejects ("Nested mappings are not allowed in compact mappings"). Falling back
 * to line-wise extraction keeps those definitions usable instead of dropping
 * them silently.
 */
function parseFrontmatterLoosely(content: string): { frontmatter: Record<string, unknown>; body: string } {
	try {
		const parsed = parseFrontmatter(content) as { frontmatter?: Record<string, unknown>; body: string };
		return { frontmatter: parsed.frontmatter ?? {}, body: parsed.body };
	} catch {
		// Fall through to the lenient path.
	}

	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {}, body: content };

	const frontmatter: Record<string, unknown> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const keyValue = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
		if (!keyValue) continue;
		const value = keyValue[2].trim().replace(/^["']|["']$/g, "");
		if (value) frontmatter[keyValue[1]] = value;
	}
	return { frontmatter, body: match[2] };
}

export function parseAgentFile(path: string, content: string): AgentDefinition | undefined {
	const { frontmatter, body } = parseFrontmatterLoosely(content);
	const fm = frontmatter;
	const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : basename(path, ".md");
	if (!body.trim()) return undefined;

	const rawTools = fm.tools;
	const tools =
		typeof rawTools === "string"
			? rawTools
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean)
			: Array.isArray(rawTools)
				? rawTools.filter((t): t is string => typeof t === "string")
				: undefined;

	return {
		name,
		description: typeof fm.description === "string" ? fm.description : "",
		tools: tools && tools.length > 0 ? tools : undefined,
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
	return [...(bundled ? [bundled] : []), join(home, ".claude", "agents"), join(cwd, ".claude", "agents")];
}

/** A directory whose agents are exposed as `<namespace>:<name>` (plugins). */
export interface AgentSource {
	dir: string;
	namespace?: string;
}

/** Later sources override earlier ones on name collisions. */
export function discoverAgents(sources: Array<string | AgentSource>): AgentDefinition[] {
	const byName = new Map<string, AgentDefinition>();
	for (const source of sources) {
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
