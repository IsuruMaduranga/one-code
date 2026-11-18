/**
 * A tool call whose arguments end in one short unit repeated without end: a
 * model caught in a loop inside an argument. GPT-6.1 Terra streamed "Lspnull "
 * into a bash call's `description` for six minutes (43 KB) and never finished
 * the call (findings §94); nothing else stops that, since every chunk looks
 * like progress, and Claude Code's own watchdogs would not either.
 *
 * Fed one streamed delta at a time, it keeps only the tail it needs and checks
 * it every REPEAT_CHECK_EVERY characters, walking back from the end for each
 * candidate period, so ordinary text fails a candidate within a few
 * characters. A unit of blank space alone is left to `trailingPadding`, which
 * judges padding by whether it could sit inside a JSON string.
 *
 * Pure: no pi imports.
 */

/** The longest unit counted as a repeat. */
export const REPEAT_MAX_UNIT = 64;
/** Characters streamed between two checks. */
export const REPEAT_CHECK_EVERY = 512;

/**
 * How much repetition a call's arguments may end in before it counts as a
 * runaway, by tool. Short-argument tools never legitimately repeat a unit for
 * 2 KB; a shell command can (a heredoc of identical rows), so it gets more;
 * file content (zero-filled data, identical CSV rows, base64) and tools One
 * Code does not know (an MCP tool's payload) get the most.
 */
export const REPEAT_LIMITS = { short: 2_048, shell: 8_192, content: 65_536 } as const;

const SHORT_ARGUMENT_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"Agent",
	"SendMessage",
	"list_agents",
	"tool_search",
	"skill",
	"web_search",
	"web_fetch",
	"task_stop",
	"task_output",
	"ask_user_question",
	"schedule_wakeup",
	"cron_create",
	"cron_delete",
	"cron_list",
	"enter_plan_mode",
	"exit_plan_mode",
	"lsp_diagnostics",
]);
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell", "monitor"]);

/** The repetition a tool's arguments may end in before the call counts as runaway. */
export function repeatLimit(toolName: string | undefined): number {
	if (toolName && SHORT_ARGUMENT_TOOLS.has(toolName)) return REPEAT_LIMITS.short;
	if (toolName && SHELL_TOOLS.has(toolName)) return REPEAT_LIMITS.shell;
	return REPEAT_LIMITS.content;
}

export interface RepeatTail {
	/** The last `limit + REPEAT_MAX_UNIT` characters streamed at the last check, and every character since. */
	tail: string;
	/** Characters streamed since the last check. */
	sinceCheck: number;
}

/**
 * The smallest unit (up to REPEAT_MAX_UNIT characters, not blank space alone)
 * that `text` consists of, repeated to its end, or undefined. `text` must be
 * longer than the unit for a repeat to count.
 */
export function repeatingUnit(text: string): string | undefined {
	const n = text.length;
	for (let period = 1; period <= REPEAT_MAX_UNIT && period * 2 <= n; period++) {
		let i = n - 1;
		while (i >= period && text.charCodeAt(i) === text.charCodeAt(i - period)) i--;
		if (i >= period) continue;
		const unit = text.slice(n - period);
		if (/^\s*$/.test(unit)) return undefined;
		return unit;
	}
	return undefined;
}

/**
 * The unit as a person would read it: the tail can end anywhere inside the
 * repeat ("ll  Lspnu"), so start it where a word starts ("Lspnull  ").
 */
export function readableUnit(unit: string): string {
	const word = /[\p{L}\p{N}_]/u;
	for (let i = 0; i < unit.length; i++) {
		const before = unit[(i - 1 + unit.length) % unit.length];
		if (word.test(unit[i]) && !word.test(before)) return unit.slice(i) + unit.slice(0, i);
	}
	return unit;
}

/**
 * Feed one streamed delta of a call's arguments. Returns the new state and,
 * once the last `limit` characters are one unit repeated, that unit (as a
 * person would read it, `readableUnit`).
 */
export function trailingRepeat(previous: RepeatTail | undefined, delta: string, limit: number): { state: RepeatTail; unit?: string } {
	// Trimmed only when it is checked: a slice per delta would copy the whole
	// tail (64 KB for file content) on every streamed chunk.
	let tail = (previous?.tail ?? "") + delta;
	const sinceCheck = (previous?.sinceCheck ?? 0) + delta.length;
	if (sinceCheck < REPEAT_CHECK_EVERY) return { state: { tail, sinceCheck } };
	const keep = limit + REPEAT_MAX_UNIT;
	if (tail.length > keep) tail = tail.slice(tail.length - keep);
	if (tail.length < limit) return { state: { tail, sinceCheck } };
	const unit = repeatingUnit(tail.slice(tail.length - limit));
	const state = { tail, sinceCheck: 0 };
	return unit === undefined ? { state } : { state, unit: readableUnit(unit) };
}
