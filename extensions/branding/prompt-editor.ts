/**
 * PromptEditor — the core input editor with a Claude Code-style "❯" marker.
 *
 * pi's editor has no prompt marker and no option for one, but `CustomEditor` is
 * the sanctioned base for a replacement (it already wires every app keybinding
 * through handleInput, which we leave untouched). We only reserve a two-column
 * left gutter and paint the marker into it — see prompt-marker.ts for why that
 * is cursor-safe. Registered via `ctx.ui.setEditorComponent`; this file is thin
 * wiring over the pure `applyPromptMarker`.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { applyPromptMarker } from "./prompt-marker.ts";

/** Width of the left gutter, and therefore the visible width the marker must fill. */
export const PROMPT_PADDING = 2;

type EditorArgs = ConstructorParameters<typeof CustomEditor>;

export class PromptEditor extends CustomEditor {
	/** Re-read per render so the marker follows live theme changes. */
	#renderMarker: () => string;

	constructor(tui: EditorArgs[0], theme: EditorArgs[1], keybindings: EditorArgs[2], renderMarker: () => string) {
		super(tui, theme, keybindings, { paddingX: PROMPT_PADDING });
		this.#renderMarker = renderMarker;
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
		return applyPromptMarker(super.render(width), PROMPT_PADDING, this.#renderMarker());
	}
}
