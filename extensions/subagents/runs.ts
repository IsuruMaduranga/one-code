/**
 * Named-run bookkeeping for subagents — what send_message resolves against.
 *
 * Every persisted child run gets a name (explicit or `<agent>-<n>`) and a task
 * id. Records ride in tool-result details, so the map is reconstructable from
 * the session branch after a resume; the session files themselves live on disk
 * under the per-run session dir.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface AgentRunRecord {
	name: string;
	agent: string;
	taskId: string;
	/** Directory the run's session file was created under (searched lazily). */
	sessionSearchDir: string;
	/** Resolved session file, once known. */
	sessionFile?: string;
	cwd: string;
	/** True when `cwd` is an isolation worktree, so a resume re-applies the git-isolation guard. */
	worktree?: boolean;
	model?: string;
	thinking?: string;
	/**
	 * Nesting level: 0 = spawned by main, 1 = spawned by a child's own Agent
	 * tool. Set once at creation and read by every spawn-tool handout (the
	 * MAX_SPAWN_DEPTH gate), so a RESUMED grandchild stays capped too. Absent
	 * on records from before nesting existed (treated as 0).
	 */
	depth?: number;
	/**
	 * The run completed inline in a one-shot session (`-p` / `--mode json`): its
	 * report was returned in the tool result and no background task was ever
	 * registered, so `task_output` does not know its id.
	 */
	inline?: boolean;
}

/** `<agent>-<n>` with the lowest n not already taken. */
export function nextRunName(existing: Iterable<string>, agent: string): string {
	const taken = new Set(existing);
	for (let n = 1; ; n++) {
		const candidate = `${agent}-${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/**
 * The name a new run gets: the requested one when free, else a fresh
 * `<agent>-<n>`. A run name is an identifier for the whole session, so a reused
 * one is replaced rather than shadowing the older run (which would vanish from
 * list_agents while still running). `note` is the model-facing explanation
 * when the request was overridden; the caller prepends it to the spawn result.
 * Shared by the main Agent tool and the nested spawn tool.
 */
export function resolveRunName(
	registry: Pick<RunRegistry, "names" | "resolve" | "reserve">,
	agent: string,
	requested: string | undefined,
): { name: string; note?: string } {
	const taken = new Set(registry.names());
	const wanted = requested?.trim();
	// Reserved synchronously: pi runs a message's tool calls in parallel, and the
	// record is only added after async work (worktree creation, model checks), so
	// two same-turn spawns would otherwise both pick "explore-1".
	if (wanted && !taken.has(wanted)) {
		registry.reserve(wanted);
		return { name: wanted };
	}
	const name = nextRunName(taken, agent);
	registry.reserve(name);
	if (!wanted) return { name };
	return {
		name,
		note: `Note: the name "${wanted}" is already used by task ${registry.resolve(wanted)?.taskId ?? "?"} in this session; this run is named "${name}".`,
	};
}

/** Newest .jsonl under `dir` (recursive) — the child session pi created there. */
export function findSessionFile(dir: string): string | undefined {
	let newest: { path: string; mtime: number } | undefined;
	const walk = (current: string) => {
		let entries: string[];
		try {
			entries = readdirSync(current);
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(current, entry);
			let stats;
			try {
				stats = statSync(path);
			} catch {
				continue;
			}
			if (stats.isDirectory()) walk(path);
			else if (entry.endsWith(".jsonl") && (!newest || stats.mtimeMs > newest.mtime)) {
				newest = { path, mtime: stats.mtimeMs };
			}
		}
	};
	walk(dir);
	return newest?.path;
}

export class RunRegistry {
	private byName = new Map<string, AgentRunRecord>();
	private byId = new Map<string, AgentRunRecord>();
	/** Names picked for runs whose record has not been added yet (see resolveRunName). */
	private reserved = new Set<string>();

	/** Drop every record — a new session (/clear) starts with no runs to address. */
	clear(): void {
		this.byName.clear();
		this.byId.clear();
		this.reserved.clear();
	}

	/** Hold a name until its record is added (a spawn that fails validation leaves it held — harmless). */
	reserve(name: string): void {
		this.reserved.add(name);
	}

	/** Latest wins per name, matching Claude Code's semantics. */
	add(record: AgentRunRecord): void {
		this.reserved.delete(record.name);
		this.byName.set(record.name, record);
		this.byId.set(record.taskId, record);
	}

	/** Every name in use: recorded runs plus names reserved for runs being spawned. */
	names(): string[] {
		return [...new Set([...this.byName.keys(), ...this.reserved])];
	}

	/** Every spawned run, latest-per-name (what list_agents enumerates). */
	list(): AgentRunRecord[] {
		return [...this.byName.values()];
	}

	/** Resolve by name, exact task id, or unique task-id prefix (3+ chars). */
	resolve(ref: string): AgentRunRecord | undefined {
		const named = this.byName.get(ref) ?? this.byId.get(ref);
		if (named) return named;
		// An empty or near-empty ref would prefix-match whatever run happens to
		// exist ("".startsWith("") is true) and deliver to the wrong target.
		if (ref.length < 3) return undefined;
		const matches = [...this.byId.values()].filter((r) => r.taskId.startsWith(ref));
		return matches.length === 1 ? matches[0] : undefined;
	}

	/** Ensure the record's session file is resolved, searching its dir if needed. */
	sessionFileFor(record: AgentRunRecord): string | undefined {
		record.sessionFile ??= findSessionFile(record.sessionSearchDir);
		return record.sessionFile;
	}
}
