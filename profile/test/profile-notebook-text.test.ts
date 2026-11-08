/**
 * One Code's notebook_edit wording (profile/text/notebook/): the hints a weak tier
 * needs, in the right places (review M4, code-review F3). The exact bytes of
 * every result are pinned by the golden snapshot.
 */
import { describe, expect, it } from "vitest";
import { notebook } from "../text/notebook/index.ts";

const cells = [
	{ label: "aaa", type: "markdown" },
	{ label: "bbb", type: "code" },
];

describe("One Code's notebook text", () => {
	it("names every edit the way the model addresses the cell next", () => {
		expect(notebook.edited({ outcome: { kind: "replaced", cell: "bbb" }, path: "a.ipynb", cellCount: 2 })).toBe("Replaced cell bbb in a.ipynb (2 cells).");
		expect(notebook.edited({ outcome: { kind: "inserted", cellType: "code", cell: "new1" }, path: "a.ipynb", cellCount: 3 })).toContain("Inserted code cell new1 at the top");
		expect(notebook.edited({ outcome: { kind: "appended", cellType: "code", cell: "cell-2" }, path: "a.ipynb", cellCount: 3 })).toContain("Appended code cell cell-2 at the end");
	});

	it("lists the cells for a missing cell_id, so a weak tier picks a real one", () => {
		expect(notebook.failed({ failure: { kind: "cellIdRequired", mode: "delete" }, cells })).toContain("this notebook's cells are: aaa (markdown), bbb (code)");
		expect(notebook.failed({ failure: { kind: "noSuchCell", cellId: "zzz" }, cells })).toContain('No cell with id "zzz". This notebook\'s cells are: aaa (markdown), bbb (code).');
		expect(notebook.failed({ failure: { kind: "noSuchCell", cellId: "zzz" }, cells: [] })).toContain("no cells");
	});

	it("does not list cells for a failure that is not about a cell", () => {
		expect(notebook.failed({ failure: { kind: "newSourceRequired" }, cells })).toBe("Notebook edit failed: new_source is required unless edit_mode is 'delete'");
		expect(notebook.failed({ failure: { kind: "cellTypeRequired", mode: "insert" }, cells })).not.toContain("cells are");
	});

	it("points at the fix for a missing file or bad JSON", () => {
		expect(notebook.failed({ failure: { kind: "fileNotFound", osMessage: "ENOENT" } })).toContain("no such file");
		expect(notebook.failed({ failure: { kind: "invalidJson", osMessage: "Unexpected token" } })).toContain("not valid notebook JSON");
	});
});
