/**
 * tool-style extension — Claude Code's `● Tool(args)` / `⎿ result` transcript
 * language for pi's built-in file tools.
 *
 * Registering a tool under a built-in's name overrides it (findings §2, the
 * same mechanism the bash extension uses). Every model-facing field —
 * description, promptSnippet, promptGuidelines, parameters — is passed through
 * from pi's own definition byte-identical, so the system prompt and tool
 * schemas are unchanged, with one exception: write carries Claude Code's
 * description, short or long by the model's tier (write-description.ts,
 * lib/profile/tool-variants.ts), and is registered again when the form changes;
 * edit carries pi's plus the read rule. Both texts come from the profile
 * (text.ts).
 * Execution delegates to a per-cwd instance of pi's
 * real definition (they close over cwd, and enter_worktree moves the session
 * mid-run). Only the TUI renderers differ: a `●` call line, and the base
 * result component indented under a `⎿` elbow so upstream streaming,
 * truncation, and ctrl+o expansion behavior is preserved. Edit keeps its own
 * call component (the diff preview a permission prompt relies on) with just
 * the header line restyled. Write renders as Claude Code's Write
 * (write-render.ts): a preview of the content or the diff while it waits, then
 * "Wrote N lines" or "Added N lines, removed M lines"; to show an overwrite's
 * diff afterwards, its execution reads the old file first and records the diff
 * on the result's details, which never reach the model. A finished edit reads
 * the same way: its summary, then the diff moved from the call under it. Read
 * and the search tools show Claude Code's one-line summary ("Read 2 lines",
 * "Found 3 files"), and a failed file tool the harness can classify shows its
 * short line ("File must be read first"); ctrl+o shows the whole result
 * (lib/ui/result-summary-files.ts).
 *
 * grep/find/ls stay gated: registering them does not bypass the
 * search-tools extension, which reconciles the active-tool list on
 * session_start/model_select and keeps them only where the session has the
 * search tools (`searchToolsEnabled`, lib/models/model-tier.ts).
 */

import { feature } from "../../lib/profile/feature.ts";
import { requireText } from "../../lib/profile/profile.ts";
import { readFile, stat } from "node:fs/promises";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	generateDiffString,
} from "@earendil-works/pi-coding-agent";
import { perCwd } from "../../lib/core/per-cwd.ts";
import { type DescriptionForm, registerFormTool } from "../../lib/profile/tool-variants.ts";
import { resolveToolPath } from "../../lib/rules/tool-path.ts";
import { type CcWrapOptions, ccWrapBuiltinRenderers, type RejectedFileOp, textContent } from "../../lib/ui/tui-render.ts";
import {
	FILE_ERROR_CHANNEL,
	type FileErrorOp,
	type FileErrorQuery,
	fileErrorKindOf,
	fileErrorLine,
	lineNoun,
	PI_ABORTED_TEXT,
	readSummary,
	type SearchTool,
	searchCount,
	searchSummaryWords,
} from "../../lib/ui/result-summary-files.ts";
import type { ToolStyleText } from "./text.ts";
import { createWriteRenderers, updateSummary, WRITE_DIFF_MAX_BYTES, type WriteRenderDeps, writeDetails } from "./write-render.ts";

// The concrete definitions are each strongly typed to their own schema; this
// extension treats them uniformly, so the spec is deliberately loose. Every
// field is still passed through verbatim.
type BuiltinDefinition = ToolDefinition<any, any, any> & { name: string };

interface BuiltinSpec {
	label: string;
	create: (cwd: string) => BuiltinDefinition;
	title: (args: Record<string, unknown> | undefined) => string | undefined;
	keepBaseCall?: boolean;
	/** A file tool: a rejection without a reason reads "User rejected <op> to <path>". */
	rejectedAs?: RejectedFileOp;
	/** Write's own Claude Code renderers and result details. */
	write?: boolean;
	/** A description in place of pi's, by the session's description form; `base` is pi's own. */
	description?: (form: DescriptionForm, base: string) => string;
	/** The transcript's result rows: a summary line, and a short line for an error (lib/ui/result-summary-files.ts). */
	rows?: Pick<CcWrapOptions, "summary" | "errorLine">;
}

type Rows = NonNullable<BuiltinSpec["rows"]>;

/** `Found 3 files (ctrl+o to expand)`: a search's count, with the hint while there is something to expand. */
function searchRows(tool: SearchTool): Rows {
	return {
		summary: (result, _args, theme, hint) => {
			const count = searchCount(tool, result);
			const { verb, noun } = searchSummaryWords(tool, count);
			return `${verb} ${theme.bold(String(count))} ${noun}${count > 0 && hint ? theme.fg("dim", ` (${hint})`) : ""}`;
		},
	};
}

/**
 * A failed file tool's short line: classified by the file-tracker, through
 * the kind it put on an executed call's details, or by asking it about a
 * call it refused. An unclassified failure keeps its words. Each `op` is
 * also the name of pi's tool that performs it.
 */
function fileErrorRows(pi: ExtensionAPI, op: FileErrorOp): Rows["errorLine"] {
	return (result, args, cwd) => {
		const text = textContent(result);
		if (text === PI_ABORTED_TEXT) return { text, color: "error" };
		let kind = fileErrorKindOf(result.details);
		if (!kind) {
			const query: FileErrorQuery = { toolName: op, text, args, cwd: cwd ?? process.cwd() };
			pi.events.emit(FILE_ERROR_CHANNEL, query);
			kind = query.kind;
		}
		return fileErrorLine(op, kind);
	};
}

const asSpecCreate = (create: (cwd: string) => unknown): BuiltinSpec["create"] =>
	create as BuiltinSpec["create"];

function builtins(text: ToolStyleText, pi: ExtensionAPI): BuiltinSpec[] {
	return [
		{
			label: "Read",
			create: asSpecCreate(createReadToolDefinition),
			title: (a) => a?.path as string | undefined,
			rows: {
				summary: (result, args, theme) => {
					const read = readSummary(result, args as { limit?: unknown } | undefined);
					if (!read) return undefined;
					return read.kind === "image" ? "Read image" : `Read ${theme.bold(String(read.count))} ${lineNoun(read.count)}`;
				},
				errorLine: fileErrorRows(pi, "read"),
			},
		},
		{
			label: "Write",
			create: asSpecCreate(createWriteToolDefinition),
			title: (a) => a?.path as string | undefined,
			rejectedAs: "write",
			write: true,
			description: (form) => text.writeDescription(form),
			rows: { errorLine: fileErrorRows(pi, "write") },
		},
		{
			label: "Update",
			create: asSpecCreate(createEditToolDefinition),
			title: (a) => a?.path as string | undefined,
			keepBaseCall: true,
			rejectedAs: "update",
			description: (_form, base) => text.editDescription({ base }),
			rows: {
				// pi's edit result carries the display diff it showed; the summary counts its lines.
				summary: (result, _args, theme) => {
					const diff = (result.details as { diff?: unknown } | undefined)?.diff;
					return typeof diff === "string" ? updateSummary(theme, diff) : undefined;
				},
				errorLine: fileErrorRows(pi, "edit"),
			},
		},
		{ label: "Grep", create: asSpecCreate(createGrepToolDefinition), title: (a) => a?.pattern as string | undefined, rows: searchRows("grep") },
		{ label: "Find", create: asSpecCreate(createFindToolDefinition), title: (a) => a?.pattern as string | undefined, rows: searchRows("find") },
		{ label: "LS", create: asSpecCreate(createLsToolDefinition), title: (a) => (a?.path as string | undefined) ?? ".", rows: searchRows("ls") },
	];
}

/**
 * The file a write is about to replace, for its diff: undefined when there is
 * none, null when it is not a readable file or too big to diff.
 */
const readBefore: WriteRenderDeps["readBefore"] = async (raw, cwd) => {
	const path = resolveToolPath(raw, cwd);
	try {
		const info = await stat(path);
		if (!info.isFile() || info.size > WRITE_DIFF_MAX_BYTES) return null;
		return await readFile(path, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
	}
};

const writeDeps: WriteRenderDeps = { readBefore, diff: (before, after) => generateDiffString(before, after).diff };

function toolStyleExtension(pi: ExtensionAPI) {
	for (const spec of builtins(requireText("toolStyle"), pi)) {
		const base = spec.create(process.cwd());
		const forCwd = perCwd(spec.create);
		const renderers = ccWrapBuiltinRenderers(spec.label, base, { title: spec.title, keepBaseCall: spec.keepBaseCall, rejectedAs: spec.rejectedAs, ...spec.rows });

		const definition = {
			name: base.name,
			label: base.label,
			description: base.description,
			promptSnippet: base.promptSnippet,
			promptGuidelines: base.promptGuidelines,
			parameters: base.parameters,
			executionMode: base.executionMode,
			prepareArguments: base.prepareArguments,
			constrainedSampling: base.constrainedSampling,
			...(spec.write ? createWriteRenderers(writeDeps, renderers.renderResult) : renderers),
			async execute(toolCallId, params, signal, onUpdate, ctx: ExtensionToolContext) {
				const run = () => forCwd(ctx.cwd).execute(toolCallId, params as never, signal, onUpdate, ctx);
				if (!spec.write) return run();
				const { path, content } = params as { path?: unknown; content?: unknown };
				if (typeof path !== "string" || typeof content !== "string") return run();
				const before = await readBefore(path, ctx.cwd);
				const result = await run();
				return { ...result, details: writeDetails(before, content, writeDeps.diff) };
			},
		} as ToolDefinition;
		const describe = spec.description;
		if (!describe) {
			pi.registerTool(definition);
			continue;
		}
		registerFormTool(pi, definition, (form) => describe(form, base.description));
	}
}

export default feature("tool-style", toolStyleExtension);
