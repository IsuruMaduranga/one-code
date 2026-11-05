/**
 * notebook_edit's model-facing description: Claude Code's NotebookEdit text
 * with One Code's extras (pure).
 *
 * Claude Code addresses a cell by the id its Read tool prints; pi's read
 * returns the notebook's JSON, so a cell is named by its own `id` or by its
 * position (`cell-0`). The path may be relative and is `path` or
 * `notebook_path`; `append` and the cleared outputs are One Code's.
 */

export const NOTEBOOK_EDIT_DESCRIPTION = `Replaces, inserts, or deletes a single cell in a Jupyter notebook (.ipynb file).

Usage:
- You must use the read tool on the notebook in this conversation before editing — this tool will fail otherwise.
- \`path\` (or \`notebook_path\`) is the notebook, absolute or relative to the working directory.
- \`cell_id\` is the cell's own \`id\` or, for a notebook whose cells have none, its position: \`cell-0\` is the first cell. It is required for \`replace\` and \`delete\`.
- \`edit_mode\` defaults to \`replace\`. Use \`insert\` to add a new cell after the cell with the given \`cell_id\` (or at the beginning of the notebook if \`cell_id\` is omitted) — \`cell_type\` is required when inserting. Use \`delete\` to remove the cell. Use \`append\` to add a cell at the end without naming one.
- Editing a code cell clears its outputs.`;
