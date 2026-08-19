/**
 * One Code's own plugin state root (pure).
 *
 * All plugin state One Code writes — marketplaces, installs, overrides, usage,
 * favorites — lives under `<agentDir>/plugins`, never under `~/.claude`.
 * `~/.claude/plugins` is a read-only input (plugins installed by Claude Code
 * keep working read-through; see lib/plugins.ts).
 *
 * Callers pass `getAgentDir()` so the root follows the distribution mode:
 * `~/.one-code/agent/plugins` under the bundled app (PI_CODING_AGENT_DIR),
 * `~/.pi/plugins` when running as a plain pi extension.
 */

import { join, relative, resolve } from "node:path";

export function pluginRoot(agentDir: string): string {
	return join(agentDir, "plugins");
}

/**
 * One path segment safe for any untrusted plugin/marketplace name (matches
 * Claude Code's sanitizer; versions keep their dots). Never empty — an
 * all-symbol name must not collapse to the parent directory.
 */
export function sanitizePathSegment(value: string, allowDots = false): string {
	const pattern = allowDots ? /[^a-zA-Z0-9\-_.]/g : /[^a-zA-Z0-9\-_]/g;
	const cleaned = value.replace(pattern, "-");
	return cleaned.length > 0 ? cleaned : "unnamed";
}

/**
 * True when `target` resolves strictly inside `base` — the containment check
 * for third-party-authored relative paths (rejects `..` escapes and absolute
 * overrides).
 */
export function pathWithinBase(base: string, target: string): boolean {
	const rel = relative(resolve(base), resolve(base, target));
	return rel !== "" && !rel.startsWith("..") && resolve(rel) !== rel;
}
