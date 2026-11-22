/**
 * PromptEditor — the core input editor with a Claude Code-style "❯" marker.
 *
 * pi's editor has no prompt marker and no option for one, but `CustomEditor` is
 * the sanctioned base for a replacement (it already wires every app keybinding
 * through handleInput). We reserve a two-column left gutter and paint the
 * marker into it — see prompt-marker.ts for why that is cursor-safe — draw a
 * slash command's argument hint after the cursor (lib/ui/argument-hints.ts), and
 * let ↑ restore queued messages through pi's dequeue action (queued-edit.ts).
 *
 * It also carries Claude Code's editor conveniences, each decided in a pure
 * module: the command menu's height and its descriptions' ellipsis
 * (lib/ui/slash-menu-model.ts), the `?` shortcuts panel under an empty editor
 * (lib/ui/shortcuts-model.ts), esc esc to clear, ctrl+s to stash, and the
 * session title on the top border (lib/ui/editor-conveniences.ts).
 * Registered via `ctx.ui.setEditorComponent`; this file is thin wiring.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { type AgentViewScroll, applyBorderBadge, fitBadge } from "../../lib/agents/agent-view.ts";
import { applyArgumentHint } from "../../lib/ui/argument-hints.ts";
import {
	DOUBLE_ESC_MS,
	ESC_AGAIN_HINT,
	type EditorKeys,
	EscapeClear,
	fitBorderTitle,
	HISTORY_SEARCH_KEY,
	HistorySearch,
	PromptHistory,
	PromptStash,
	STASH_KEY,
	STASH_NOTICE,
} from "../../lib/ui/editor-conveniences.ts";
import { keyId, keyText, PASTE_END, PASTE_START } from "../../lib/ui/key-input.ts";
import { fitSlashDescriptions, isCommandMenu, slashMenuRows } from "../../lib/ui/slash-menu-model.ts";
import { visibleWidth } from "../../lib/ui/text-width.ts";
import { cutPlainText } from "../../lib/ui/tui-render.ts";
import { applyPromptMarker } from "./prompt-marker.ts";
import { upEditsQueue } from "./queued-edit.ts";

/** Width of the left gutter, and therefore the visible width the marker must fill. */
export const PROMPT_PADDING = 2;

type EditorArgs = ConstructorParameters<typeof CustomEditor>;
type Provider = Parameters<CustomEditor["setAutocompleteProvider"]>[0];

/** What the editor reads from its surroundings; every member is optional except the marker. */
export interface PromptEditorHooks {
	/** The painted marker, re-read per render so it follows live theme changes. */
	marker: () => string;
	/** The painted argument placeholder for the current input, if it is a hinted command. */
	hint?: (text: string) => string | undefined;
	/** The viewed agent's top-border label (plain text), or undefined on main (lib/agents/agent-view.ts). */
	badge?: () => string | undefined;
	/** Paints the fitted badge label as a chip, one space of padding on each side. */
	paintBadge?: (label: string) => string;
	/** Whether a message waits in pi's queue mid-turn (queued-edit.ts). */
	queued?: () => boolean;
	/** Scrolls the open agent view; undefined while main is on screen (lib/agents/agent-view.ts). */
	scrollView?: () => ((scroll: AgentViewScroll) => void) | undefined;
	/** Paints secondary text dim (the lines under the editor, the border title). */
	dim?: (text: string) => string;
	/** The session's name, shown at the right of the top border. */
	title?: () => string | undefined;
	/** No turn runs. */
	idle?: () => boolean;
	/** The `?` panel's plain lines at `width`, given the editor's own keys. */
	shortcuts?: (width: number, editorKeys: EditorKeys) => string[];
	/** The second key of a `ctrl+x` chord being offered right now (lib/ui/ctrl-x-chord.ts), if any. */
	chordKey?: () => string | undefined;
	now?: () => number;
}

export type { EditorKeys };

/** A `?` keypress: the plain byte, or a kitty / modifyOtherKeys encoding of it (never its release). */
function isQuestionKey(data: string): boolean {
	return keyText(data) === "?";
}

export class PromptEditor extends CustomEditor {
	#hooks: PromptEditorHooks;
	#keys: EditorArgs[2];
	/** The width pi wraps the text at, from the last render (pi's own formula). */
	#layoutWidth = Number.POSITIVE_INFINITY;
	/** The width pi gives the autocomplete list, from the last render. */
	#contentWidth = 80;
	/** pi's `autocompleteMaxVisible` setting as pi handed it over. */
	#configuredRows = 5;
	#shortcutsOpen = false;
	/** The open `?` panel's lines at the width they were built for; dropped when it closes. */
	#shortcutsLines: { width: number; lines: string[] } | undefined;
	/** Inside a bracketed paste that arrives in pieces: its `?` is text. */
	#inPaste = false;
	#escape = new EscapeClear();
	#escTimer: ReturnType<typeof setTimeout> | undefined;
	#stash = new PromptStash();
	#history = new PromptHistory();
	#search = new HistorySearch();
	/**
	 * How many `!` submits are still in pi's handler: pi runs the command inside
	 * its submit handler and settles the handler's promise when it ends (pi's
	 * `isBashRunning` is not on the extension API), and its Esc stops it then.
	 */
	#bashRuns = 0;

	constructor(tui: EditorArgs[0], theme: EditorArgs[1], keybindings: EditorArgs[2], hooks: PromptEditorHooks) {
		super(tui, theme, keybindings, { paddingX: PROMPT_PADDING, embedWorkingStatus: true });
		this.#hooks = hooks;
		this.#keys = keybindings;
		// pi assigns its submit handler after construction; wrap whatever it
		// assigns so a stash returns once the submitted text has left the editor.
		// pi's handler is async and clears the editor again after awaiting some
		// built-ins (/copy, /export, /import, /share), so the stash returns once
		// the handler settles, and only into an editor that is still empty.
		let submit: ((text: string) => unknown) | undefined;
		const restore = () => {
			const restored = this.#stash.afterSubmit(this.getText());
			if (restored === undefined) return;
			this.setText(restored);
			this.tui.requestRender();
		};
		Object.defineProperty(this, "onSubmit", {
			configurable: true,
			enumerable: true,
			get: () =>
				submit &&
				((text: string) => {
					const result = submit?.(text);
					if (result instanceof Promise) {
						const bash = /^!!?\s*\S/.test(text.trim());
						if (bash) this.#bashRuns++;
						const settled = () => {
							if (bash) this.#bashRuns--;
							restore();
						};
						void result.then(settled, settled);
					} else restore();
					return result;
				}),
			set: (handler: ((text: string) => unknown) | undefined) => {
				submit = handler;
			},
		});
	}

	#now(): number {
		return this.#hooks.now?.() ?? Date.now();
	}

	/**
	 * While an agent view is open the editor asks pi-tui (1.5) to hand on its
	 * fullscreen viewport keys (PageUp/PageDown and the rest) instead of
	 * scrolling the main transcript hidden under the view. The subagents
	 * extension's input listener then scrolls the view; it owns that routing,
	 * and its viewport mirror covers a pi-tui that ignores this flag.
	 */
	get capturesViewportInput(): boolean {
		return super.capturesViewportInput || this.#hooks.scrollView?.() !== undefined;
	}

	/** Whether a pi key the editor acts on claims `data`: the stash never takes a key the user bound. */
	#boundInEditor(data: string): boolean {
		const resolved = (this.#keys as { getResolvedBindings?: () => Record<string, unknown> }).getResolvedBindings?.() ?? {};
		const always = new Set(["app.interrupt", "app.exit", "app.clipboard.pasteImage"]);
		return Object.keys(resolved).some(
			(id) => (id.startsWith("tui.editor.") || id.startsWith("tui.input.") || always.has(id) || this.actionHandlers.has(id as never)) && this.#keys.matches(data, id as never),
		);
	}

	/** The editor's own keys that work right now, for the `?` panel and `/help` (the raw bytes are ctrl+s and ctrl+r). */
	editorKeys(): EditorKeys {
		return {
			clearInput: true,
			...(this.#boundInEditor("\x13") ? {} : { stash: STASH_KEY }),
			...(this.#boundInEditor("\x12") ? {} : { historySearch: HISTORY_SEARCH_KEY }),
		};
	}

	/** pi records each submitted prompt here; keep a copy for the history search (pi-tui's list is private). */
	addToHistory(text: string): void {
		this.#history.add(text);
		super.addToHistory(text);
	}

	/** A key while the history search runs; false hands it on after accepting the match. */
	#searchInput(data: string): boolean {
		const entries = this.#history.entries;
		const show = (text: string) => {
			if (text !== this.getText()) this.setText(text);
			this.tui.requestRender();
			return true;
		};
		if (keyId(data) === HISTORY_SEARCH_KEY) return show(this.#search.older(entries));
		if (this.#keys.matches(data, "app.clear")) return show(this.#search.cancel());
		if (this.#keys.matches(data, "app.interrupt") || this.#keys.matches(data, "tui.input.tab")) {
			this.#search.accept();
			return show(this.getText());
		}
		if (this.#keys.matches(data, "tui.editor.deleteCharBackward")) return show(this.#search.setQuery([...this.#search.query].slice(0, -1).join(""), entries));
		const typed = data.startsWith("\x1b[200~") ? undefined : keyText(data);
		if (typed) return show(this.#search.setQuery(this.#search.query + typed, entries));
		this.#search.accept();
		this.tui.requestRender();
		return false;
	}

	handleInput(data: string): void {
		if (this.#search.active && this.#searchInput(data)) return;
		const text = this.getText();
		if (this.#shortcutsInput(data, text)) return;
		if (this.#escapeInput(data, text)) return;
		if (this.#ownKeyInput(data, text)) return;
		// ↑ on the first line restores queued messages, as in Claude Code (queued-edit.ts).
		const dequeue = this.actionHandlers.get("app.message.dequeue");
		if (dequeue && this.#keys.matches(data, "tui.editor.cursorUp") && upEditsQueue(this, this.#hooks.queued?.() ?? false, this.#layoutWidth)) {
			dequeue();
			return;
		}
		super.handleInput(data);
	}

	/**
	 * The `?` panel: it closes on the next key, which is then handled as usual
	 * (a second `?` on the empty editor only closes it), and `?` on the empty
	 * editor opens it, unless the `?` is pasted text. True when the key is used up.
	 */
	#shortcutsInput(data: string, text: string): boolean {
		if (this.#shortcutsOpen) {
			this.#shortcutsOpen = false;
			this.#shortcutsLines = undefined;
			this.tui.requestRender();
			if (text === "" && isQuestionKey(data)) return true;
		}
		if (data.includes(PASTE_START)) this.#inPaste = true;
		if (data.includes(PASTE_END)) this.#inPaste = false;
		if (this.#inPaste || text !== "" || !isQuestionKey(data) || !this.#hooks.shortcuts) return false;
		this.#shortcutsOpen = true;
		this.tui.requestRender();
		return true;
	}

	/** Esc esc clears the input; any other key disarms it. True when the key is used up. */
	#escapeInput(data: string, text: string): boolean {
		if (!this.#keys.matches(data, "app.interrupt")) {
			this.#escape.other();
			return false;
		}
		const verdict = this.#escape.press(this.#now(), {
			hasText: text.trim() !== "",
			idle: this.#hooks.idle?.() ?? true,
			menuOpen: this.isShowingAutocomplete(),
			viewOpen: this.#hooks.scrollView?.() !== undefined,
			bashMode: text.trimStart().startsWith("!"),
			bashRunning: this.#bashRuns > 0,
		});
		if (verdict === "clear") {
			// setText keeps an undo snapshot, so the undo key brings the text back.
			this.setText("");
			this.tui.requestRender();
			return true;
		}
		if (verdict === "arm") this.#expireEscHint();
		return false;
	}

	/** The stash and history-search keys, unless a pi binding the user made or a ctrl+x chord has them. True when the key is used up. */
	#ownKeyInput(data: string, text: string): boolean {
		const id = keyId(data);
		if ((id !== HISTORY_SEARCH_KEY && id !== STASH_KEY) || this.#hooks.chordKey?.() === id || this.#boundInEditor(data)) return false;
		// An extension's own shortcut on the key keeps it.
		if (this.onExtensionShortcut?.(data)) return true;
		if (id === HISTORY_SEARCH_KEY) {
			this.#search.start(text);
		} else {
			const next = this.#stash.toggle(this.getExpandedText?.() ?? text);
			if (next !== undefined) this.setText(next);
		}
		this.tui.requestRender();
		return true;
	}

	/** Repaint once the second Esc's window has passed, so its hint goes away. */
	#expireEscHint(): void {
		clearTimeout(this.#escTimer);
		this.#escTimer = setTimeout(() => this.tui.requestRender(), DOUBLE_ESC_MS + 20);
		this.#escTimer.unref?.();
	}

	/** A wheel over the editor's rows scrolls an open agent view, not the main transcript under it. */
	handleMouse(event: Parameters<CustomEditor["handleMouse"]>[0]): ReturnType<CustomEditor["handleMouse"]> {
		const scrollView = this.#hooks.scrollView?.();
		if (scrollView && event.type === "wheel" && event.wheelDelta) {
			scrollView({ action: "wheel", lines: event.wheelDelta });
			return { handled: true };
		}
		return super.handleMouse(event);
	}

	/**
	 * Pin the gutter. On install pi copies the *default* editor's paddingX (0)
	 * onto us, which would leave no room to paint into; keep it at our width so
	 * the marker always has its gutter. A caller asking for a wider gutter still
	 * gets at least ours.
	 */
	setPaddingX(padding: number): void {
		super.setPaddingX(Math.max(PROMPT_PADDING, padding));
	}

	/** pi hands over its `autocompleteMaxVisible` setting here; the command menu sizes from it per request. */
	setAutocompleteMaxVisible(maxVisible: number): void {
		this.#configuredRows = maxVisible;
		super.setAutocompleteMaxVisible(maxVisible);
	}

	/**
	 * Size each menu as it opens (pi-tui reads the row count when it builds the
	 * list) and end the command menu's cut descriptions with an ellipsis, at the
	 * width the list is drawn at.
	 */
	setAutocompleteProvider(provider: Provider): void {
		const wrapped = Object.create(provider) as Provider;
		wrapped.getSuggestions = async (lines, cursorLine, cursorCol, options) => {
			const suggestions = await provider.getSuggestions(lines, cursorLine, cursorCol, options);
			if (!suggestions) return suggestions;
			const command = isCommandMenu(suggestions.prefix);
			const rows = command ? slashMenuRows(this.tui.terminal?.rows ?? Number.NaN, this.#configuredRows) : this.#configuredRows;
			super.setAutocompleteMaxVisible(rows);
			return command ? { ...suggestions, items: fitSlashDescriptions(suggestions.items, this.#contentWidth) } : suggestions;
		};
		super.setAutocompleteProvider(wrapped);
	}

	render(width: number): string[] {
		const paddingX = Math.min(PROMPT_PADDING, Math.max(0, Math.floor((width - 1) / 2)));
		this.#contentWidth = Math.max(1, width - paddingX * 2);
		this.#layoutWidth = Math.max(1, this.#contentWidth - (paddingX ? 0 : 1));
		let lines = applyPromptMarker(super.render(width), PROMPT_PADDING, this.#hooks.marker());
		const hint = this.#hooks.hint?.(this.getText());
		if (hint) lines = applyArgumentHint(lines, hint);
		lines = this.#withBorderLabels(lines, width);
		const below = this.#linesBelow(width);
		return below.length > 0 ? [...lines, ...below] : lines;
	}

	/** The session title, then the agent badge, at the right of the top border. */
	#withBorderLabels(lines: string[], width: number): string[] {
		const dim = this.#hooks.dim ?? ((text: string) => text);
		const label = this.#hooks.badge?.();
		const fitted = label ? fitBadge(label, width) : "";
		const badgeWidth = fitted ? visibleWidth(fitted) + 2 : 0;
		const glyph = this.borderColor("─");
		const title = fitBorderTitle(lines[0] ?? "", this.#hooks.title?.(), badgeWidth ? badgeWidth + 1 : 0);
		if (!title && !fitted) return lines;
		const badge = fitted ? (this.#hooks.paintBadge ?? ((text: string) => text))(fitted) : "";
		const tail = title ? `${dim(` ${title} `)}${fitted ? `${glyph}${badge}` : ""}` : badge;
		const tailWidth = (title ? visibleWidth(title) + 2 + (fitted ? 1 : 0) : 0) + badgeWidth;
		return applyBorderBadge(lines, tail, tailWidth, glyph);
	}

	/** The open `?` panel's lines, built once per width while it stays open. */
	#shortcutLines(build: NonNullable<PromptEditorHooks["shortcuts"]>, width: number): string[] {
		if (this.#shortcutsLines?.width !== width) this.#shortcutsLines = { width, lines: build(width, this.editorKeys()) };
		return this.#shortcutsLines.lines;
	}

	/** The dim lines under the editor: the history search, the `?` panel, the second Esc's hint, the stash notice. */
	#linesBelow(width: number): string[] {
		const dim = this.#hooks.dim ?? ((text: string) => text);
		const plain: string[] = [];
		if (this.#search.active) plain.push(`  ${this.#search.prompt()}`);
		else if (this.#shortcutsOpen && this.#hooks.shortcuts) plain.push(...this.#shortcutLines(this.#hooks.shortcuts, width));
		else if (this.#escape.armed(this.#now())) plain.push(`  ${ESC_AGAIN_HINT}`);
		if (this.#stash.stashed) plain.push(`  ${STASH_NOTICE}`);
		return plain.map((line) => dim(cutPlainText(line, width)));
	}
}
