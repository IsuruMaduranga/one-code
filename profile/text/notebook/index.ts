/**
 * One Code's notebook_edit text (the profile's `text.notebook`): the
 * description, parameter docs, results and failures, in Claude Code's
 * NotebookEdit wording with One Code's extras (description.ts).
 */

import type { CellRef, EditOutcome, NotebookFailure, NotebookText } from "../../../extensions/sdk/profile.ts";
import { NOTEBOOK_EDIT_DESCRIPTION } from "./description.ts";

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

export const notebook: NotebookText = {
	description: NOTEBOOK_EDIT_DESCRIPTION,
	searchKeywords: ["notebook", "jupyter", "ipynb", "cell"],
	params: {
		path: "Absolute or workspace-relative path to the .ipynb file",
		notebook_path: "Alias of `path` (Claude Code's name for it).",
		edit_mode: "The type of edit to make. Defaults to replace.",
		cell_id:
			"Target cell id, either the cell's own id or its position as `cell-0`, `cell-1`, … Required for replace and delete; for insert the new cell goes after it (omit to insert at the top); ignored for append.",
		new_source: "New cell source. Required unless deleting.",
		cell_type: "Cell type. Required when inserting or appending; when replacing, changes the cell's type.",
	},
	edited: ({ outcome, path, cellCount }) => `${summary(outcome)} in ${path} (${cellCount} cells).`,
	failed: ({ failure, cells }) =>
		failure.kind === "missingPath"
			? "`path` (or Claude Code's `notebook_path`) is required: the .ipynb file to edit."
			: `Notebook edit failed: ${reason(failure, cells)}`,
};
