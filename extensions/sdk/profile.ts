/**
 * The one module a profile's own code imports from the base
 * (working-docs/decisions/bi-fork.md): the profile contract, the types of each
 * feature's words, and the few constants that text names. A source provider
 * imports `source-provider.ts` instead. Everything else in `extensions/` is
 * internal and may move between releases; a profile that imports only these
 * two files is unaffected (`profile-import-surface.test.ts`).
 *
 * Re-export only what a profile uses, by name. Every value re-exported here
 * loads with the profile's text, so re-export constants only from leaf
 * modules: the text's graph must reach neither a pi package nor the base's
 * own loaders (`shared-module-graph.test.ts`).
 */
export type { ArtifactsText } from "../tools/artifacts/text.ts";
export type { AskUserText } from "../tools/ask-user/text.ts";
export type { AutoModeSetupText, ClassifierRuleset, ClassifierText } from "../safety/permissions/auto-mode/text.ts";
export type { PermissionsText } from "../lib/rules/permission-text.ts";
export { AUTONOMOUS_LOOP, AUTONOMOUS_LOOP_DYNAMIC, LOOP_FILE_DYNAMIC_SENTINEL, LOOP_FILE_SENTINEL } from "../tools/background/loop-sentinels.ts";
export type { CronText } from "../lib/agents/cron-text.ts";
export type { BackgroundText, LoopFile, LoopText, LoopTick, MonitorText, TaskToolsText, WakeupText } from "../tools/background/text.ts";
export type { BtwText } from "../agents/btw/text.ts";
export type { CompactionReason, CompactionText, KeptTail, KeptTailLandmark } from "../context/compaction/text.ts";
export type { DoctorText, FixPromptInput } from "../commands/doctor/text.ts";
export type { EffortText } from "../ui/effort/text.ts";
export type { InitText } from "../commands/init/text.ts";
export type { ContextText } from "../lib/context/context-text.ts";
export type { HandbackText } from "../lib/agents/handback-text.ts";
export { type LiveTools, type ToolPassages, withoutOff } from "../lib/profile/live-tools.ts";
export type { PromptTier } from "../lib/models/model-tier.ts";
export type { NativeWebText } from "../lib/request/native-web-text.ts";
export type { NotificationsText } from "../lib/notify/notifications-text.ts";
export type { WorkflowSizeGuideline } from "../lib/profile/product-settings.ts";
export type { Profile, ProfileText } from "../lib/profile/profile-contract.ts";
export type { PowerShellEditionName, ShellText } from "../lib/shell-run/shell-text.ts";
export type { DescriptionForm } from "../lib/profile/tool-variants.ts";
export type { LspText } from "../tools/lsp/text.ts";
export type { McpText } from "../tools/mcp/text.ts";
export type { NotebookText } from "../tools/notebook/text.ts";
export type { PlanModeText } from "../safety/plan-mode/text.ts";
export type { RecapText } from "../agents/recap/text.ts";
export type { SessionTitleText } from "../agents/session-title/text.ts";
export type { SkillText } from "../tools/skill/text.ts";
export type { GuideInput, GuideInstall, GuideSetup } from "../agents/subagents/guide-agent.ts";
export type { SubagentModelsText } from "../lib/models/subagent-model-text.ts";
export type { SubagentsText } from "../agents/subagents/text.ts";
export type { SystemPromptText } from "../request/system-prompt/text.ts";
export type { TasksText } from "../tools/tasks/text.ts";
export type { ToolSearchText } from "../request/tool-search/text.ts";
export type { ToolStyleText } from "../tools/tool-style/text.ts";
export type { WebFetchText } from "../tools/web-fetch/text.ts";
export type { WebSearchText } from "../tools/web/text.ts";
export type { WorkflowText } from "../agents/workflow/text.ts";
export type { WorktreeText } from "../safety/worktree/text.ts";
export type { ProductProvider, ProviderVendor, WireFeature } from "../lib/profile/product-providers.ts";
export type { ReadOnlyCommands, ReadOnlySubcommand } from "../lib/shell/product-read-only.ts";
export type { ProductLanguageServer } from "../lib/profile/language-servers.ts";
