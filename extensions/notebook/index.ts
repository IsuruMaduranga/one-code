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
import { applyEdit, type EditMode, type Notebook, notebookErrorHint, parseNotebook } from "./notebook.ts";

export default function notebookExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "notebook_edit",
		label: "Notebook Edit",
		...ccToolRenderers("Notebook Edit"),
		description:
			"Edit a Jupyter notebook (.ipynb): replace a cell's source, insert or append a new cell, or delete a cell. Read the notebook first — like the other file tools, this one refuses to edit a file you have not read. Cells are addressed by their `id` or, for a notebook whose cells have none, by position — `cell-0` is the first cell. Use edit_mode `append` to add a cell at the end without naming one. Editing a code cell clears its outputs.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Absolute or workspace-relative path to the .ipynb file" })),
			// Claude Code's NotebookEdit spells the path `notebook_path` and defaults
			// edit_mode to `replace`; a CC-trained model's `{notebook_path, cell_id,
			// new_source}` used to fail schema validation twice over
			// (TOOL-FIDELITY-REVIEW-2026-09-07 M2). Accept both.
			notebook_path: Type.Optional(Type.String({ description: "Alias of `path` (Claude Code's name for it)." })),
			edit_mode: Type.Optional(StringEnum(["replace", "insert", "append", "delete"] as const, { description: "The type of edit to make. Defaults to replace." })),
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
			const rawPath = params.path ?? params.notebook_path;
			if (!rawPath) {
				return {
					content: [{ type: "text", text: "`path` (or Claude Code's `notebook_path`) is required: the .ipynb file to edit." }],
					details: {},
					isError: true,
				};
			}
			const editMode = (params.edit_mode ?? "replace") as EditMode;
			const path = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);
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
						editMode,
					},
					() => randomUUID().slice(0, 8),
				);
				writeFileSync(path, `${JSON.stringify(updated, null, 1)}\n`);
				return {
					content: [{ type: "text", text: `${summary} in ${rawPath} (${updated.cells.length} cells).` }],
					details: { path, cellCount: updated.cells.length },
				};
			} catch (error) {
				const message = (error as Error).message;
				const hint = notebookErrorHint({
					code: (error as NodeJS.ErrnoException).code,
					syntax: error instanceof SyntaxError,
					message,
					parsed,
				});
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
