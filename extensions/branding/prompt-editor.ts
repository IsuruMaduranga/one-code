/**
 * PromptEditor — the core input editor with a Claude Code-style "❯" marker.
 *
 * pi's editor has no prompt marker and no option for one, but `CustomEditor` is
 * the sanctioned base for a replacement (it already wires every app keybinding
 * through handleInput). We reserve a two-column left gutter and paint the
 * marker into it — see prompt-marker.ts for why that is cursor-safe — draw a
 * slash command's argument hint after the cursor (lib/argument-hints.ts), and
 * let ↑ restore queued messages through pi's dequeue action (queued-edit.ts). Registered via `ctx.ui.setEditorComponent`; this file is thin
 * wiring over the pure `applyPromptMarker`.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { applyBorderBadge, fitBadge } from "../lib/agent-view.ts";
import { applyArgumentHint } from "../lib/argument-hints.ts";
import { visibleWidth } from "../lib/text-width.ts";
import { applyPromptMarker } from "./prompt-marker.ts";
import { upEditsQueue } from "./queued-edit.ts";

/** Width of the left gutter, and therefore the visible width the marker must fill. */
export const PROMPT_PADDING = 2;

type EditorArgs = ConstructorParameters<typeof CustomEditor>;

export class PromptEditor extends CustomEditor {
	/** Re-read per render so the marker follows live theme changes. */
	#renderMarker: () => string;
	/** The painted argument placeholder for the current input, if it is a hinted command. */
	#renderHint: (text: string) => string | undefined;
	/** The viewed agent's top-border label (plain text), or undefined on main (lib/agent-view.ts). */
	#badge: () => string | undefined;
	/** Paints the fitted badge label as a chip, one space of padding on each side. */
	#paintBadge: (label: string) => string;
	/** Whether a message waits in pi's queue mid-turn (queued-edit.ts). */
	#queued: () => boolean;
	#keys: EditorArgs[2];

	constructor(
		tui: EditorArgs[0],
		theme: EditorArgs[1],
		keybindings: EditorArgs[2],
		renderMarker: () => string,
		renderHint: (text: string) => string | undefined = () => undefined,
		badge: () => string | undefined = () => undefined,
		paintBadge: (label: string) => string = (label) => label,
		queued: () => boolean = () => false,
	) {
		super(tui, theme, keybindings, { paddingX: PROMPT_PADDING, embedWorkingStatus: true });
		this.#renderMarker = renderMarker;
		this.#renderHint = renderHint;
		this.#badge = badge;
		this.#paintBadge = paintBadge;
		this.#queued = queued;
		this.#keys = keybindings;
	}

	/** ↑ on the first line restores queued messages, as in Claude Code (queued-edit.ts). */
	handleInput(data: string): void {
		const dequeue = this.actionHandlers.get("app.message.dequeue");
		if (dequeue && this.#keys.matches(data, "tui.editor.cursorUp") && upEditsQueue(this, this.#queued())) {
			dequeue();
			return;
		}
		super.handleInput(data);
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

	render(width: number): string[] {
		let lines = applyPromptMarker(super.render(width), PROMPT_PADDING, this.#renderMarker());
		const hint = this.#renderHint(this.getText());
		if (hint) lines = applyArgumentHint(lines, hint);
		const label = this.#badge();
		const fitted = label ? fitBadge(label, width) : "";
		return fitted ? applyBorderBadge(lines, this.#paintBadge(fitted), visibleWidth(fitted) + 2, this.borderColor("─")) : lines;
	}
}
