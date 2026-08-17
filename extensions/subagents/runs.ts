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
	model?: string;
	thinking?: string;
}

/** `<agent>-<n>` with the lowest n not already taken. */
export function nextRunName(existing: Iterable<string>, agent: string): string {
	const taken = new Set(existing);
	for (let n = 1; ; n++) {
		const candidate = `${agent}-${n}`;
		if (!taken.has(candidate)) return candidate;
	}
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

	/** Latest wins per name, matching Claude Code's semantics. */
	add(record: AgentRunRecord): void {
		this.byName.set(record.name, record);
		this.byId.set(record.taskId, record);
	}

	names(): string[] {
		return [...this.byName.keys()];
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
