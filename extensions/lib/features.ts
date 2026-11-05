/**
 * The base harness's features (pure): one per extension folder, the entry
 * files pi loads for it, and whether a profile may turn it off
 * (working-docs/features/profiles/, working-docs/decisions/bi-fork.md).
 *
 * A feature is the unit a profile switches. Its entries are the files in
 * `package.json` `pi.extensions` and in `lib/child-extensions.ts`; every entry
 * wraps its factory in `feature(id, …)` (`lib/feature.ts`), which skips the
 * factory when the feature is off. `test/unit/features.test.ts` checks that
 * the registry, the manifest, the child list and the wrappers agree.
 *
 * `required` marks the safety core and the request pipeline: a profile that
 * turns one off fails at load. `dependsOn` names features that must stay on
 * while this one is on.
 */

export interface FeatureSpec {
	/** Entry files, relative to `extensions/`. */
	entries: readonly string[];
	/** Part of the safety core or the request pipeline; never off. */
	required?: true;
	/** Features this one needs on. */
	dependsOn?: readonly FeatureId[];
}

export const FEATURES = {
	branding: { entries: ["branding/index.ts"] },
	"claude-compat": { entries: ["claude-compat/index.ts"] },
	"kept-thinking": { entries: ["kept-thinking/index.ts"], required: true },
	ledger: { entries: ["ledger/index.ts", "ledger/wire.ts"], required: true },
	"context-budget": { entries: ["context-budget/index.ts"] },
	"system-reminder": { entries: ["system-reminder/index.ts"], required: true },
	"claude-context": { entries: ["claude-context/index.ts"] },
	"tool-call-corruption": { entries: ["tool-call-corruption/index.ts", "tool-call-corruption/child.ts"] },
	hooks: { entries: ["hooks/index.ts"] },
	"tool-search": { entries: ["tool-search/index.ts"], required: true },
	"search-tools": { entries: ["search-tools/index.ts"] },
	"tool-style": { entries: ["tool-style/index.ts"] },
	plugins: { entries: ["plugins/index.ts"] },
	worktree: { entries: ["worktree/index.ts"] },
	"file-tracker": { entries: ["file-tracker/index.ts"] },
	memory: { entries: ["memory/index.ts"] },
	permissions: { entries: ["permissions/index.ts"], required: true },
	"ask-user": { entries: ["ask-user/index.ts"] },
	skill: { entries: ["skill/index.ts"] },
	background: { entries: ["background/index.ts"] },
	bash: { entries: ["bash/index.ts", "bash/child.ts"] },
	powershell: { entries: ["powershell/index.ts", "powershell/child.ts"] },
	subagents: { entries: ["subagents/index.ts"] },
	workflow: { entries: ["workflow/index.ts"] },
	effort: { entries: ["effort/index.ts"] },
	spinner: { entries: ["spinner/index.ts"] },
	"model-default": { entries: ["model-default/index.ts"] },
	"newer-model": { entries: ["newer-model/index.ts"] },
	footer: { entries: ["footer/index.ts"] },
	"turn-duration": { entries: ["turn-duration/index.ts"] },
	interrupted: { entries: ["interrupted/index.ts"] },
	"send-now": { entries: ["send-now/index.ts"] },
	recap: { entries: ["recap/index.ts"] },
	btw: { entries: ["btw/index.ts"] },
	"session-title": { entries: ["session-title/index.ts"] },
	exit: { entries: ["exit/index.ts"] },
	init: { entries: ["init/index.ts"] },
	clear: { entries: ["clear/index.ts"] },
	tasks: { entries: ["tasks/index.ts"] },
	"plan-mode": { entries: ["plan-mode/index.ts"] },
	notebook: { entries: ["notebook/index.ts"] },
	artifacts: { entries: ["artifacts/index.ts"] },
	web: { entries: ["web/index.ts"] },
	"web-fetch": { entries: ["web-fetch/index.ts"] },
	lsp: { entries: ["lsp/index.ts"] },
	mcp: { entries: ["mcp/index.ts"] },
	doctor: { entries: ["doctor/index.ts"] },
	"context-management": { entries: ["context-management/index.ts"] },
	compaction: { entries: ["compaction/index.ts"] },
	"idle-compact": { entries: ["idle-compact/index.ts"] },
	"cache-marks": { entries: ["cache-marks/index.ts"], required: true },
	"system-prompt": { entries: ["system-prompt/index.ts"], required: true },
} as const satisfies Record<string, FeatureSpec>;

export type FeatureId = keyof typeof FEATURES;

export const FEATURE_IDS = Object.keys(FEATURES) as FeatureId[];

export function isFeatureId(value: string): value is FeatureId {
	return Object.hasOwn(FEATURES, value);
}

/** The feature an entry file belongs to (`bash/child.ts` → `bash`), or undefined. */
export function featureOfEntry(entry: string): FeatureId | undefined {
	return FEATURE_IDS.find((id) => (FEATURES[id].entries as readonly string[]).includes(entry));
}

/**
 * Which features are on, given a profile's `features` map and the ids the
 * environment turns off: every feature is on unless one of the two says off.
 * Throws when a required feature would be off or an enabled feature's
 * dependency would be off, naming each: a profile that breaks the core must
 * fail at load, never run degraded.
 */
export function resolveFeatures(profileFeatures: Partial<Record<string, boolean>>, envOff: readonly string[] = []): ReadonlySet<FeatureId> {
	const problems: string[] = [];
	for (const id of Object.keys(profileFeatures)) {
		if (!isFeatureId(id)) problems.push(`the profile names an unknown feature "${id}"`);
	}
	for (const id of envOff) {
		if (!isFeatureId(id)) problems.push(`ONECODE_FEATURES_OFF names an unknown feature "${id}"`);
	}
	const on = new Set<FeatureId>(FEATURE_IDS.filter((id) => profileFeatures[id] !== false && !envOff.includes(id)));
	for (const id of FEATURE_IDS) {
		const spec: FeatureSpec = FEATURES[id];
		if (spec.required && !on.has(id)) problems.push(`"${id}" is part of the safety core or the request pipeline and cannot be turned off`);
		if (!on.has(id)) continue;
		for (const dep of spec.dependsOn ?? []) {
			if (!on.has(dep)) problems.push(`"${id}" needs "${dep}", which is off`);
		}
	}
	if (problems.length > 0) throw new Error(`Invalid profile features: ${problems.join("; ")}.`);
	return on;
}
