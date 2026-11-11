/**
 * Violations of the layer rules that predate import-layers.test.ts. Fix one and
 * delete its line; never add one (put shared code in lib/ instead).
 */
export const IMPORT_LAYER_VIOLATIONS: readonly string[] = [
	"extensions/ui/branding/compaction-keep.ts -> extensions/commands/doctor/builtins.ts",
	"extensions/ui/branding/replaced-builtins.ts -> extensions/commands/doctor/builtins.ts",
	"extensions/agents/btw/index.ts -> extensions/agents/subagents/panel-render.ts",
	"extensions/context/compaction/index.ts -> extensions/request/context-management/index.ts",
	"extensions/lib/context/instruction-budget.ts -> extensions/ui/footer/footer-line.ts",
	"extensions/lib/side-calls/replay-call.ts -> extensions/request/context-management/index.ts",
	"extensions/lib/rules/auto-mode-config.ts -> extensions/safety/permissions/auto-mode/classifier-prompt.ts",
	"extensions/lib/rules/hook-protocol.ts -> extensions/safety/hooks/executor.ts",
	"extensions/safety/plan-mode/index.ts -> extensions/agents/subagents/panel-render.ts",
];
