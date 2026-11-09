/**
 * First-token gate for parallel agent fan-out.
 *
 * A provider cache entry becomes readable only once the request that writes
 * it has started streaming. N children started at the same instant with a
 * byte-identical prefix (same agent prompt, same first-message reminder stack,
 * same model) therefore all pay the cache write; none reads what the others
 * are writing. The gate lets the FIRST run for a prefix key go, holds the rest
 * until that run's first assistant `message_start` (the stream has begun, the
 * entry exists), then releases them — every follower reads the prefix instead
 * of writing it. Followers of a key that recently streamed pass straight
 * through; a leader that never streams (spawn failure, provider error) hands
 * the lead to the next waiter; a leader that is merely slow times out so a
 * stalled first request can never hold a whole fan-out.
 *
 * Pure (no pi imports); wired in subagents/runner.ts and workflow/agent-session.ts.
 */

type Entry =
	| { kind: "warming"; done: Promise<void>; resolve: () => void }
	| { kind: "warm"; at: number };

/**
 * The gate key for a child run: same prompt identity + cwd + model spec = same
 * request prefix. Both fan-out sites (subagents/runner.ts, workflow/agent-session.ts)
 * build their key here so the scheme cannot drift between them.
 */
export function prefixWarmKey(promptIdentity: string, cwd: string, modelSpec: string | undefined): string {
	return `${promptIdentity}|${cwd}|${modelSpec ?? ""}`;
}

/** Prompt identity of a fresh (non-fork) child: its agent definition, else the base prompt. */
export function agentPromptIdentity(agentName: string | undefined): string {
	return agentName ? `agent:${agentName}` : "base";
}

export interface PrefixWarmGateOptions {
	/** How long a leader may take to stream before waiters are released anyway. */
	timeoutMs?: number;
	/** How long after the last stream start a key counts as warm (the 5-minute TTL minus slack). */
	warmForMs?: number;
	/** Clock, for tests. */
	now?: () => number;
}

/** What the caller reports when it is done with its admission. */
export type Release = (streamed: boolean) => void;

export class PrefixWarmGate {
	private readonly entries = new Map<string, Entry>();
	private readonly timeoutMs: number;
	private readonly warmForMs: number;
	private readonly now: () => number;

	constructor(options: PrefixWarmGateOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? 20_000;
		this.warmForMs = options.warmForMs ?? 4 * 60_000;
		this.now = options.now ?? Date.now;
	}

	/**
	 * Wait until `key`'s prefix is (probably) cached, then return the release
	 * the caller must invoke: `release(true)` when its own response started
	 * streaming (refreshes the warm stamp; lets waiters go if it was the leader),
	 * `release(false)` if it gave up without streaming. Idempotent; the first
	 * call wins.
	 */
	async admit(key: string): Promise<Release> {
		for (;;) {
			const entry = this.entries.get(key);
			if (entry?.kind === "warm" && this.now() - entry.at < this.warmForMs) {
				return this.followerRelease(key);
			}
			if (entry?.kind === "warming") {
				await entry.done;
				continue;
			}
			return this.lead(key);
		}
	}

	/** How many keys are currently warming (for tests). */
	get warmingCount(): number {
		let count = 0;
		for (const entry of this.entries.values()) if (entry.kind === "warming") count++;
		return count;
	}

	private lead(key: string): Release {
		let resolve!: () => void;
		const done = new Promise<void>((r) => {
			resolve = r;
		});
		const entry: Entry = { kind: "warming", done, resolve };
		this.entries.set(key, entry);
		// A leader that streams slowly must not hold the fan-out forever: on
		// timeout everyone proceeds and the key is treated as warm.
		const timer = setTimeout(() => {
			if (this.entries.get(key) === entry) {
				this.entries.set(key, { kind: "warm", at: this.now() });
				resolve();
			}
		}, this.timeoutMs);
		timer.unref?.();

		let released = false;
		return (streamed) => {
			if (released) return;
			released = true;
			clearTimeout(timer);
			if (this.entries.get(key) === entry) {
				// Streamed: the entry exists, followers read it. Abandoned: back to
				// cold, so the next waiter becomes the leader (its loop re-enters lead()).
				if (streamed) this.entries.set(key, { kind: "warm", at: this.now() });
				else this.entries.delete(key);
			}
			resolve();
		};
	}

	/**
	 * `admit(key)` for an agent session: the session's own first assistant
	 * `message_start` (the stream has begun, the entry exists) releases it as
	 * streamed; the returned release is for the caller's `finally`, where
	 * `release(false)` is a no-op if streaming already released it and hands the
	 * lead on if the run never streamed. Structural session type keeps this
	 * module pi-free.
	 */
	async admitOnFirstToken(
		key: string,
		session: { subscribe(listener: (event: unknown) => void): () => void },
	): Promise<Release> {
		const release = await this.admit(key);
		const stop = session.subscribe((event) => {
			const e = event as { type?: string; message?: { role?: string } };
			if (e.type === "message_start" && e.message?.role === "assistant") {
				stop();
				release(true);
			}
		});
		return (streamed) => {
			stop();
			release(streamed);
		};
	}

	private followerRelease(key: string): Release {
		let released = false;
		return (streamed) => {
			if (released) return;
			released = true;
			if (!streamed) return;
			const entry = this.entries.get(key);
			if (entry?.kind === "warm") this.entries.set(key, { kind: "warm", at: this.now() });
		};
	}
}
