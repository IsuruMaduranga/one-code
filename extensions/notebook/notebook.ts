/**
 * Jupyter notebook editing (pure) — Claude Code's NotebookEdit semantics.
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

export type EditMode = "replace" | "insert" | "delete";

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

export function findCellIndex(notebook: Notebook, cellId: string): number {
	return notebook.cells.findIndex((cell) => cell.id === cellId);
}

function newCell(cellType: "code" | "markdown", source: string, id: string): NotebookCell {
	const cell: NotebookCell = { cell_type: cellType, id, metadata: {}, source: toSourceLines(source) };
	if (cellType === "code") {
		cell.outputs = [];
		cell.execution_count = null;
	}
	return cell;
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

	if (request.editMode === "delete") {
		if (!request.cellId) throw new Error("cell_id is required for edit_mode 'delete'");
		const index = findCellIndex(notebook, request.cellId);
		if (index === -1) throw new Error(`No cell with id "${request.cellId}"`);
		cells.splice(index, 1);
		return { notebook: { ...notebook, cells }, summary: `Deleted cell ${request.cellId}` };
	}

	if (request.newSource === undefined) throw new Error("new_source is required unless edit_mode is 'delete'");

	if (request.editMode === "insert") {
		if (!request.cellType) throw new Error("cell_type is required for edit_mode 'insert'");
		const id = makeId();
		const cell = newCell(request.cellType, request.newSource, id);
		// Claude Code inserts AFTER the given cell; no cell_id means insert first.
		const index = request.cellId ? findCellIndex(notebook, request.cellId) : -1;
		if (request.cellId && index === -1) throw new Error(`No cell with id "${request.cellId}"`);
		cells.splice(index + 1, 0, cell);
		return {
			notebook: { ...notebook, cells },
			summary: `Inserted ${request.cellType} cell ${id}${request.cellId ? ` after ${request.cellId}` : " at the top"}`,
		};
	}

	if (!request.cellId) throw new Error("cell_id is required for edit_mode 'replace'");
	const index = findCellIndex(notebook, request.cellId);
	if (index === -1) throw new Error(`No cell with id "${request.cellId}"`);
	const existing = cells[index];
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
	return { notebook: { ...notebook, cells }, summary: `Replaced cell ${request.cellId}` };
}
