/**
 * What the notebook tool needs from a profile (types only). The base decides
 * what happened; the profile words it (working-docs/features/profiles/).
 */

/** A cell as the model addresses it: its own id, else its position (`cell-0`). */
export interface CellRef {
	label: string;
	type: string;
}

/** What an edit did, with the cells named the way the model must address them next. */
export type EditOutcome =
	| { kind: "replaced"; cell: string }
	| { kind: "deleted"; cell: string }
	| { kind: "appended"; cellType: "code" | "markdown"; cell: string }
	| { kind: "inserted"; cellType: "code" | "markdown"; cell: string; after?: string };

/** Why an edit failed. `osMessage` is the system's or the parser's own text, passed through. */
export type NotebookFailure =
	| { kind: "missingPath" }
	| { kind: "notANotebook" }
	| { kind: "cellIdRequired"; mode: "replace" | "delete" }
	| { kind: "newSourceRequired" }
	| { kind: "cellTypeRequired"; mode: "insert" | "append" }
	| { kind: "noSuchCell"; cellId: string }
	| { kind: "fileNotFound"; osMessage: string }
	| { kind: "invalidJson"; osMessage: string }
	| { kind: "other"; osMessage: string };

export interface NotebookText {
	description: string;
	/** Search terms for `tool_search`, beyond the tool's name and description. */
	searchKeywords: string[];
	params: Record<"path" | "notebook_path" | "edit_mode" | "cell_id" | "new_source" | "cell_type", string>;
	edited(p: { outcome: EditOutcome; path: string; cellCount: number }): string;
	/** `cells`: the notebook's cells, when it was read before the failure. */
	failed(p: { failure: NotebookFailure; cells?: readonly CellRef[] }): string;
}
