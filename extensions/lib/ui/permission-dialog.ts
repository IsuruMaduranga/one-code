/**
 * The permission gate's dialog: Claude Code's titled prompt with numbered
 * options (pure model and rendering, plus the one opener every gate site
 * calls; no pi imports).
 *
 * The shape follows Claude Code's Bash prompt: the kind of action as a title,
 * the subject indented under it with the call's description, why the gate
 * asks, "Do you want to proceed?", then "❯ 1. Yes" style options a number key
 * picks in one keystroke. The dialog only changes how the question looks: it
 * returns the same option string the gate's `ctx.ui.select` returned, so
 * every answer path after the choice is unchanged.
 *
 * `askPermission` opens it with `ctx.ui.custom` in the TUI and keeps the
 * site's exact `ctx.ui.select` call everywhere else: RPC (its `custom()`
 * resolves undefined), a host whose `custom()` never builds the component,
 * and a timed prompt (pi's select owns the countdown the paused-auto-mode
 * resume prompt relies on). The caller still opens it through the gate's
 * queue and `openGatePrompt`.
 */

import { canShowCustomUi } from "../notify/headless-output.ts";
import { keyId, keyText } from "./key-input.ts";
import { panelUi } from "./panel-focus.ts";
import { escapeControlText, sanitizeDisplayText } from "./terminal-text.ts";
import { visibleWidth } from "./text-width.ts";
import { boundedDockHeight, hintLines, linesComponent, panelTopRule, safeThemeBold, safeThemePaint, truncateLine, wrapPlainText, wrapProse } from "./tui-render.ts";

/** Claude Code's question above the options. */
export const PROCEED_QUESTION = "Do you want to proceed?";

/** What the dialog shows. `options` are returned verbatim; only their display is sanitized. */
export interface PermissionDialogView {
	/** The kind of action ("Bash command", "Write"). */
	title: string;
	/** The command or path, shown indented and wrapped whole; control characters show as `\xHH`. */
	subject?: string;
	/** The model's description of the call (a shell call's `description`), dim under the subject. */
	description?: string;
	/** Why the gate asks, one paragraph each. */
	notes?: string[];
	/** Defaults to {@link PROCEED_QUESTION}. */
	question?: string;
	options: string[];
}

export interface PermissionDialogState {
	cursor: number;
}

export type PermissionDialogKey = { kind: "up" | "down" | "enter" | "cancel" | "expand" } | { kind: "number"; value: number };

/** pi's bindings for the select it replaces, with pi-tui's defaults (pi-tui keybindings.js). */
const SELECT_BINDINGS = {
	up: { binding: "tui.select.up", defaults: ["up"] },
	down: { binding: "tui.select.down", defaults: ["down"] },
	enter: { binding: "tui.select.confirm", defaults: ["enter"] },
	cancel: { binding: "tui.select.cancel", defaults: ["escape", "ctrl+c"] },
} as const;

/**
 * Whether `data` is the key for one of the select's actions: the user's
 * binding as pi resolved it, or pi-tui's default when there are no bindings.
 */
export type SelectKeyMatcher = (data: string, action: keyof typeof SELECT_BINDINGS) => boolean;
const defaultSelectKeys: SelectKeyMatcher = (data, action) => (SELECT_BINDINGS[action].defaults as readonly string[]).includes(keyId(data) ?? "");

/**
 * Decode one input chunk with the keys of pi's select (extension-selector.js):
 * its `tui.select.*` bindings, `k`/`j` and a bare `\n`, and the expand key,
 * whose `isExpand` matches pi's `app.tools.expand` binding (ctrl+o by
 * default) so a write's preview can be expanded while its prompt waits.
 * Digits pick an option. Unlike pi's select, cancel is decided before the
 * other actions: a key the user bound to cancel never approves a call.
 */
export function decodePermissionKey(data: string, isExpand: (data: string) => boolean = () => false, isKey: SelectKeyMatcher = defaultSelectKeys): PermissionDialogKey | undefined {
	if (isExpand(data)) return { kind: "expand" };
	if (isKey(data, "cancel")) return { kind: "cancel" };
	if (isKey(data, "up") || data === "k") return { kind: "up" };
	if (isKey(data, "down") || data === "j") return { kind: "down" };
	if (isKey(data, "enter") || data === "\n") return { kind: "enter" };
	const text = keyText(data);
	return text && /^[1-9]$/.test(text) ? { kind: "number", value: Number(text) } : undefined;
}

/**
 * The user's keys for each select action. pi's bindings already hold the
 * defaults for an action the user left alone, and an empty list for one the
 * user turned off, so their answer is taken as it is; pi-tui's defaults apply
 * only when there are no bindings to ask.
 */
function selectKeys(keybindings: Keybindings | undefined): { keys: Record<keyof typeof SELECT_BINDINGS, string[]>; isKey: SelectKeyMatcher } {
	const readable = typeof keybindings?.getKeys === "function" && typeof keybindings.matches === "function";
	const keysOf = (action: keyof typeof SELECT_BINDINGS) => (readable ? safeKeys(keybindings, SELECT_BINDINGS[action].binding) : [...SELECT_BINDINGS[action].defaults]);
	const isKey: SelectKeyMatcher = readable ? (data, action) => safeMatches(keybindings, data, SELECT_BINDINGS[action].binding) : defaultSelectKeys;
	return { keys: { up: keysOf("up"), down: keysOf("down"), enter: keysOf("enter"), cancel: keysOf("cancel") }, isKey };
}

/** A key as the hint row names it: the arrows as arrows, Enter and Esc capitalised. */
const hintKey = (key: string | undefined): string => ({ up: "↑", down: "↓", enter: "Enter", escape: "Esc" })[key ?? ""] ?? key ?? "";

/** The dialog's outcome for one key: `{ answer }` when it closes (undefined answer = dismissed). */
export type PermissionDialogStep = { answer: string | undefined } | "expand" | undefined;

/** Advance one key; mutates `state`. */
export function applyPermissionKey(state: PermissionDialogState, options: readonly string[], key: PermissionDialogKey): PermissionDialogStep {
	switch (key.kind) {
		case "up":
			state.cursor = Math.max(0, state.cursor - 1);
			return undefined;
		case "down":
			state.cursor = Math.min(options.length - 1, state.cursor + 1);
			return undefined;
		case "enter":
			return { answer: options[state.cursor] };
		case "cancel":
			return { answer: undefined };
		case "expand":
			return "expand";
		case "number": {
			if (key.value > options.length) return undefined;
			state.cursor = key.value - 1;
			return { answer: options[state.cursor] };
		}
	}
}

export interface PermissionDialogStyle {
	paint: (color: string, text: string) => string;
	bold: (text: string) => string;
}

/**
 * The hint row: every key the dialog takes, each action by the user's first
 * key for it (pi-tui's defaults without `keys`); an action with no key is not
 * named. `expandKey` is the user's key for expanding tool output, if bound.
 */
export function permissionHints(optionCount: number, expandKey?: string, keys?: Partial<Record<keyof typeof SELECT_BINDINGS, readonly string[]>>): string {
	const first = (action: keyof typeof SELECT_BINDINGS) => {
		const key = (keys?.[action] ?? SELECT_BINDINGS[action].defaults)[0];
		return key === undefined ? undefined : hintKey(key);
	};
	const numbers = optionCount > 1 ? `1-${optionCount}` : "1";
	const move = [first("up"), first("down")].filter((key) => key !== undefined).join("/");
	const confirm = first("enter");
	const cancel = first("cancel");
	return [...(move ? [`${move} to navigate`] : []), `${confirm ? `${confirm} or ` : ""}${numbers} to select`, ...(expandKey ? [`${expandKey} to expand`] : []), ...(cancel ? [`${cancel} to cancel`] : [])].join(" · ");
}

/** One line of display text with tabs as spaces, so the width math holds. */
const detab = (text: string) => text.replace(/\t/g, "  ");

/**
 * The dialog's lines at `width`. Every line fits: long subjects, paths,
 * descriptions and option labels wrap, and a final ANSI-aware cut guards the
 * painted lines (pi-tui stops the app on an overwide line).
 */
export function renderPermissionDialog(
	view: PermissionDialogView,
	state: PermissionDialogState,
	style: PermissionDialogStyle,
	width: number,
	expandKey?: string,
	keys?: Parameters<typeof permissionHints>[2],
	height?: number,
): string[] {
	const { paint, bold } = style;
	const room = (indent: number) => Math.max(1, width - indent - 1);
	const head = [panelTopRule(paint, width), ` ${paint("accent", bold(sanitizeDisplayText(view.title)))}`];

	const subject = view.subject === undefined ? undefined : detab(escapeControlText(view.subject));
	const description = view.description ? detab(sanitizeDisplayText(view.description)).trim() : "";
	let subjectLines = subject === undefined ? [] : wrapPlainText(subject, room(3));
	let descriptionLines = description ? wrapProse(description, room(3)) : [];

	const tail: string[] = [];
	const notes = (view.notes ?? []).map((note) => detab(sanitizeDisplayText(note)).trim()).filter(Boolean);
	if (notes.length > 0) {
		tail.push("");
		for (const note of notes) for (const line of wrapProse(note, room(1))) tail.push(` ${line}`);
	}
	tail.push("");
	tail.push(` ${bold(view.question ?? PROCEED_QUESTION)}`);
	for (const [index, option] of view.options.entries()) {
		const focused = index === state.cursor;
		const prefix = `${focused ? "❯" : " "} ${index + 1}. `;
		const indent = 1 + visibleWidth(prefix);
		const label = wrapProse(detab(sanitizeDisplayText(option)), room(indent));
		for (const [at, part] of label.entries()) {
			const line = at === 0 ? ` ${prefix}${part}` : `${" ".repeat(indent)}${part}`;
			tail.push(focused ? paint("accent", line) : line);
		}
	}
	tail.push("");
	for (const line of hintLines(permissionHints(view.options.length, expandKey, keys), room(1))) tail.push(` ${paint("dim", line)}`);

	// On a short terminal the subject and description give way, so the question, the choices and the hint stay on screen.
	const separator = subjectLines.length + descriptionLines.length > 0 ? 1 : 0;
	const left = height === undefined ? Number.POSITIVE_INFINITY : Math.max(2, height - head.length - separator - tail.length);
	let subjectMore = "";
	if (subjectLines.length + descriptionLines.length > left) {
		const subjectRoom = descriptionLines.length === 0 ? left : Math.min(subjectLines.length, Math.max(1, Math.ceil(left / 2)));
		[subjectLines, subjectMore] = clipLines(subjectLines, subjectRoom);
		const [kept, more] = clipLines(descriptionLines, left - subjectLines.length - (subjectMore ? 1 : 0));
		descriptionLines = more ? [...kept, more] : kept;
	}
	const body = separator
		? ["", ...subjectLines.map((line) => `   ${line}`), ...(subjectMore ? [`   ${paint("dim", subjectMore)}`] : []), ...descriptionLines.map((line) => `   ${paint("dim", line)}`)]
		: [];
	return [...head, ...body, ...tail].map((line) => truncateLine(line, width));
}

/** `lines` within `count` rows: the rows kept, and an "… N more lines" row (counted in `count`) when some are cut. */
function clipLines(lines: string[], count: number): [string[], string] {
	if (lines.length <= count) return [lines, ""];
	const kept = lines.slice(0, Math.max(0, count - 1));
	return [kept, `… ${lines.length - kept.length} more lines`];
}

// ── opener ───────────────────────────────────────────────────────────────

interface Emitter {
	emit(channel: string, data: unknown): void;
}

interface Keybindings {
	matches?(data: string, binding: string): boolean;
	getKeys?(binding: string): string[];
}

/** The parts of an extension context the dialog uses (structural, so this module imports no pi). */
export interface PermissionDialogHost {
	hasUI: boolean;
	mode?: string;
	ui: {
		select(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
		custom?: (...args: any[]) => Promise<unknown>;
		getToolsExpanded?(): boolean;
		setToolsExpanded?(expanded: boolean): void;
		getEditorText?(): string;
	};
}

/**
 * Whether the prompt editor holds a draft. pi's `ctx.ui.custom` saves the
 * editor's expanded text when a component opens and sets it back when it
 * closes, which expands a collapsed paste and moves the cursor to the end;
 * `ctx.ui.select` leaves the editor alone. A stale context counts as a draft,
 * so the select is the fallback.
 */
function editorHoldsDraft(ui: PermissionDialogHost["ui"]): boolean {
	try {
		return (ui.getEditorText?.() ?? "") !== "";
	} catch {
		return true;
	}
}

export interface AskPermissionOptions {
	signal?: AbortSignal;
	/** A timed prompt: asked through pi's select, which shows the countdown. */
	timeout?: number;
}

/**
 * Ask one permission question: the dialog in the TUI, else
 * `ctx.ui.select(selectTitle, view.options, { signal, timeout })`, the call
 * the gate made before the dialog existed (RPC clients see the same
 * `extension_ui_request`). Resolves the chosen option string, or undefined
 * when dismissed or aborted.
 */
export async function askPermission(events: Emitter, ctx: PermissionDialogHost, view: PermissionDialogView, selectTitle: string, options: AskPermissionOptions = {}): Promise<string | undefined> {
	const { signal, timeout } = options;
	const select = () => ctx.ui.select(selectTitle, view.options, { signal, ...(timeout !== undefined ? { timeout } : {}) });
	const ui = ctx.ui;
	// A draft in the editor keeps pi's select, which does not rewrite the draft (editorHoldsDraft).
	if (timeout !== undefined || !canShowCustomUi(ctx as Parameters<typeof canShowCustomUi>[0]) || typeof ui.custom !== "function" || editorHoldsDraft(ui)) return select();
	let built = false;
	const answer = await panelUi(events, ui as { custom: (...args: any[]) => Promise<unknown> }).custom(
		(tui: { requestRender?(): void }, theme: unknown, keybindings: Keybindings | undefined, done: (answer: string | undefined) => void) => {
			built = true;
			const state: PermissionDialogState = { cursor: 0 };
			const style = { paint: safeThemePaint(theme), bold: safeThemeBold(theme) };
			const expandKeys = safeKeys(keybindings, "app.tools.expand");
			const isExpand = (data: string) => expandKeys.length > 0 && safeMatches(keybindings, data, "app.tools.expand");
			const select = selectKeys(keybindings);
			let settled = false;
			const finish = (value: string | undefined) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				done(value);
			};
			const onAbort = () => finish(undefined);
			if (signal?.aborted) queueMicrotask(onAbort);
			else signal?.addEventListener("abort", onAbort, { once: true });
			// The dialog sits in the editor's slot, above pi's two footer lines.
			const height = () => {
				const rows = (tui as { terminal?: { rows?: number } }).terminal?.rows;
				return typeof rows === "number" && rows > 0 ? boundedDockHeight(rows, rows) : undefined;
			};
			const lines = linesComponent((width) => renderPermissionDialog(view, state, style, width, expandKeys.join("/") || undefined, select.keys, height()));
			return {
				render: (width: number) => lines.render(width),
				invalidate: () => lines.invalidate?.(),
				handleInput: (data: string) => {
					const key = decodePermissionKey(data, isExpand, select.isKey);
					if (!key) return;
					const step = applyPermissionKey(state, view.options, key);
					if (step === "expand") {
						ui.setToolsExpanded?.(!ui.getToolsExpanded?.());
						return;
					}
					if (step) return finish(step.answer);
					lines.invalidate?.();
					tui.requestRender?.();
				},
				dispose: () => signal?.removeEventListener("abort", onAbort),
			};
		},
		// pi reports the wait to the terminal (OSC 7501) with this label; the title is ours, never model text.
		{ blocked: { kind: "permission", message: sanitizeDisplayText(view.title) } },
	);
	// A host that never built the component (RPC, a stub) showed nothing: ask the plain way.
	if (!built) return select();
	return typeof answer === "string" && view.options.includes(answer) ? answer : undefined;
}

function safeKeys(keybindings: Keybindings | undefined, binding: string): string[] {
	try {
		const keys = keybindings?.getKeys?.(binding);
		return Array.isArray(keys) ? keys.filter((key) => typeof key === "string" && key.length > 0) : [];
	} catch {
		return [];
	}
}

function safeMatches(keybindings: Keybindings | undefined, data: string, binding: string): boolean {
	try {
		return keybindings?.matches?.(data, binding) === true;
	} catch {
		return false;
	}
}
