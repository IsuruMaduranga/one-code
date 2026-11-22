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
 * The store lives in the permissions extension's process state for one
 * session, which a /reload keeps. It is never persisted, and a new session
 * starts empty.
 */

import type { ReminderPayload } from "../../../lib/request/reminders.ts";
import { autoModeResultText } from "./text.ts";

/** Claude Code's `MAX_DENIALS`. */
export const MAX_DENIALS = 20;

export interface AutoModeDenial {
	/** Unique within the store, so a panel row outlives list changes. */
	id: number;
	/** The normalized tool name (`bash`, `write`, `mcp__server__tool`). */
	toolName: string;
	/** What the user sees for the call: `bash(rm -rf dist)`, its subject clipped at 200 characters for the panel. */
	display: string;
	/** The same call unclipped, for the text the model reads (the grant message, the breadcrumb). */
	fullDisplay: string;
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
 * What a call asks of the sandbox at the moment it is judged
 * (lib/shell-run/sandbox.ts `sandboxGateFacts`): to run outside it, and the
 * hosts it would be granted. Both are empty while no sandbox runs, whatever
 * the input says, since then nothing is asked of it.
 */
export interface SandboxAsk {
	unsandboxed: boolean;
	hosts: readonly string[];
}

/**
 * The key a denial and its grant are matched by: the tool, the directory the
 * call runs in, its input, and what it asks of the sandbox. For a shell tool
 * only the command counts from the input, as in Claude Code (its `description`
 * and `timeout` do not change what runs); for every other tool the whole input
 * does. The directory is part of the key because the same command in another
 * directory is another action.
 *
 * What the call asks of the sandbox comes from the gate's facts, not from the
 * input's own fields: the panel shows those facts with the denied call
 * (`sandboxAskSuffix`) and an approved retry is granted exactly those hosts.
 * So an approval recorded while no sandbox ran does not cover the same call
 * once a sandbox runs and it would leave it or be granted hosts, nor the
 * reverse: the user approves only what they were shown.
 */
export function denialInputKey(toolName: string, input: Record<string, unknown>, cwd: string, shell: boolean, sandbox: SandboxAsk): string {
	const counted = shell ? { command: input.command } : input;
	const asked = { ...(sandbox.unsandboxed ? { unsandboxed: true } : {}), ...(sandbox.hosts.length > 0 ? { hosts: [...sandbox.hosts] } : {}) };
	return `${toolName}\0${cwd}\0${stableJson(counted)}\0${stableJson(asked)}`;
}

/** What a call asks of the sandbox, as the panel shows it after the call: the same facts its key holds. */
export function sandboxAskSuffix(sandbox: SandboxAsk): string {
	return `${sandbox.unsandboxed ? " (unsandboxed)" : ""}${sandbox.hosts.length > 0 ? ` [hosts: ${sandbox.hosts.join(", ")}]` : ""}`;
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
 * Claude Code's wording, verbatim (findings §33), from the profile.
 */
export function permissionGrantedMessage(displays: readonly string[]): string {
	return autoModeResultText.permissionGranted({ displays });
}

/**
 * The reminder that tells the model about approvals made without a retry. No
 * turn starts either way. Idle, the grant rides raw before the next prompt's
 * text, next to the command's breadcrumb, as Claude Code's meta message does.
 * While a turn runs, the model would otherwise work on without it until the
 * user types again, so it is an `orTail` breadcrumb: the next request of the
 * turn carries it on its tail (the trailing tool result), framed as a
 * system reminder so it does not read as the tool's output; a turn that ends
 * first leaves it pending for the next prompt. Claude Code queues the panel
 * itself until the turn ends (findings §33), so the mid-turn delivery is One
 * Code's.
 */
export function permissionGrantReminder(displays: readonly string[], turnRunning: boolean): ReminderPayload {
	const text = permissionGrantedMessage(displays);
	return turnRunning ? { text, placement: "user-prepend", orTail: true } : { text: `${text}\n`, placement: "user-prepend", raw: true };
}
