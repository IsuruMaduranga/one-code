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
import { hintLines, linesComponent, panelTopRule, safeThemeBold, safeThemePaint, truncateLine, wrapPlainText, wrapProse } from "./tui-render.ts";

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

/**
 * Decode one input chunk. `isExpand` matches pi's `app.tools.expand` binding
 * (ctrl+o by default), which pi's select honoured so a write's preview can be
 * expanded while its prompt waits.
 */
export function decodePermissionKey(data: string, isExpand: (data: string) => boolean = () => false): PermissionDialogKey | undefined {
	if (isExpand(data)) return { kind: "expand" };
	switch (keyId(data)) {
		case "up":
			return { kind: "up" };
		case "down":
			return { kind: "down" };
		case "enter":
			return { kind: "enter" };
		case "escape":
		case "ctrl+c": // pi's select cancelled on both
			return { kind: "cancel" };
		default: {
			const text = keyText(data);
			return text && /^[1-9]$/.test(text) ? { kind: "number", value: Number(text) } : undefined;
		}
	}
}

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

/** The hint row: every key the dialog takes. `expandKey` is the user's key for expanding tool output, if bound. */
export function permissionHints(optionCount: number, expandKey?: string): string {
	const numbers = optionCount > 1 ? `1-${optionCount}` : "1";
	return ["↑/↓ to navigate", `Enter or ${numbers} to select`, ...(expandKey ? [`${expandKey} to expand`] : []), "Esc to cancel"].join(" · ");
}

/** One line of display text with tabs as spaces, so the width math holds. */
const detab = (text: string) => text.replace(/\t/g, "  ");

/**
 * The dialog's lines at `width`. Every line fits: long subjects, paths,
 * descriptions and option labels wrap, and a final ANSI-aware cut guards the
 * painted lines (pi-tui stops the app on an overwide line).
 */
export function renderPermissionDialog(view: PermissionDialogView, state: PermissionDialogState, style: PermissionDialogStyle, width: number, expandKey?: string): string[] {
	const { paint, bold } = style;
	const room = (indent: number) => Math.max(1, width - indent - 1);
	const out: string[] = [panelTopRule(paint, width)];
	out.push(` ${paint("accent", bold(sanitizeDisplayText(view.title)))}`);

	const subject = view.subject === undefined ? undefined : detab(escapeControlText(view.subject));
	const description = view.description ? detab(sanitizeDisplayText(view.description)).trim() : "";
	if (subject !== undefined || description) {
		out.push("");
		if (subject !== undefined) for (const line of wrapPlainText(subject, room(3))) out.push(`   ${line}`);
		if (description) for (const line of wrapProse(description, room(3))) out.push(`   ${paint("dim", line)}`);
	}

	const notes = (view.notes ?? []).map((note) => detab(sanitizeDisplayText(note)).trim()).filter(Boolean);
	if (notes.length > 0) {
		out.push("");
		for (const note of notes) for (const line of wrapProse(note, room(1))) out.push(` ${line}`);
	}

	out.push("");
	out.push(` ${bold(view.question ?? PROCEED_QUESTION)}`);
	for (const [index, option] of view.options.entries()) {
		const focused = index === state.cursor;
		const prefix = `${focused ? "❯" : " "} ${index + 1}. `;
		const indent = 1 + visibleWidth(prefix);
		const label = wrapProse(detab(sanitizeDisplayText(option)), room(indent));
		for (const [at, part] of label.entries()) {
			const line = at === 0 ? ` ${prefix}${part}` : `${" ".repeat(indent)}${part}`;
			out.push(focused ? paint("accent", line) : line);
		}
	}

	out.push("");
	for (const line of hintLines(permissionHints(view.options.length, expandKey), room(1))) out.push(` ${paint("dim", line)}`);
	return out.map((line) => truncateLine(line, width));
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
	};
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
	if (timeout !== undefined || !canShowCustomUi(ctx as Parameters<typeof canShowCustomUi>[0]) || typeof ui.custom !== "function") return select();
	let built = false;
	const answer = await panelUi(events, ui as { custom: (...args: any[]) => Promise<unknown> }).custom(
		(tui: { requestRender?(): void }, theme: unknown, keybindings: Keybindings | undefined, done: (answer: string | undefined) => void) => {
			built = true;
			const state: PermissionDialogState = { cursor: 0 };
			const style = { paint: safeThemePaint(theme), bold: safeThemeBold(theme) };
			const expandKeys = safeKeys(keybindings, "app.tools.expand");
			const isExpand = (data: string) => expandKeys.length > 0 && safeMatches(keybindings, data, "app.tools.expand");
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
			const lines = linesComponent((width) => renderPermissionDialog(view, state, style, width, expandKeys.join("/") || undefined));
			return {
				render: (width: number) => lines.render(width),
				invalidate: () => lines.invalidate?.(),
				handleInput: (data: string) => {
					const key = decodePermissionKey(data, isExpand);
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
