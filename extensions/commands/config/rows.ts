/**
 * /config's own rows (pure): the settings a user changes from the panel,
 * what each shows, and how a change rewrites One Code's user settings file
 * (`~/.onecode/settings.json`, lib/profile/product-settings.ts).
 *
 * A feature row writes `featuresOff`, which the profile reads once per
 * process (lib/profile/profile.ts `activeProfile`), so it applies at the next
 * start. The other rows are settings an extension reads at session start
 * (`suggestNewerModels`, `workflowSizeGuideline`); the workflow size words
 * the workflow tool's description, part of the request prefix, so it never
 * changes inside a session.
 */

import { envName } from "../../lib/profile/brand.mjs";
import type { FeatureId } from "../../lib/profile/features.ts";
import type { FeatureOffSource } from "../../lib/profile/profile.ts";
import { suggestNewerOf, WORKFLOW_SIZES, type WorkflowSizeGuideline, workflowSizeOf } from "../../lib/profile/product-settings.ts";
import { featuresOffOf } from "../../lib/profile/settings-file.ts";
import type { ConfigRow } from "../../lib/ui/config-rows.ts";

/** The optional features a user switches, in the panel's order. */
const FEATURE_ROWS: ReadonlyArray<{ id: FeatureId; label: string; description: string }> = [
	{ id: "recap", label: "Session recap", description: "Recap the session when you come back to it after a break." },
	{ id: "session-title", label: "Session titles", description: "Name each session from its first prompt." },
	{ id: "turn-duration", label: "Turn duration", description: "Show how long each turn took." },
	{ id: "footer", label: "Status line", description: "Show the status line under the prompt (off: pi's footer)." },
	{ id: "desktop-notify", label: "Desktop notifications", description: "Notify you when a prompt waits for you or a turn finishes while you are away." },
	{ id: "idle-compact", label: "Compact idle sessions", description: "Compact a session left idle before its prompt cache expires, so the next prompt costs less." },
];

const FEATURE_PREFIX = "feature:";
const SUGGEST_NEWER_ID = "suggestNewerModels";
const WORKFLOW_SIZE_ID = "workflowSizeGuideline";

const RESTART = "Applies the next time you start a session.";
const NEXT_SESSION = "Applies to the next session.";

/** What the panel reads: the settings file and why each feature is off for this run. */
export interface ConfigView {
	/** The settings file as read. */
	file: Record<string, unknown>;
	/** Why a feature is off in this run, by feature (the product profile, the environment, a user profile, this file). */
	offBy: ReadonlyMap<FeatureId, FeatureOffSource>;
	/** Whether the workflow tool exists in this run, so its size row means something. */
	workflows: boolean;
}

const onOff = (on: boolean) => (on ? "true" : "false");

/** The panel's rows. A feature the product turns off is not listed: nothing a user sets brings it back. */
export function configRows(view: ConfigView): ConfigRow[] {
	const off = new Set(featuresOffOf(view.file));
	const rows: ConfigRow[] = [];
	for (const row of FEATURE_ROWS) {
		const source = view.offBy.get(row.id);
		if (source === "product") continue;
		const elsewhere = source === "environment" ? ` It is off for this run: ${envName("FEATURES_OFF")} turns it off.` : source === "user profile" ? " It is off for this run: your launch profile turns it off." : "";
		rows.push({ id: `${FEATURE_PREFIX}${row.id}`, label: row.label, description: `${row.description} ${RESTART}${elsewhere}`, currentValue: onOff(!off.has(row.id)), values: ["true", "false"] });
	}
	rows.push({
		id: SUGGEST_NEWER_ID,
		label: "Suggest newer models",
		description: `Tell you when a newer or cheaper model of the same line is available. ${NEXT_SESSION}`,
		currentValue: onOff(suggestNewerOf(view.file)),
		values: ["true", "false"],
	});
	if (view.workflows) {
		rows.push({
			id: WORKFLOW_SIZE_ID,
			label: "Workflow size",
			description: `How many agents a workflow should start: small (under 5), medium (under 10), large (under 50) or unrestricted. ${NEXT_SESSION}`,
			currentValue: workflowSizeOf(view.file) ?? "medium",
			values: [...WORKFLOW_SIZES],
		});
	}
	return rows;
}

/** The settings file with one row's new value; undefined for a row this panel does not know. */
export function withSetting(file: Record<string, unknown>, id: string, value: string): Record<string, unknown> | undefined {
	if (id.startsWith(FEATURE_PREFIX)) {
		const feature = id.slice(FEATURE_PREFIX.length);
		if (!FEATURE_ROWS.some((row) => row.id === feature)) return undefined;
		const rest = featuresOffOf(file).filter((name) => name !== feature);
		const featuresOff = value === "false" ? [...rest, feature] : rest;
		const { featuresOff: _drop, ...others } = file;
		return featuresOff.length > 0 ? { ...others, featuresOff } : others;
	}
	if (id === SUGGEST_NEWER_ID) {
		const { suggestNewerModels: _drop, ...others } = file;
		return value === "false" ? { ...others, suggestNewerModels: false } : others;
	}
	if (id === WORKFLOW_SIZE_ID && WORKFLOW_SIZES.includes(value as WorkflowSizeGuideline)) return { ...file, workflowSizeGuideline: value };
	return undefined;
}
