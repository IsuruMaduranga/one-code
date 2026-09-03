/**
 * Frontmatter parsing that never throws the file away. pi's `parseFrontmatter`
 * is strict YAML and throws on the kind of thing agent/skill/command authors
 * write by hand (an unquoted colon in a description, a stray tab); a bare
 * `catch` around it silently dropped the whole file (documented trap #7). The
 * lenient fallback reads simple `key: value` lines so the file still loads with
 * whatever could be salvaged. Shared by agents, skills and plugin commands.
 */

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export function parseFrontmatterLoosely(content: string): { frontmatter: Record<string, unknown>; body: string } {
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
