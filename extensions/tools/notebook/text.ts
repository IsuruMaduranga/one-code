/**
 * What the notebook tool needs from a profile (types only). The base decides
 * what happened; the profile words it (working-docs/features/profiles/).
 */

/** A cell as the model addresses it: its own id, else its position (`cell-0`). */
export interface CellRef {
	label: string;
	type: string;
}

/** What an edit did, with the cells named the way the model must address them next. */
export type EditOutcome =
	| { kind: "replaced"; cell: string }
	| { kind: "deleted"; cell: string }
	| { kind: "appended"; cellType: "code" | "markdown"; cell: string }
	| { kind: "inserted"; cellType: "code" | "markdown"; cell: string; after?: string };

/** Why an edit failed. `osMessage` is the system's or the parser's own text, passed through. */
export type NotebookFailure =
	/** No path given; `alias` is how the profile names the alias parameter (`NotebookText.pathAlias`). */
	| { kind: "missingPath"; alias: string }
	| { kind: "notANotebook" }
	| { kind: "cellIdRequired"; mode: "replace" | "delete" }
	| { kind: "newSourceRequired" }
	| { kind: "cellTypeRequired"; mode: "insert" | "append" }
	| { kind: "noSuchCell"; cellId: string }
	| { kind: "fileNotFound"; osMessage: string }
	| { kind: "invalidJson"; osMessage: string }
	| { kind: "other"; osMessage: string };

export interface NotebookText {
	description: string;
	/** Search terms for `tool_search`, beyond the tool's name and description. */
	searchKeywords: string[];
	params: Record<"path" | "notebook_path" | "edit_mode" | "cell_id" | "new_source" | "cell_type", string>;
	/** How the missing-path failure names the alias of `path`: "Claude Code's `notebook_path`". */
	pathAlias: string;
}

/** The group's results, refusals and notes, which the base words (`notebookResultText`). */
export interface NotebookResultText {
	edited(p: { outcome: EditOutcome; path: string; cellCount: number }): string;
	/** `cells`: the notebook's cells, when it was read before the failure. */
	failed(p: { failure: NotebookFailure; cells?: readonly CellRef[] }): string;
}

/** `aaa (markdown), cell-1 (code)`: every id the notebook currently answers to. */
function describeCells(cells: readonly CellRef[]): string {
	if (cells.length === 0) return "(none — the notebook has no cells)";
	return cells.map((cell) => `${cell.label} (${cell.type})`).join(", ");
}

function summary(outcome: EditOutcome): string {
	switch (outcome.kind) {
		case "replaced":
			return `Replaced cell ${outcome.cell}`;
		case "deleted":
			return `Deleted cell ${outcome.cell}`;
		case "appended":
			return `Appended ${outcome.cellType} cell ${outcome.cell} at the end`;
		case "inserted":
			return `Inserted ${outcome.cellType} cell ${outcome.cell}${outcome.after ? ` after ${outcome.after}` : " at the top"}`;
	}
}

/**
 * The reason, and a pointer where one helps. A cell-addressing failure lists
 * the ids the notebook actually has, so a weak tier picks a real one instead
 * of inventing it by hand (review M4); a missing `new_source`/`cell_type` is
 * not about a cell and gets no listing (code-review F3).
 */
function reason(failure: Exclude<NotebookFailure, { kind: "missingPath" }>, cells: readonly CellRef[] | undefined): string {
	switch (failure.kind) {
		case "notANotebook":
			return "Not a Jupyter notebook: missing 'cells' array";
		case "cellIdRequired":
			return `cell_id is required for edit_mode '${failure.mode}'${cells ? ` — this notebook's cells are: ${describeCells(cells)}. Address a cell by its own id or by position (cell-0 is the first); edit_mode "append" adds one at the end.` : ""}`;
		case "newSourceRequired":
			return "new_source is required unless edit_mode is 'delete'";
		case "cellTypeRequired":
			return `cell_type is required for edit_mode '${failure.mode}'`;
		case "noSuchCell":
			return (
				`No cell with id "${failure.cellId}". This notebook's cells are: ${describeCells(cells ?? [])}. ` +
				"Cells can be addressed by their own id or by position (cell-0 is the first). " +
				'To add a cell without naming one, use edit_mode "append" (at the end) or omit cell_id with edit_mode "insert" (at the top).'
			);
		case "fileNotFound":
			return `${failure.osMessage} — no such file; check the path points to an existing .ipynb`;
		case "invalidJson":
			return `${failure.osMessage} — the file is not valid notebook JSON`;
		case "other":
			return failure.osMessage;
	}
}

/** The base's words of the group. */
export const notebookResultText: NotebookResultText = {
	edited: ({ outcome, path, cellCount }) => `${summary(outcome)} in ${path} (${cellCount} cells).`,
	failed: ({ failure, cells }) =>
		failure.kind === "missingPath"
			? `\`path\` (or ${failure.alias}) is required: the .ipynb file to edit.`
			: `Notebook edit failed: ${reason(failure, cells)}`,
};
