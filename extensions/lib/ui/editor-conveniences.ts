/**
 * The prompt editor's small conveniences from Claude Code's `?` panel (pure,
 * no pi imports): esc esc clears the input, ctrl+s stashes it, and the
 * session's name sits at the right of the editor's top border.
 *
 * The prompt editor (extensions/ui/branding/prompt-editor.ts) feeds them keys,
 * a clock and what it draws; they decide.
 */

import { brandedId } from "../profile/brand.mjs";
import { stripAnsi } from "./terminal-text.ts";
import { visibleWidth } from "./text-width.ts";
import { cutPlainText } from "./tui-render.ts";

/** The stash key (Claude Code's `chat:stash`); pi binds nothing to it in the editor. */
export const STASH_KEY = "ctrl+s";
/** The history search key (Claude Code's `historySearch`); pi binds it only in its session picker. */
export const HISTORY_SEARCH_KEY = "ctrl+r";

/** The prompt editor's own keys that work right now (a key the user bound in pi is left out). */
export interface EditorKeys {
	stash?: string;
	historySearch?: string;
	/** Esc twice clears the input (the key is pi's `app.interrupt`, read where the row is drawn). */
	clearInput?: boolean;
}

/**
 * Asks the prompt editor which of its own keys work right now, so `/help`
 * lists the same keys as the `?` panel. The branding extension answers while
 * its editor is installed by setting `keys`; nothing answers otherwise, and
 * then no editor key exists.
 */
export const EDITOR_KEYS_CHANNEL = brandedId("editor-keys");
export interface EditorKeysQuery {
	keys?: EditorKeys;
}

/**
 * How long a first Esc waits for the second. Claude Code's double-press
 * window is 800 ms (its reconstructed source, `useDoublePress`; a lead, not a
 * capture). pi's own double Esc on an empty editor uses 500 ms, but only on an
 * empty editor, so the two never meet.
 */
export const DOUBLE_ESC_MS = 800;

/** What the editor looks like when Esc arrives. */
export interface EscapeContext {
	/** The input has text other than whitespace (pi treats a blank input as empty). */
	hasText: boolean;
	/** No turn runs (an Esc then interrupts it, as pi does). */
	idle: boolean;
	/** A menu is open over the editor (an Esc then closes it). */
	menuOpen: boolean;
	/** An agent view is open (an Esc then leaves it). */
	viewOpen: boolean;
	/** The input starts with `!`: pi clears a shell command on one Esc. */
	bashMode: boolean;
	/** A `!` command the user ran is still running: pi's Esc stops it. */
	bashRunning: boolean;
}

/**
 * Esc pressed twice clears a non-empty input when nothing else would take the
 * Esc. The first press keeps whatever pi does with it (nothing, in that state)
 * and arms; the second within the window clears. Any other key disarms.
 */
export class EscapeClear {
	#armedAt: number | undefined;

	/** `clear` to empty the input now; `arm` after a first press; `pass` when the Esc means something else. */
	press(now: number, context: EscapeContext): "clear" | "arm" | "pass" {
		const free = context.hasText && context.idle && !context.menuOpen && !context.viewOpen && !context.bashMode && !context.bashRunning;
		if (!free) {
			this.#armedAt = undefined;
			return "pass";
		}
		if (this.armed(now)) {
			this.#armedAt = undefined;
			return "clear";
		}
		this.#armedAt = now;
		return "arm";
	}

	/** Another key: the next Esc starts over. */
	other(): void {
		this.#armedAt = undefined;
	}

	/** Whether a second Esc now would clear (the hint shows while it would). */
	armed(now: number): boolean {
		return this.#armedAt !== undefined && now - this.#armedAt < DOUBLE_ESC_MS;
	}
}

/**
 * One stashed prompt, in memory. ctrl+s on a non-empty input stashes it and
 * empties the editor (a second stash replaces the first, as in Claude Code's
 * reconstructed source); ctrl+s on an empty input brings the stash back; the
 * next submit brings it back too, once the editor is empty again.
 */
export class PromptStash {
	#text: string | undefined;

	get stashed(): boolean {
		return this.#text !== undefined;
	}

	/** The editor text after ctrl+s on `current`, or undefined when ctrl+s does nothing. */
	toggle(current: string): string | undefined {
		if (current.trim() !== "") {
			this.#text = current;
			return "";
		}
		return this.take();
	}

	/** After a submit: the stash to put back when the editor is empty, else nothing (the stash waits). */
	afterSubmit(editorText: string): string | undefined {
		return editorText === "" ? this.take() : undefined;
	}

	private take(): string | undefined {
		const text = this.#text;
		this.#text = undefined;
		return text;
	}
}

/** The dim line under the editor while a prompt is stashed (Claude Code's reconstructed `PromptInputStashNotice`; no capture shows it). */
export const STASH_NOTICE = "› Stashed (auto-restores after submit)";

/** The second Esc's hint (no capture shows Claude Code's; plain words). */
export const ESC_AGAIN_HINT = "esc again to clear";

/**
 * Border glyphs kept between whatever sits at the border's left (the working
 * status, pi's "↑ N more") and the title; also the four columns
 * `applyBorderBadge` (lib/agents/agent-view.ts) keeps at the left.
 */
const TITLE_GAP = 4;
/** A title cut shorter than this is dropped rather than shown as a stub. */
const MIN_TITLE = 4;

/**
 * The session title fitted into the editor's top border, Claude Code's
 * `──── Title ─`: the room is the run of border glyphs the border ends with,
 * less a gap after what sits at its left, the closing glyph, and `reserved`
 * columns at the right (an agent badge and its glyph). "" when it does not fit.
 */
export function fitBorderTitle(top: string, title: string | undefined, reserved = 0): string {
	const name = title?.replace(/\s+/g, " ").trim();
	if (!name || top === undefined) return "";
	const text = stripAnsi(top);
	const glyph = text.at(-1);
	if (!glyph) return "";
	let run = 0;
	for (let i = text.length - 1; i >= 0 && text[i] === glyph; i--) run++;
	// The closing glyph, the title's two spaces, and the gap.
	const room = run - 1 - reserved - 2 - TITLE_GAP;
	if (room < MIN_TITLE) return "";
	const fitted = cutPlainText(name, room);
	return visibleWidth(fitted) < Math.min(MIN_TITLE, visibleWidth(name)) ? "" : fitted;
}

/**
 * The prompt history as pi-tui's editor keeps it (`addToHistory`: trimmed, no
 * empty entry, no consecutive duplicate, newest first, at most 100). pi-tui
 * keeps its own list private, so the prompt editor keeps this copy beside it,
 * fed by the same calls.
 */
export class PromptHistory {
	readonly entries: string[] = [];

	add(text: string): void {
		const trimmed = text.trim();
		if (!trimmed || this.entries[0] === trimmed) return;
		this.entries.unshift(trimmed);
		if (this.entries.length > 100) this.entries.pop();
	}
}

/**
 * ctrl+r history search (no capture shows Claude Code's; its reconstructed
 * source is the lead for the words and keys): typing narrows to the newest
 * prompt containing the query, ctrl+r steps to an older one, and the match
 * stands in the editor. Accepting keeps it there; cancelling puts back what
 * the editor held before the search.
 */
export class HistorySearch {
	#original: string | undefined;
	#query = "";
	#index = -1;
	#failed = false;

	get active(): boolean {
		return this.#original !== undefined;
	}

	/** Start on the editor's current text, which stays in the editor until a query matches. */
	start(original: string): void {
		this.#original = original;
		this.#query = "";
		this.#index = -1;
		this.#failed = false;
	}

	/** The query grew or shrank: the newest match, or the current text when none matches. */
	setQuery(query: string, entries: readonly string[]): string {
		this.#query = query;
		return this.#seek(0, entries);
	}

	get query(): string {
		return this.#query;
	}

	/** ctrl+r again: the next older match, staying put when there is none. */
	older(entries: readonly string[]): string {
		return this.#seek(this.#index + 1, entries);
	}

	/** End the search keeping the match in the editor. */
	accept(): void {
		this.#original = undefined;
	}

	/** End the search; returns the text the editor held before it. */
	cancel(): string {
		const original = this.#original ?? "";
		this.#original = undefined;
		return original;
	}

	/** The dim line under the editor while searching. */
	prompt(): string {
		return `${this.#failed ? "no matching prompt:" : "search prompts:"} ${this.#query}`;
	}

	#current(entries: readonly string[]): string {
		return this.#index >= 0 ? (entries[this.#index] ?? "") : (this.#original ?? "");
	}

	#seek(from: number, entries: readonly string[]): string {
		if (this.#query === "") {
			this.#failed = false;
			this.#index = -1;
			return this.#original ?? "";
		}
		for (let i = Math.max(0, from); i < entries.length; i++) {
			if (entries[i]?.includes(this.#query)) {
				this.#index = i;
				this.#failed = false;
				return entries[i] ?? "";
			}
		}
		this.#failed = true;
		return this.#current(entries);
	}
}
