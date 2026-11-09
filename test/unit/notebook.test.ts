import { describe, expect, it } from "vitest";
/**
 * The notebook tool's logic (extensions/tools/notebook/notebook.ts): what an edit
 * does and why it fails, as data. One Code's wording of it is checked in
 * profile-notebook-text.test.ts.
 */
import { applyEdit, cellRefs, findCellIndex, type Notebook, NotebookError, notebookFailure, parseNotebook, toSourceLines } from "../../extensions/tools/notebook/notebook.ts";

/** The failure an edit throws. */
const failureOf = (edit: () => unknown) => {
	try {
		edit();
	} catch (error) {
		return notebookFailure(error);
	}
	throw new Error("the edit did not fail");
};

const nb = (): Notebook => ({
	nbformat: 4,
	nbformat_minor: 5,
	metadata: {},
	cells: [
		{ cell_type: "markdown", id: "aaa", source: ["# Title\n"] },
		{ cell_type: "code", id: "bbb", source: ["print(1)\n"], outputs: [{ text: "1" }], execution_count: 3 },
	],
});

const ids = () => "new1";

describe("parseNotebook", () => {
	it("rejects non-notebook JSON", () => {
		expect(failureOf(() => parseNotebook('{"foo":1}'))).toEqual({ kind: "notANotebook" });
		expect(failureOf(() => parseNotebook("not json")).kind).toBe("invalidJson");
	});
});

describe("toSourceLines", () => {
	it("keeps trailing newlines per line like nbformat does", () => {
		expect(toSourceLines("a\nb")).toEqual(["a\n", "b"]);
		expect(toSourceLines("single")).toEqual(["single"]);
	});
});

describe("applyEdit", () => {
	it("replaces a cell's source and clears code outputs", () => {
		const { notebook, outcome } = applyEdit(nb(), { cellId: "bbb", newSource: "print(2)", editMode: "replace" }, ids);
		const cell = notebook.cells[1];
		expect(cell.source).toEqual(["print(2)"]);
		expect(cell.outputs).toEqual([]);
		expect(cell.execution_count).toBeNull();
		expect(outcome).toEqual({ kind: "replaced", cell: "bbb" });
	});

	it("drops output fields when replacing a code cell with markdown", () => {
		const { notebook } = applyEdit(
			nb(),
			{ cellId: "bbb", newSource: "notes", cellType: "markdown", editMode: "replace" },
			ids,
		);
		expect(notebook.cells[1].cell_type).toBe("markdown");
		expect(notebook.cells[1].outputs).toBeUndefined();
		expect(notebook.cells[1].execution_count).toBeUndefined();
	});

	it("inserts after the given cell", () => {
		const { notebook } = applyEdit(
			nb(),
			{ cellId: "aaa", newSource: "x = 1", cellType: "code", editMode: "insert" },
			ids,
		);
		expect(notebook.cells.map((c) => c.id)).toEqual(["aaa", "new1", "bbb"]);
		expect(notebook.cells[1].outputs).toEqual([]);
		expect(applyEdit(nb(), { cellId: "aaa", newSource: "x", cellType: "code", editMode: "insert" }, ids).outcome).toEqual({ kind: "inserted", cellType: "code", cell: "new1", after: "aaa" });
	});

	it("inserts at the top when no cell_id is given", () => {
		const { notebook, outcome } = applyEdit(nb(), { newSource: "# intro", cellType: "markdown", editMode: "insert" }, ids);
		expect(notebook.cells.map((c) => c.id)).toEqual(["new1", "aaa", "bbb"]);
		expect(outcome).toEqual({ kind: "inserted", cellType: "markdown", cell: "new1" });
	});

	it("deletes a cell", () => {
		const { notebook } = applyEdit(nb(), { cellId: "aaa", editMode: "delete" }, ids);
		expect(notebook.cells.map((c) => c.id)).toEqual(["bbb"]);
	});

	it("does not mutate the input notebook", () => {
		const original = nb();
		applyEdit(original, { cellId: "aaa", editMode: "delete" }, ids);
		expect(original.cells).toHaveLength(2);
	});

	it("validates required arguments", () => {
		expect(failureOf(() => applyEdit(nb(), { editMode: "delete" }, ids))).toEqual({ kind: "cellIdRequired", mode: "delete" });
		expect(failureOf(() => applyEdit(nb(), { newSource: "x", editMode: "replace" }, ids))).toEqual({ kind: "cellIdRequired", mode: "replace" });
		expect(failureOf(() => applyEdit(nb(), { cellId: "aaa", editMode: "replace" }, ids))).toEqual({ kind: "newSourceRequired" });
		expect(failureOf(() => applyEdit(nb(), { newSource: "x", editMode: "insert" }, ids))).toEqual({ kind: "cellTypeRequired", mode: "insert" });
		expect(failureOf(() => applyEdit(nb(), { cellId: "zzz", newSource: "x", editMode: "replace" }, ids))).toEqual({ kind: "noSuchCell", cellId: "zzz" });
	});

	it("passes the system's own message through for a file error", () => {
		const missing = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
		expect(notebookFailure(missing)).toEqual({ kind: "fileNotFound", osMessage: "ENOENT: no such file" });
		expect(notebookFailure(new Error("EACCES"))).toEqual({ kind: "other", osMessage: "EACCES" });
		expect(new NotebookError({ kind: "newSourceRequired" }).failure.kind).toBe("newSourceRequired");
	});
});

/** nbformat 4.4: cells carry no `id`, which is what a real fixture looks like. */
const idless = (): Notebook => ({
	nbformat: 4,
	nbformat_minor: 4,
	metadata: {},
	cells: [
		{ cell_type: "markdown", source: ["# Title\n"] },
		{ cell_type: "code", source: ["print(1)\n"] },
	],
});

describe("addressing cells without ids", () => {
	it("resolves a cell by its position when it has no id", () => {
		expect(findCellIndex(idless(), "cell-0")).toBe(0);
		expect(findCellIndex(idless(), "cell-1")).toBe(1);
		expect(findCellIndex(idless(), "cell-9")).toBe(-1);
	});

	it("prefers a real id over the positional form", () => {
		const notebook: Notebook = { ...nb(), cells: [{ cell_type: "code", id: "cell-1", source: [] }, ...nb().cells] };
		expect(findCellIndex(notebook, "cell-1")).toBe(0);
	});

	it("lists every id the notebook answers to", () => {
		expect(cellRefs(idless())).toEqual([{ label: "cell-0", type: "markdown" }, { label: "cell-1", type: "code" }]);
		expect(cellRefs(nb())).toEqual([{ label: "aaa", type: "markdown" }, { label: "bbb", type: "code" }]);
		expect(cellRefs({ ...nb(), cells: [] })).toEqual([]);
	});

	it("replaces and deletes an id-less cell by position", () => {
		const replaced = applyEdit(idless(), { cellId: "cell-1", newSource: "print(2)", editMode: "replace" }, ids);
		expect(replaced.notebook.cells[1].source).toEqual(["print(2)"]);
		expect(replaced.outcome).toEqual({ kind: "replaced", cell: "cell-1" });
		const deleted = applyEdit(idless(), { cellId: "cell-0", editMode: "delete" }, ids);
		expect(deleted.notebook.cells).toHaveLength(1);
		expect(deleted.outcome).toEqual({ kind: "deleted", cell: "cell-0" });
	});

	it("reports an id that does not resolve, whatever the mode", () => {
		expect(failureOf(() => applyEdit(idless(), { cellId: "1", newSource: "x", editMode: "replace" }, ids))).toEqual({ kind: "noSuchCell", cellId: "1" });
		expect(failureOf(() => applyEdit(idless(), { cellId: "last", newSource: "x", cellType: "code", editMode: "insert" }, ids))).toEqual({ kind: "noSuchCell", cellId: "last" });
	});
});

describe("append", () => {
	it("adds a cell at the end with no cell_id at all, named by position on a 4.4 notebook", () => {
		const { notebook, outcome } = applyEdit(idless(), { newSource: "print('hello')", cellType: "code", editMode: "append" }, ids);
		expect(notebook.cells).toHaveLength(3);
		expect(notebook.cells[2].source).toEqual(["print('hello')"]);
		// `id` is not a legal cell field before 4.5, so the new cell must not carry
		// one either — one id-bearing cell among id-less ones is exactly the shape
		// withRepairedIds refuses to create.
		expect(notebook.cells[2].id).toBeUndefined();
		expect(notebook.cells.every((cell) => cell.id === undefined)).toBe(true);
		expect(outcome).toEqual({ kind: "appended", cellType: "code", cell: "cell-2" });
	});

	it("stamps an id on the appended cell when the notebook is 4.5, where ids are required", () => {
		const { notebook, outcome } = applyEdit(
			{ ...idless(), nbformat_minor: 5 },
			{ newSource: "print('hello')", cellType: "code", editMode: "append" },
			ids,
		);
		expect(notebook.cells[2].id).toBe("new1");
		expect(outcome).toEqual({ kind: "appended", cellType: "code", cell: "new1" });
		// And the repair fills the pre-existing cells in, so none is left id-less.
		expect(notebook.cells.every((cell) => typeof cell.id === "string")).toBe(true);
	});

	it("still requires a cell type", () => {
		expect(failureOf(() => applyEdit(idless(), { newSource: "x", editMode: "append" }, ids))).toEqual({ kind: "cellTypeRequired", mode: "append" });
	});
});

describe("id repair", () => {
	it("fills in ids on a 4.5 notebook, where nbformat requires them", () => {
		const notebook: Notebook = { ...idless(), nbformat_minor: 5 };
		const { notebook: updated } = applyEdit(notebook, { newSource: "x", cellType: "code", editMode: "append" }, ids);
		expect(updated.cells.every((cell) => typeof cell.id === "string")).toBe(true);
	});

	it("leaves a 4.4 notebook's cells alone, where `id` is not a legal field", () => {
		const { notebook: updated } = applyEdit(idless(), { newSource: "x", cellType: "code", editMode: "append" }, ids);
		expect(updated.cells[0].id).toBeUndefined();
		expect(updated.cells[1].id).toBeUndefined();
	});
});
