/**
 * The base harness's features (pure): one per extension folder, the entry
 * files pi loads for it, and whether a profile may turn it off
 * (working-docs/features/profiles/, working-docs/decisions/bi-fork.md).
 *
 * A feature is the unit a profile switches. Its entries are the files in
 * `package.json` `pi.extensions` and in `lib/agents/child-extensions.ts`; every entry
 * wraps its factory in `feature(id, …)` (`lib/profile/feature.ts`), which skips the
 * factory when the feature is off. `test/unit/features.test.ts` checks that
 * the registry, the manifest, the child list and the wrappers agree.
 *
 * `required` marks the safety core and the request pipeline: a profile that
 * turns one off fails at load. `guard` marks a feature that guards tool calls
 * (the user's hooks, the hooks installed plugins bring, read-before-edit): a
 * product's profile may turn it off, the off-only environment variable may not.
 */

export interface FeatureSpec {
	/** Entry files, relative to `extensions/`. */
	entries: readonly string[];
	/** Part of the safety core or the request pipeline; never off. */
	required?: true;
	/** Guards tool calls: only a profile, never the environment, turns it off. */
	guard?: true;
}

export const FEATURES = {
	branding: { entries: ["ui/branding/index.ts"] },
	"claude-compat": { entries: ["commands/claude-compat/index.ts"] },
	"kept-thinking": { entries: ["request/kept-thinking/index.ts"], required: true },
	ledger: { entries: ["request/ledger/index.ts", "request/ledger/wire.ts"], required: true },
	"context-budget": { entries: ["context/context-budget/index.ts"] },
	"system-reminder": { entries: ["request/system-reminder/index.ts"], required: true },
	"claude-context": { entries: ["context/claude-context/index.ts"] },
	"tool-call-corruption": { entries: ["request/tool-call-corruption/index.ts", "request/tool-call-corruption/child.ts"] },
	hooks: { entries: ["safety/hooks/index.ts"], guard: true },
	"tool-search": { entries: ["request/tool-search/index.ts"], required: true },
	"search-tools": { entries: ["tools/search-tools/index.ts"] },
	"tool-style": { entries: ["tools/tool-style/index.ts"] },
	// A guard: plugin discovery supplies the hooks of installed plugins (safety/hooks/plugin-hooks.ts).
	plugins: { entries: ["tools/plugins/index.ts"], guard: true },
	worktree: { entries: ["safety/worktree/index.ts"] },
	"file-tracker": { entries: ["safety/file-tracker/index.ts"], guard: true },
	memory: { entries: ["context/memory/index.ts"] },
	permissions: { entries: ["safety/permissions/index.ts"], required: true },
	"ask-user": { entries: ["tools/ask-user/index.ts"] },
	skill: { entries: ["tools/skill/index.ts"] },
	background: { entries: ["tools/background/index.ts"] },
	bash: { entries: ["tools/bash/index.ts", "tools/bash/child.ts"] },
	powershell: { entries: ["tools/powershell/index.ts", "tools/powershell/child.ts"] },
	subagents: { entries: ["agents/subagents/index.ts"] },
	workflow: { entries: ["agents/workflow/index.ts"] },
	effort: { entries: ["ui/effort/index.ts"] },
	spinner: { entries: ["ui/spinner/index.ts"] },
	"model-default": { entries: ["ui/model-default/index.ts"] },
	"newer-model": { entries: ["ui/newer-model/index.ts"] },
	footer: { entries: ["ui/footer/index.ts"] },
	"turn-duration": { entries: ["ui/turn-duration/index.ts"] },
	interrupted: { entries: ["ui/interrupted/index.ts"] },
	"send-now": { entries: ["ui/send-now/index.ts"] },
	recap: { entries: ["agents/recap/index.ts"] },
	btw: { entries: ["agents/btw/index.ts"] },
	"session-title": { entries: ["agents/session-title/index.ts"] },
	exit: { entries: ["commands/exit/index.ts"] },
	init: { entries: ["commands/init/index.ts"] },
	clear: { entries: ["commands/clear/index.ts"] },
	tasks: { entries: ["tools/tasks/index.ts"] },
	"plan-mode": { entries: ["safety/plan-mode/index.ts"] },
	notebook: { entries: ["tools/notebook/index.ts"] },
	artifacts: { entries: ["tools/artifacts/index.ts"] },
	web: { entries: ["tools/web/index.ts"] },
	"web-fetch": { entries: ["tools/web-fetch/index.ts"] },
	lsp: { entries: ["tools/lsp/index.ts"] },
	mcp: { entries: ["tools/mcp/index.ts"] },
	doctor: { entries: ["commands/doctor/index.ts"] },
	"context-management": { entries: ["request/context-management/index.ts"] },
	compaction: { entries: ["context/compaction/index.ts"] },
	"idle-compact": { entries: ["context/idle-compact/index.ts"] },
	"cache-marks": { entries: ["request/cache-marks/index.ts"], required: true },
	"system-prompt": { entries: ["request/system-prompt/index.ts"], required: true },
} as const satisfies Record<string, FeatureSpec>;

export type FeatureId = keyof typeof FEATURES;

/**
 * The manifest's last entry: a product's own main-session extensions, one
 * folder each under `profile/extensions/`. pi expands the glob in place,
 * sorted by path, and loads nothing when no folder matches. It comes after
 * `system-prompt`, so every base listener exists when a product extension
 * announces at load, and after the request pipeline, so a product extension
 * must not shape the request tail. These entries belong to no feature: the
 * product ships the ones it wants (working-docs/decisions/bi-fork.md).
 */
export const PRODUCT_EXTENSIONS_ENTRY = "profile/extensions/*/index.ts";

/** The folder, relative to the profile's, that holds every product extension, child entries included. */
export const PRODUCT_EXTENSIONS_DIR = "extensions";

export const FEATURE_IDS = Object.keys(FEATURES) as FeatureId[];

export function isFeatureId(value: string): value is FeatureId {
	return Object.hasOwn(FEATURES, value);
}

/** A feature that guards tool calls (see the header). */
export function isGuardFeature(id: string): boolean {
	return isFeatureId(id) && "guard" in FEATURES[id];
}

/**
 * The feature that registers each optional tool, so text that names another
 * tool can leave it out when that feature is off (`toolLive` in
 * lib/profile/profile.ts). pi's built-in tools (read, edit, write, …) belong to no
 * feature; only a tool switch turns them off. The golden sweep fails when a
 * request names a tool that is off (test/e2e/golden-requests.mjs --sweep).
 */
export const TOOL_FEATURES: Readonly<Record<string, FeatureId>> = {
	artifact: "artifacts",
	ask_user_question: "ask-user",
	bash: "bash",
	cron_create: "background",
	cron_delete: "background",
	cron_list: "background",
	monitor: "background",
	schedule_wakeup: "background",
	task_output: "background",
	task_stop: "background",
	lsp_diagnostics: "lsp",
	list_mcp_resources: "mcp",
	read_mcp_resource: "mcp",
	read_mcp_resource_dir: "mcp",
	notebook_edit: "notebook",
	enter_plan_mode: "plan-mode",
	exit_plan_mode: "plan-mode",
	powershell: "powershell",
	task_create: "tasks",
	task_get: "tasks",
	task_list: "tasks",
	task_update: "tasks",
	skill: "skill",
	Agent: "subagents",
	SendMessage: "subagents",
	list_agents: "subagents",
	web_fetch: "web-fetch",
	web_search: "web",
	workflow: "workflow",
	enter_worktree: "worktree",
	exit_worktree: "worktree",
};

/** The feature a bundled skill serves (its body drives that feature's tools); the skill is hidden when the feature is off. */
export const BUNDLED_SKILL_FEATURES: Readonly<Record<string, FeatureId>> = {
	"artifact-design": "artifacts",
	loop: "background",
	"workflow-authoring": "workflow",
};

/** The feature an entry file belongs to (`tools/bash/child.ts` → `bash`), or undefined. */
export function featureOfEntry(entry: string): FeatureId | undefined {
	return FEATURE_IDS.find((id) => (FEATURES[id].entries as readonly string[]).includes(entry));
}

/** The features on under a `features` map: every feature unless the map says false. */
export function enabledFeatures(features: Partial<Record<string, boolean>>): ReadonlySet<FeatureId> {
	return new Set(FEATURE_IDS.filter((id) => features[id] !== false));
}

/**
 * What is wrong with a `features` map, one sentence each: an unknown name, or
 * a required feature turned off. A profile that breaks the core must fail at
 * load, never run degraded.
 */
export function featureProblems(features: Partial<Record<string, boolean>>): string[] {
	const problems = Object.keys(features)
		.filter((id) => !isFeatureId(id))
		.map((id) => `unknown feature "${id}"`);
	for (const id of FEATURE_IDS) {
		if ("required" in FEATURES[id] && features[id] === false) problems.push(`"${id}" is part of the safety core or the request pipeline and cannot be turned off`);
	}
	return problems;
}
