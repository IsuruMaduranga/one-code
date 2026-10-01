/**
 * Claude Code's key for editing queued messages: plain ↑. With a message
 * queued mid-turn, ↑ moves every queued message into the editor instead of
 * walking history, but only with the cursor on the draft's first line (lower
 * lines need ↑ to move the cursor) and no autocomplete list open (↑ moves in
 * the list). pi binds the same restore only to alt+up, which not every
 * terminal sends: macOS Terminal's terminfo (nsterm) maps option+left and
 * option+right but no modified up arrow. Pure: `prompt-editor.ts` calls pi's
 * own dequeue action, so the alt+up binding keeps working alongside.
 */

import { visibleWidth } from "../lib/text-width.ts";

export interface QueueEditEditor {
	getCursor(): { line: number; col: number };
	getLines(): string[];
	isShowingAutocomplete(): boolean;
}

/**
 * Whether a plain ↑ restores the queued messages rather than reaching the
 * editor. Only on a first line that fits one row of `layoutWidth`: pi's
 * public API does not say which visual row the cursor is on, so on a wrapped
 * first line ↑ is left to pi (it moves the cursor) and alt+up restores.
 */
export function upEditsQueue(editor: QueueEditEditor, queued: boolean, layoutWidth: number): boolean {
	if (!queued) return false;
	if (editor.isShowingAutocomplete()) return false;
	if (editor.getCursor().line !== 0) return false;
	return visibleWidth(editor.getLines()[0] ?? "") <= layoutWidth;
}
