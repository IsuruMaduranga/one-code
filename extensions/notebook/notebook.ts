/**
 * Jupyter notebook editing (pure) — Claude Code's NotebookEdit semantics.
 *
 * Cells are addressed by `id`, but nbformat only made `id` mandatory in 4.5:
 * a 4.4-era notebook has none, and a model handed one had no id to pass and no
 * way to append. Both a cheap-tier and a tiny-tier model fell back to bash plus
 * `nbformat`/`json` to patch ids in — the exact route the prompt had told them
 * not to take — 6/6 runs (WEAK-MODEL-REVIEW-2026-09-06 M4). So cells are also
 * addressable by POSITION, as Claude Code's Read renders them: `cell-0`,
 * `cell-1`, … Positional ids are resolved against the notebook as it is when
 * the call arrives, so they shift after an insert or a delete — which is why
 * every failure enumerates the notebook's current cells.
 */

export interface NotebookCell {
	cell_type: string;
	id?: string;
	source: string | string[];
	metadata?: Record<string, unknown>;
	outputs?: unknown[];
	execution_count?: number | null;
}

export interface Notebook {
	cells: NotebookCell[];
	[key: string]: unknown;
}

export type EditMode = "replace" | "insert" | "append" | "delete";

export interface EditRequest {
	cellId?: string;
	newSource?: string;
	cellType?: "code" | "markdown";
	editMode: EditMode;
}

export function parseNotebook(content: string): Notebook {
	const parsed = JSON.parse(content) as Notebook;
	if (!Array.isArray(parsed.cells)) throw new Error("Not a Jupyter notebook: missing 'cells' array");
	return parsed;
}

/** Notebooks store source as a line array with trailing newlines; match that. */
export function toSourceLines(source: string): string[] {
	const lines = source.split("\n");
	return lines.map((line, i) => (i === lines.length - 1 ? line : `${line}\n`)).filter((l, i) => l !== "" || i === 0);
}

/** The positional id of a cell, Claude Code's spelling. */
export function positionalId(index: number): string {
	return `cell-${index}`;
}

/** How a cell should be named back to the model: its own id, else its position. */
export function cellLabel(cell: NotebookCell, index: number): string {
	return cell.id ?? positionalId(index);
}

/** `aaa (markdown), cell-1 (code)` — every id the notebook currently answers to. */
export function describeCells(notebook: Notebook): string {
	if (notebook.cells.length === 0) return "(none — the notebook has no cells)";
	return notebook.cells.map((cell, index) => `${cellLabel(cell, index)} (${cell.cell_type})`).join(", ");
}

/**
 * Trailing hint appended to a notebook_edit failure message. A missing file or
 * malformed JSON gets a targeted pointer; a cell-addressing failure (a missing or
 * wrong `cell_id`) gets the list of ids the notebook actually has, so a weak tier
 * picks a real one instead of inventing it by hand (review M4). A missing
 * `new_source`/`cell_type` is not about a cell, so it gets no id listing — that
 * would misdirect (code-review F3). A real "No cell with id" already lists them,
 * so it is left untouched.
 */
export function notebookErrorHint(opts: { code?: string; syntax: boolean; message: string; parsed: Notebook | undefined }): string {
	if (opts.code === "ENOENT") return " — no such file; check the path points to an existing .ipynb";
	if (opts.syntax) return " — the file is not valid notebook JSON";
	if (opts.parsed && opts.message.includes("cell_id") && !opts.message.includes("cells are:")) {
		return ` — this notebook's cells are: ${describeCells(opts.parsed)}. Address a cell by its own id or by position (cell-0 is the first); edit_mode "append" adds one at the end.`;
	}
	return "";
}

/** Index of a cell by its own id, or by its `cell-N` position. -1 when neither matches. */
export function findCellIndex(notebook: Notebook, cellId: string): number {
	const byId = notebook.cells.findIndex((cell) => cell.id === cellId);
	if (byId !== -1) return byId;
	const positional = /^cell-(\d+)$/.exec(cellId);
	if (!positional) return -1;
	const index = Number.parseInt(positional[1], 10);
	return index < notebook.cells.length ? index : -1;
}

/**
 * The "fail loud, name the fix" error for an id that resolves to nothing
 * (docs/decisions/tools.md): which ids exist, and the two ways to add a cell
 * without naming one.
 */
export function noSuchCellError(notebook: Notebook, cellId: string): Error {
	return new Error(
		`No cell with id "${cellId}". This notebook's cells are: ${describeCells(notebook)}. ` +
			"Cells can be addressed by their own id or by position (cell-0 is the first). " +
			'To add a cell without naming one, use edit_mode "append" (at the end) or omit cell_id with edit_mode "insert" (at the top).',
	);
}

function newCell(cellType: "code" | "markdown", source: string, id: string | undefined): NotebookCell {
	const cell: NotebookCell = { cell_type: cellType, metadata: {}, source: toSourceLines(source) };
	// A 4.4 notebook has no legal `id` field, so a new cell must not carry one
	// either — stamping one would leave a single id-bearing cell among id-less
	// ones, which is exactly the shape withRepairedIds refuses to create.
	if (id !== undefined) cell.id = id;
	if (cellType === "code") {
		cell.outputs = [];
		cell.execution_count = null;
	}
	return cell;
}

/**
 * nbformat 4.5 REQUIRES every cell to carry an id, so a 4.5+ notebook missing
 * them is malformed and filling them in on the way out is a repair, not a
 * rewrite. A 4.4 notebook is left alone: `id` is not a legal cell field there,
 * and its cells stay addressable by position.
 */
function supportsIds(notebook: Notebook): boolean {
	const minor = typeof notebook.nbformat_minor === "number" ? notebook.nbformat_minor : 0;
	const major = typeof notebook.nbformat === "number" ? notebook.nbformat : 4;
	return major > 4 || (major === 4 && minor >= 5);
}

function withRepairedIds(notebook: Notebook, cells: NotebookCell[], makeId: () => string): NotebookCell[] {
	if (!supportsIds(notebook)) return cells;
	return cells.map((cell) => (cell.id ? cell : { ...cell, id: makeId() }));
}

export interface EditResult {
	notebook: Notebook;
	summary: string;
}

/**
 * Applies one edit and returns a new notebook object. `makeId` supplies the id
 * for inserted cells (injected so callers can keep this deterministic in tests).
 */
export function applyEdit(notebook: Notebook, request: EditRequest, makeId: () => string): EditResult {
	const cells = [...notebook.cells];
	const finish = (updated: NotebookCell[], summary: string): EditResult => ({
		notebook: { ...notebook, cells: withRepairedIds(notebook, updated, makeId) },
		summary,
	});

	if (request.editMode === "delete") {
		if (!request.cellId) throw new Error("cell_id is required for edit_mode 'delete'");
		const index = findCellIndex(notebook, request.cellId);
		if (index === -1) throw noSuchCellError(notebook, request.cellId);
		const label = cellLabel(cells[index], index);
		cells.splice(index, 1);
		return finish(cells, `Deleted cell ${label}`);
	}

	if (request.newSource === undefined) throw new Error("new_source is required unless edit_mode is 'delete'");

	if (request.editMode === "insert" || request.editMode === "append") {
		if (!request.cellType) throw new Error(`cell_type is required for edit_mode '${request.editMode}'`);
		const cell = newCell(request.cellType, request.newSource, supportsIds(notebook) ? makeId() : undefined);
		if (request.editMode === "append") {
			cells.push(cell);
			// Named the way the model must address it next: its id, or its position
			// in a notebook that has none.
			return finish(cells, `Appended ${request.cellType} cell ${cellLabel(cell, cells.length - 1)} at the end`);
		}
		// Claude Code inserts AFTER the given cell; no cell_id means insert first.
		const index = request.cellId ? findCellIndex(notebook, request.cellId) : -1;
		if (request.cellId && index === -1) throw noSuchCellError(notebook, request.cellId);
		const afterLabel = request.cellId ? cellLabel(notebook.cells[index], index) : undefined;
		cells.splice(index + 1, 0, cell);
		return finish(cells, `Inserted ${request.cellType} cell ${cellLabel(cell, index + 1)}${afterLabel ? ` after ${afterLabel}` : " at the top"}`);
	}

	if (!request.cellId) throw new Error("cell_id is required for edit_mode 'replace'");
	const index = findCellIndex(notebook, request.cellId);
	if (index === -1) throw noSuchCellError(notebook, request.cellId);
	const existing = cells[index];
	const label = cellLabel(existing, index);
	const cellType = (request.cellType ?? existing.cell_type) as "code" | "markdown";
	const replacement: NotebookCell = {
		...existing,
		cell_type: cellType,
		source: toSourceLines(request.newSource),
	};
	if (cellType === "code") {
		replacement.outputs = [];
		replacement.execution_count = null;
	} else {
		delete replacement.outputs;
		delete replacement.execution_count;
	}
	cells[index] = replacement;
	return finish(cells, `Replaced cell ${label}`);
}
