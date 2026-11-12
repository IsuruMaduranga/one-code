/**
 * One Code's notebook_edit words (the profile's `text.notebook`): the
 * description and parameter docs in Claude Code's NotebookEdit wording with
 * One Code's extras (description.ts), and the name of the path's alias.
 */

import type { NotebookText } from "../../../extensions/sdk/profile.ts";
import { NOTEBOOK_EDIT_DESCRIPTION } from "./description.ts";

export const notebook: NotebookText = {
	pathAlias: "Claude Code's `notebook_path`",
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
};
