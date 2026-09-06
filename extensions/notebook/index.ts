/**
 * notebook extension — Claude Code's NotebookEdit, deferred behind tool_search
 * (most sessions never touch a notebook, so its schema stays out of the prompt
 * until needed).
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";
import { applyEdit, describeCells, type EditMode, type Notebook, parseNotebook } from "./notebook.ts";

export default function notebookExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "notebook_edit",
		label: "Notebook Edit",
		...ccToolRenderers("Notebook Edit"),
		description:
			"Edit a Jupyter notebook (.ipynb): replace a cell's source, insert or append a new cell, or delete a cell. Read the notebook first — like the other file tools, this one refuses to edit a file you have not read. Cells are addressed by their `id` or, for a notebook whose cells have none, by position — `cell-0` is the first cell. Use edit_mode `append` to add a cell at the end without naming one. Editing a code cell clears its outputs.",
		parameters: Type.Object({
			path: Type.String({ description: "Absolute or workspace-relative path to the .ipynb file" }),
			edit_mode: StringEnum(["replace", "insert", "append", "delete"] as const),
			cell_id: Type.Optional(
				Type.String({
					description:
						"Target cell id, either the cell's own id or its position as `cell-0`, `cell-1`, … Required for replace and delete; for insert the new cell goes after it (omit to insert at the top); ignored for append.",
				}),
			),
			new_source: Type.Optional(Type.String({ description: "New cell source. Required unless deleting." })),
			cell_type: Type.Optional(
				StringEnum(["code", "markdown"] as const, {
					description: "Cell type. Required when inserting or appending; when replacing, changes the cell's type.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const path = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path);
			// Held outside the try so a failure raised AFTER the parse can name the
			// ids the notebook actually has — a bare "cell_id is required" left both
			// weak tiers patching ids in by hand with bash (review M4).
			let parsed: Notebook | undefined;
			try {
				const notebook = (parsed = parseNotebook(readFileSync(path, "utf-8")));
				const { notebook: updated, summary } = applyEdit(
					notebook,
					{
						cellId: params.cell_id,
						newSource: params.new_source,
						cellType: params.cell_type as "code" | "markdown" | undefined,
						editMode: params.edit_mode as EditMode,
					},
					() => randomUUID().slice(0, 8),
				);
				writeFileSync(path, `${JSON.stringify(updated, null, 1)}\n`);
				return {
					content: [{ type: "text", text: `${summary} in ${params.path} (${updated.cells.length} cells).` }],
					details: { path, cellCount: updated.cells.length },
				};
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				const message = (error as Error).message;
				const hint =
					code === "ENOENT"
						? " — no such file; check the path points to an existing .ipynb"
						: error instanceof SyntaxError
							? " — the file is not valid notebook JSON"
							: parsed && !message.includes("cells are:")
								? ` — this notebook's cells are: ${describeCells(parsed)}. Address a cell by its own id or by position (cell-0 is the first); edit_mode "append" adds one at the end.`
								: "";
				return {
					content: [{ type: "text", text: `Notebook edit failed: ${message}${hint}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	pi.events.emit(DEFER_CHANNEL, { name: "notebook_edit", keywords: ["notebook", "jupyter", "ipynb", "cell"] });
}
