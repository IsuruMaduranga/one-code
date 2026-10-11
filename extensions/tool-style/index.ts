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
 * lib/tool-variants.ts), and is registered again when the form changes.
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
 * on the result's details, which never reach the model.
 *
 * grep/find/ls stay tier-gated: registering them does not bypass the
 * search-tools extension, which reconciles the active-tool list on
 * session_start/model_select and removes them for frontier models.
 */

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
import { perCwd } from "../lib/per-cwd.ts";
import { type DescriptionForm, registerFormTool } from "../lib/tool-variants.ts";
import { resolveToolPath } from "../lib/tool-path.ts";
import { ccWrapBuiltinRenderers, type RejectedFileOp } from "../lib/tui-render.ts";
import { editDescription, writeDescription } from "./write-description.ts";
import { createWriteRenderers, WRITE_DIFF_MAX_BYTES, type WriteRenderDeps, writeDetails } from "./write-render.ts";

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
}

const asSpecCreate = (create: (cwd: string) => unknown): BuiltinSpec["create"] =>
	create as BuiltinSpec["create"];

const BUILTINS: BuiltinSpec[] = [
	{ label: "Read", create: asSpecCreate(createReadToolDefinition), title: (a) => a?.path as string | undefined },
	{
		label: "Write",
		create: asSpecCreate(createWriteToolDefinition),
		title: (a) => a?.path as string | undefined,
		rejectedAs: "write",
		write: true,
		description: writeDescription,
	},
	{
		label: "Update",
		create: asSpecCreate(createEditToolDefinition),
		title: (a) => a?.path as string | undefined,
		keepBaseCall: true,
		rejectedAs: "update",
		description: (_form, base) => editDescription(base),
	},
	{ label: "Grep", create: asSpecCreate(createGrepToolDefinition), title: (a) => a?.pattern as string | undefined },
	{ label: "Find", create: asSpecCreate(createFindToolDefinition), title: (a) => a?.pattern as string | undefined },
	{ label: "LS", create: asSpecCreate(createLsToolDefinition), title: (a) => (a?.path as string | undefined) ?? "." },
];

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

export default function toolStyleExtension(pi: ExtensionAPI) {
	for (const spec of BUILTINS) {
		const base = spec.create(process.cwd());
		const forCwd = perCwd(spec.create);
		const renderers = ccWrapBuiltinRenderers(spec.label, base, { title: spec.title, keepBaseCall: spec.keepBaseCall, rejectedAs: spec.rejectedAs });

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
