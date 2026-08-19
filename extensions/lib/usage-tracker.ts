/**
 * Skill/command invocation counters (pure fs, no pi imports).
 *
 * `<plugin root>/usage.json`: `{version: 1, entries: {"<kind>:<key>":
 * {count, lastUsedAt}}}`. Feeds the /plugins Installed tab's recency labels
 * ("never used", "3× 120d") and its "Not used recently" grouping.
 *
 * Writes are a synchronous read-modify-write per invocation — Node is
 * single-threaded and every fs call here is sync, so there is no interleaving
 * window to debounce away; a timer-based debounce would only ADD an async gap
 * (and a lost-write risk at process exit).
 */

import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./atomic-write.ts";

const FILE = "usage.json";

export type UsageKind = "skill" | "command" | "mcpTool";

export interface UsageEntry {
	count: number;
	lastUsedAt: string;
}

export function usageKey(kind: UsageKind, key: string): string {
	return `${kind}:${key}`;
}

export function readUsage(root: string): Record<string, UsageEntry> {
	const parsed = readJsonFile<{ entries?: Record<string, unknown> }>(join(root, FILE));
	if (!parsed?.entries || typeof parsed.entries !== "object") return {};
	const entries: Record<string, UsageEntry> = {};
	for (const [key, value] of Object.entries(parsed.entries)) {
		const entry = value as { count?: unknown; lastUsedAt?: unknown };
		if (typeof entry?.count === "number" && typeof entry?.lastUsedAt === "string") {
			entries[key] = { count: entry.count, lastUsedAt: entry.lastUsedAt };
		}
	}
	return entries;
}

export function recordUsage(root: string, kind: UsageKind, key: string, now: Date = new Date()): void {
	// Best-effort bookkeeping: a write failure (disk full, unwritable root)
	// must never take down the skill/command invocation being recorded.
	try {
		const path = join(root, FILE);
		const existing = readJsonFile<{ version?: unknown; entries?: Record<string, unknown> }>(path) ?? {};
		const entries = { ...(typeof existing.entries === "object" && existing.entries ? existing.entries : {}) };
		const id = usageKey(kind, key);
		const previous = entries[id] as { count?: unknown } | undefined;
		const count = typeof previous?.count === "number" ? previous.count + 1 : 1;
		entries[id] = { count, lastUsedAt: now.toISOString() };
		writeJsonAtomic(path, { ...existing, version: 1, entries });
	} catch {
		// Usage stats are display-only; losing one tick is fine.
	}
}

/** "never used" | "1× today" | "3× 120d" — the Installed tab's recency label. */
export function formatRecency(entry: UsageEntry | undefined, now: Date = new Date()): string {
	if (!entry) return "never used";
	const last = Date.parse(entry.lastUsedAt);
	if (Number.isNaN(last)) return "never used";
	const days = Math.max(0, Math.floor((now.getTime() - last) / 86_400_000));
	return `${entry.count}× ${days === 0 ? "today" : `${days}d`}`;
}
