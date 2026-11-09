/**
 * The one module a profile's own code imports from the base
 * (working-docs/decisions/bi-fork.md): the profile contract, the types of each
 * feature's words, and the few constants that text names. A source provider
 * imports `source-provider.ts` instead. Everything else in `extensions/` is
 * internal and may move between releases; a profile that imports only these
 * two files is unaffected (`profile-import-surface.test.ts`).
 *
 * Re-export only what a profile uses, by name. Every value re-exported here
 * loads with the profile's text, so keep it to constants and keep it free of
 * pi value imports (`shared-module-graph.test.ts`).
 */
export type { ArtifactsText, NoBrowser, PublishBrowser, PublishProblem, ShownArtifact } from "../artifacts/text.ts";
export type { Answer, Question } from "../ask-user/questions.ts";
export type { AskUserText } from "../ask-user/text.ts";
export type { CheckoutProgram } from "../auto-mode/git-checkout-programs.ts";
export type { AutoModeSetupText, AutoModeText, ClassifierBlock, ClassifierRuleset, ClassifierText, FloorTarget } from "../auto-mode/text.ts";
export { AUTONOMOUS_LOOP, AUTONOMOUS_LOOP_DYNAMIC, LOOP_FILE_DYNAMIC_SENTINEL, LOOP_FILE_SENTINEL } from "../background/loop-fire.ts";
export type { BackgroundText, CronCreateFailure, CronText, LoopFile, LoopText, LoopTick, MonitorEnd, MonitorStartFailure, MonitorText, ShownJob, ShownTask, TaskToolsText, WakeupMissingField, WakeupText } from "../background/text.ts";
export type { BtwText } from "../btw/text.ts";
export type { CompactionReason, CompactionText, KeptTail, KeptTailLandmark } from "../compaction/text.ts";
export type { ContextBudgetText } from "../context-budget/text.ts";
export type { DoctorText, FixPromptInput } from "../doctor/text.ts";
export type { EffortText } from "../effort/text.ts";
export type { ChangeExcerpt, FileToolOutcome, FileTrackerText } from "../file-tracker/text.ts";
export type { HookBlock } from "../hooks/protocol.ts";
export type { HooksText } from "../hooks/text.ts";
export type { InitText } from "../init/text.ts";
export type { ContextChange, ContextText, InstructionSource, MemoryIndexCut, MemoryIndexSize } from "../lib/context-text.ts";
export type { HandbackText } from "../lib/handback-text.ts";
export type { LiveTools } from "../lib/live-tools.ts";
export type { PromptTier } from "../lib/model-tier.ts";
export type { NativeFallback, NativeWebText } from "../lib/native-web-text.ts";
export type { NotificationsText, OneShotWork, TaskSummary } from "../lib/notifications-text.ts";
export type { WorkflowSizeGuideline } from "../lib/product-settings.ts";
export type { Profile, ProfileText } from "../lib/profile-contract.ts";
export type { PowerShellEditionName, ShellBlock, ShellEnd, ShellText } from "../lib/shell-text.ts";
export type { ToolResultsText } from "../lib/tool-results-text.ts";
export type { DescriptionForm } from "../lib/tool-variants.ts";
export type { LspFailure, LspText, ShownDiagnostic } from "../lsp/text.ts";
export type { ImageProblem, McpFailure, McpStep, McpText, ServerInstructions, StderrTail } from "../mcp/text.ts";
export type { IndexLimits, MemoryText } from "../memory/text.ts";
export type { CellRef, EditOutcome, NotebookFailure, NotebookText } from "../notebook/text.ts";
export type { PermissionRefusal, PermissionsText } from "../permissions/text.ts";
export type { PlanModeText } from "../plan-mode/text.ts";
export type { PluginsText } from "../plugins/text.ts";
export type { RecapText } from "../recap/text.ts";
export type { SessionTitleText } from "../session-title/text.ts";
export type { SkillText } from "../skill/text.ts";
export type { GuideInput, GuideInstall, GuideSetup } from "../subagents/guide-agent.ts";
export type { SubagentModelSource } from "../subagents/model-select.ts";
export type { ChainSource, MenuLabel, SubagentModelNotice, SubagentModelsText } from "../subagents/model-text.ts";
export type { AgentTools, LaunchLine, PendingRun, RunFailure, RunStatus, SubagentRefusal, SubagentsText } from "../subagents/text.ts";
export type { SystemPromptText } from "../system-prompt/text.ts";
export type { TaskItem, TaskStatus } from "../tasks/store.ts";
export type { TaskView, TasksText, UpdateProblem } from "../tasks/text.ts";
export type { ArgumentDamage, ToolCallCorruptionText } from "../tool-call-corruption/text.ts";
export type { SearchOutcome, ToolSearchText } from "../tool-search/text.ts";
export type { ToolStyleText } from "../tool-style/text.ts";
export type { FetchAnswer, FetchFailure, ReaderFailure, UrlProblem, WebFetchText } from "../web-fetch/text.ts";
export { BRAVE_KEY_ENV, SETTINGS_FILE, SETTINGS_SNIPPET, TAVILY_KEY_ENV } from "../web/backends.ts";
export type { BackendAttempt, BackendFailure, ChainFailure, ProviderSearchFailure, WebSearchText } from "../web/text.ts";
export type { AgentFailure, AgentNotice, RunReport, RunStop, ScriptCallProblem, ScriptProblem, WorkflowRefusal, WorkflowText } from "../workflow/text.ts";
export type { EnterWorktreeFailure, GitTargetProblem, RemoveBlocker, StashRisk, WorktreeGuardRefusal, WorktreeGuardText, WorktreeNameProblem, WorktreeSessionView, WorktreeText } from "../worktree/text.ts";
