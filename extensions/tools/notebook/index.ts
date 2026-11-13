/**
 * notebook extension — Claude Code's NotebookEdit (its words: the profile's `text.notebook`, contract in text.ts), deferred behind tool_search
 * (most sessions never touch a notebook, so its schema stays out of the prompt
 * until needed).
 */

import { sessionView } from "../../lib/agents/child-extensions.ts";
import { feature } from "../../lib/profile/feature.ts";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { StringEnum } from "../../lib/core/string-enum.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../../lib/request/deferred.ts";
import { toolRenderers } from "../../lib/ui/tui-render.ts";
import { applyEdit, cellRefs, type EditMode, type Notebook, notebookFailure, parseNotebook } from "./notebook.ts";
import { resolveToolPath } from "../../lib/rules/tool-path.ts";
import { notebookResultText } from "./text.ts";

function notebookExtension(pi: ExtensionAPI) {
	const view = sessionView(pi);
	const text = view.text("notebook");
	pi.registerTool({
		name: "notebook_edit",
		label: "Notebook Edit",
		...toolRenderers("Notebook Edit"),
		description: text.description,
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: text.params.path })),
			// Claude Code's NotebookEdit spells the path `notebook_path` and defaults
			// edit_mode to `replace`; a CC-trained model's `{notebook_path, cell_id,
			// new_source}` used to fail schema validation twice over
			// (TOOL-FIDELITY-REVIEW-2026-09-07 M2). Accept both.
			notebook_path: Type.Optional(Type.String({ description: text.params.notebook_path })),
			edit_mode: Type.Optional(StringEnum(["replace", "insert", "append", "delete"] as const, { description: text.params.edit_mode })),
			cell_id: Type.Optional(Type.String({ description: text.params.cell_id })),
			new_source: Type.Optional(Type.String({ description: text.params.new_source })),
			cell_type: Type.Optional(StringEnum(["code", "markdown"] as const, { description: text.params.cell_type })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const rawPath = params.path ?? params.notebook_path;
			if (!rawPath) {
				return {
					content: [{ type: "text", text: notebookResultText(view.live).failed({ failure: { kind: "missingPath" } }) }],
					details: {},
					isError: true,
				};
			}
			const editMode = (params.edit_mode ?? "replace") as EditMode;
			// The file tracker guards this path with the same resolution (lib/rules/tool-path.ts).
			const path = resolveToolPath(rawPath, ctx.cwd);
			// Held outside the try so a failure raised AFTER the parse can name the
			// ids the notebook actually has — a bare "cell_id is required" left both
			// weak tiers patching ids in by hand with bash (review M4).
			let parsed: Notebook | undefined;
			try {
				const notebook = (parsed = parseNotebook(readFileSync(path, "utf-8")));
				const { notebook: updated, outcome } = applyEdit(
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
					content: [{ type: "text", text: notebookResultText(view.live).edited({ outcome, path: rawPath, cellCount: updated.cells.length }) }],
					details: { path, cellCount: updated.cells.length },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: notebookResultText(view.live).failed({ failure: notebookFailure(error), ...(parsed ? { cells: cellRefs(parsed) } : {}) }) }],
					details: {},
					isError: true,
				};
			}
		},
	});

	pi.events.emit(DEFER_CHANNEL, { name: "notebook_edit", keywords: text.searchKeywords });
}

export default feature("notebook", notebookExtension);
