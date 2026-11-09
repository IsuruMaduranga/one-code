/**
 * Violations of the layer rules that predate import-layers.test.ts. Fix one and
 * delete its line; never add one (put shared code in lib/ instead).
 */
export const IMPORT_LAYER_VIOLATIONS: readonly string[] = [
	"extensions/branding/compaction-keep.ts -> extensions/doctor/builtins.ts",
	"extensions/branding/replaced-builtins.ts -> extensions/doctor/builtins.ts",
	"extensions/btw/index.ts -> extensions/subagents/panel-render.ts",
	"extensions/compaction/index.ts -> extensions/context-management/index.ts",
	"extensions/lib/agents/agent-catalog.ts -> extensions/subagents/words.ts",
	"extensions/lib/agents/agent-worktree.ts -> extensions/subagents/words.ts",
	"extensions/lib/agents/subagent-gate.ts -> extensions/permissions/words.ts",
	"extensions/lib/agents/usage.ts -> extensions/subagents/words.ts",
	"extensions/lib/request/deferred.ts -> extensions/tool-search/words.ts",
	"extensions/lib/context/instruction-budget.ts -> extensions/footer/footer-line.ts",
	"extensions/lib/agents/permission-gate.ts -> extensions/permissions/words.ts",
	"extensions/lib/side-calls/replay-call.ts -> extensions/context-management/index.ts",
	"extensions/lib/rules/auto-mode-config.ts -> extensions/permissions/auto-mode/classifier-prompt.ts",
	"extensions/lib/rules/hook-protocol.ts -> extensions/hooks/executor.ts",
	"extensions/plan-mode/index.ts -> extensions/subagents/panel-render.ts",
];
