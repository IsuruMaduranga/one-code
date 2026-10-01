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

export interface QueueEditEditor {
	getCursor(): { line: number; col: number };
	isShowingAutocomplete(): boolean;
	/**
	 * pi's own top-row test, which its history navigation uses: the first
	 * visual row, so ↑ on a wrapped first line still moves the cursor. Private
	 * in pi's editor; the logical first line stands in when it is missing.
	 */
	isOnFirstVisualLine?(): boolean;
}

/** Whether a plain ↑ restores the queued messages rather than reaching the editor. */
export function upEditsQueue(editor: QueueEditEditor, queued: boolean): boolean {
	if (!queued) return false;
	if (editor.isShowingAutocomplete()) return false;
	return editor.isOnFirstVisualLine ? editor.isOnFirstVisualLine() : editor.getCursor().line === 0;
}
