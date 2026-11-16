/**
 * A minimal product extension for the base's own tests: it uses the seams
 * `extensions/sdk/extension.ts` offers (a prompt section that cuts its
 * passage naming a tool by the tools the session can have, a reminder, a
 * deferred tool of its own, a secret value, a report of a file it wrote to
 * the profile's language server, a page in the product's state folder opened
 * in the browser, a notice when the session model sits below a tier, which
 * a setting the profile declares switches off, a block of project facts in
 * the first message's context) the way a product's extension would. The base
 * suite copies this profile into place, so the manifest's product entry loads
 * it there (`product-extension.test.ts`).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pathToFileURL } from "node:url";
import {
	DEFER_CHANNEL,
	type DeferRequest,
	lspFilesChanged,
	modelCapability,
	notifyOrPrint,
	openInBrowser,
	productSetting,
	publishContextBlock,
	productStateDir,
	queueNotice,
	REMINDER_CHANNEL,
	type ReminderPayload,
	setSecretValues,
	SYSTEM_PROMPT_SECTION_CHANNEL,
	type SystemPromptSection,
	tiersBelow,
	toolRenderers,
} from "../../../extensions/sdk/extension.ts";
import { type PromptTier, type ToolPassages, withoutOff } from "../../../extensions/sdk/profile.ts";

export const PROBE_TOOL = "fixture_probe";
export const PROBE_SECTION = "[fixture:product-section]";
/** The section's passage naming the probe's own tool, cut when the session cannot have it. */
export const PROBE_SECTION_TOOL = ` Call ${PROBE_TOOL} to probe.`;
/**
 * Keyed on `live`, never on the active `tools`: the probe's tool is deferred,
 * and a passage following the active list would change the prompt when it loads.
 */
const SECTION_PASSAGES: ToolPassages = { [PROBE_TOOL]: [PROBE_SECTION_TOOL] };
/** The section's passage on a fact the lsp feature adds (diagnostics after an edit), whether or not its tool is registered: keyed on the feature. */
export const PROBE_SECTION_DIAGNOSTICS = " Diagnostics follow each edit.";
export const PROBE_REMINDER = "[fixture:product-reminder]";
/** A value the probe registers as secret; a tool result that carries it shows `[secret:fixture]` instead. */
export const PROBE_SECRET = "fixture-secret-value";
/** The file the probe's tool writes in the session's directory, a file the fixture's language server serves. */
export const PROBE_FILE = "probe.fixturelang";
/** The capability the probe asks for: a session model below it, or one the base does not know, gets a notice. */
export const PROBE_TIER_FLOOR: PromptTier = "frontier";
export const PROBE_TIER_NOTICE = "[fixture:below-tier-floor]";
export const PROBE_UNKNOWN_MODEL_NOTICE = "[fixture:unknown-model]";
/** The setting the profile declares for the notice (`settings` in ../../index.ts): false keeps it quiet. */
export const PROBE_TIER_SETTING = "fixtureTierNotice";
/** The probe's own context block: project facts the model starts every epoch with. */
export const PROBE_CONTEXT_KEY = "fixture-layout";
export const PROBE_CONTEXT = "[fixture:project-layout]";
/** A command that writes a page into the product's state folder and opens it. */
export const PROBE_COMMAND = "fixture-page";

export default function probe(pi: ExtensionAPI) {
	/**
	 * The user's notice, at the session's start and at each switch of model;
	 * never in the request. Judged by the model's capability, not the prompt
	 * register (`sessionModelTier`), which a knob or Haiku's frontier forms move.
	 */
	const tierNotice = (ctx: ExtensionContext, model = ctx.model) => {
		const { tier, known } = modelCapability(model);
		if (known && tiersBelow(tier, PROBE_TIER_FLOOR) <= 0) return;
		// Read at each boundary: the user may have switched it off since the last one.
		if (productSetting(PROBE_TIER_SETTING, ctx.cwd) === false) return;
		const text = known ? PROBE_TIER_NOTICE : PROBE_UNKNOWN_MODEL_NOTICE;
		// Joined with the other startup and model-switch notices; stderr in print and JSON modes.
		if (ctx.hasUI) queueNotice(pi.events, ctx, "warning", text);
		else notifyOrPrint(ctx, text, "warning");
	};
	pi.on("session_start", (_event, ctx) => {
		// Published at the session's start; a product republishes only on a real change.
		publishContextBlock(pi, ctx, PROBE_CONTEXT_KEY, PROBE_CONTEXT);
		tierNotice(ctx);
	});
	pi.on("model_select", (event, ctx) => tierNotice(ctx, event.model));
	pi.registerTool({
		name: PROBE_TOOL,
		label: "Fixture probe",
		description: "[fixture:product-tool]",
		parameters: Type.Object({}),
		...toolRenderers("Fixture probe"),
		// A tool that writes a file reports it, so a running server drops its old
		// copy; the base's own edit tools need no report.
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			const path = join(ctx.cwd, PROBE_FILE);
			writeFileSync(path, "[fixture:probe-file]\n");
			await lspFilesChanged(pi.events, { server: "fixture", changes: [{ path, type: "created" }] });
			return { content: [{ type: "text", text: "[fixture:product-tool-result]" }], details: undefined };
		},
	});
	pi.registerCommand(PROBE_COMMAND, {
		description: "[fixture:product-command]",
		handler: async (_args, ctx) => {
			const dir = join(productStateDir(), "fixture-probe");
			mkdirSync(dir, { recursive: true });
			const page = join(dir, "page.html");
			writeFileSync(page, "<p>[fixture:probe-page]</p>\n");
			// No browser (an SSH session, no display): name the page so the user can open it.
			const failed = await openInBrowser(pathToFileURL(page).href);
			ctx.ui.notify(failed ? `[fixture:no-browser:${failed.reason}] ${page}` : "[fixture:page-opened]", failed ? "warning" : "info");
		},
	});
	pi.events.emit(DEFER_CHANNEL, { name: PROBE_TOOL } satisfies DeferRequest);
	pi.events.emit(SYSTEM_PROMPT_SECTION_CHANNEL, { id: "fixture-probe", place: "tail", render: ({ live, features }) => withoutOff(`${PROBE_SECTION}${PROBE_SECTION_TOOL}`, live, SECTION_PASSAGES) + (features.has("lsp") ? PROBE_SECTION_DIAGNOSTICS : "") } satisfies SystemPromptSection);
	setSecretValues("fixture-probe", [{ value: PROBE_SECRET, name: "fixture" }]);
	pi.on("session_start", () => {
		pi.events.emit(REMINDER_CHANNEL, { key: "fixture-probe", text: PROBE_REMINDER, placement: "last-append" } satisfies ReminderPayload);
	});
}
