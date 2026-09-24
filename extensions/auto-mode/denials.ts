/**
 * Calls the auto-mode classifier denied this session, and the one-shot grants
 * the user mints by approving them in `/permissions` (pure).
 *
 * Claude Code records every classifier denial (newest first, at most 20) for
 * its "Recently denied" tab, keyed by tool and exact input. Approving one there
 * writes no rule and bypasses nothing: the model is told it may retry, and the
 * retry goes through the classifier again (findings §33). One Code's classifier
 * takes user intent only from the user's own typed input, so a retry would
 * most likely be blocked again. Here an approval instead mints a grant for that
 * exact tool and input: the next call that matches it skips the classifier
 * once, then the grant is spent. It carries the authority of answering "Yes"
 * once on a permission prompt, and no more: a changed command, another
 * directory or a second run is judged as usual, and deny rules and the safety
 * floor are checked before any grant (working-docs/decisions/auto-mode.md,
 * "Approving a denied call").
 *
 * The store lives in the permissions extension's memory for one session. It is
 * never persisted, and a new session starts empty.
 */

/** Claude Code's `MAX_DENIALS`. */
export const MAX_DENIALS = 20;

export interface AutoModeDenial {
	/** Unique within the store, so a panel row outlives list changes. */
	id: number;
	/** The normalized tool name (`bash`, `write`, `mcp__server__tool`). */
	toolName: string;
	/** What the user sees for the call: `bash(rm -rf dist)`. */
	display: string;
	/** The exact call (`denialInputKey`). */
	inputKey: string;
	/** The classifier's reason (a grounded rule name, or the failure it explained). */
	reason: string;
	/** The grounded rule name, when the verdict cited one. */
	rule?: string;
	timestamp: number;
}

/** JSON with object keys sorted at every level, so two spellings of one input agree. */
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * The key a denial and its grant are matched by: the tool, the directory the
 * call runs in, and its whole input. For a shell tool only the command counts,
 * as in Claude Code (its `description` and `timeout` do not change what runs);
 * for every other tool the whole input does. The directory is part of the key
 * because the same command in another directory is another action.
 */
export function denialInputKey(toolName: string, input: Record<string, unknown>, cwd: string, shell: boolean): string {
	const counted = shell ? { command: input.command } : input;
	return `${toolName}\0${cwd}\0${stableJson(counted)}`;
}

export class DenialStore {
	private denials: AutoModeDenial[] = [];
	/** Unspent grants per exact call: two approved denials of one call allow two retries. */
	private readonly grants = new Map<string, number>();
	private nextId = 1;

	/** Record a classifier denial, newest first, keeping the last `MAX_DENIALS`. */
	record(denial: Omit<AutoModeDenial, "id">): AutoModeDenial {
		const entry = { ...denial, id: this.nextId++ };
		this.denials = [entry, ...this.denials].slice(0, MAX_DENIALS);
		return entry;
	}

	/** Newest first. */
	list(): readonly AutoModeDenial[] {
		return this.denials;
	}

	/**
	 * Approve denials by id: each leaves the list and mints a grant for its exact
	 * call. Returns the approved entries, in list order; unknown ids are skipped.
	 */
	approve(ids: ReadonlySet<number>): AutoModeDenial[] {
		const approved = this.denials.filter((denial) => ids.has(denial.id));
		for (const denial of approved) this.grants.set(denial.inputKey, (this.grants.get(denial.inputKey) ?? 0) + 1);
		this.denials = this.denials.filter((denial) => !ids.has(denial.id));
		return approved;
	}

	/** Spend one grant for this exact call. True once per approval. */
	takeGrant(inputKey: string): boolean {
		const left = this.grants.get(inputKey);
		if (!left) return false;
		if (left === 1) this.grants.delete(inputKey);
		else this.grants.set(inputKey, left - 1);
		return true;
	}

	/** A call that went through another way drops its earlier denials (Claude Code does the same). */
	settle(inputKey: string): void {
		this.denials = this.denials.filter((denial) => denial.inputKey !== inputKey);
	}

	/** A new session starts with no denials and no grants. */
	reset(): void {
		this.denials = [];
		this.grants.clear();
	}
}

/**
 * The message the model gets when the user approves denials in `/permissions`:
 * Claude Code's wording, verbatim (findings §33).
 */
export function permissionGrantedMessage(displays: readonly string[]): string {
	return `Permission granted for: ${displays.join(", ")}. You may now retry ${displays.length === 1 ? "this command" : "these commands"} if you would like.`;
}
