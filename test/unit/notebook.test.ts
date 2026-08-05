import { describe, expect, it } from "vitest";
import { applyEdit, type Notebook, parseNotebook, toSourceLines } from "../../extensions/notebook/notebook.ts";

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
		expect(() => parseNotebook('{"foo":1}')).toThrow(/missing 'cells'/);
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
		const { notebook, summary } = applyEdit(nb(), { cellId: "bbb", newSource: "print(2)", editMode: "replace" }, ids);
		const cell = notebook.cells[1];
		expect(cell.source).toEqual(["print(2)"]);
		expect(cell.outputs).toEqual([]);
		expect(cell.execution_count).toBeNull();
		expect(summary).toContain("Replaced cell bbb");
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
	});

	it("inserts at the top when no cell_id is given", () => {
		const { notebook } = applyEdit(nb(), { newSource: "# intro", cellType: "markdown", editMode: "insert" }, ids);
		expect(notebook.cells.map((c) => c.id)).toEqual(["new1", "aaa", "bbb"]);
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
		expect(() => applyEdit(nb(), { editMode: "delete" }, ids)).toThrow(/cell_id is required/);
		expect(() => applyEdit(nb(), { cellId: "aaa", editMode: "replace" }, ids)).toThrow(/new_source is required/);
		expect(() => applyEdit(nb(), { newSource: "x", editMode: "insert" }, ids)).toThrow(/cell_type is required/);
		expect(() => applyEdit(nb(), { cellId: "zzz", newSource: "x", editMode: "replace" }, ids)).toThrow(/No cell with id/);
	});
});
