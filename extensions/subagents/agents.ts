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

export function parseAgentFile(path: string, content: string): AgentDefinition | undefined {
	const { frontmatter, body } = parseFrontmatter(content) as {
		frontmatter?: Record<string, unknown>;
		body: string;
	};
	const fm = frontmatter ?? {};
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
		model: typeof fm.model === "string" ? fm.model : undefined,
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

/** Later directories override earlier ones on name collisions. */
export function discoverAgents(dirs: string[]): AgentDefinition[] {
	const byName = new Map<string, AgentDefinition>();
	for (const dir of dirs) {
		for (const file of collectMarkdownFiles(dir)) {
			try {
				const agent = parseAgentFile(file, readFileSync(file, "utf-8"));
				if (agent) byName.set(agent.name, agent);
			} catch {
				// Unreadable or malformed definition: skip it rather than failing discovery.
			}
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
