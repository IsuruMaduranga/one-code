/**
 * What a profile supplies to the base harness (types only). One Code's own
 * profile is `profile/index.ts` at the repo root; a product replaces that
 * folder with its own implementation of this contract
 * (working-docs/decisions/bi-fork.md, working-docs/features/profiles/).
 *
 * The contract grows phase by phase as text, brand and catalogs move out of
 * the base. Today it carries the feature and tool switches, the extra
 * extensions child sessions load, and the text groups moved so far.
 */

import type { ArtifactsText } from "../artifacts/text.ts";
import type { AskUserText } from "../ask-user/text.ts";
import type { AutoModeSetupText, AutoModeText, ClassifierText } from "../auto-mode/text.ts";
import type { BackgroundText } from "../background/text.ts";
import type { BtwText } from "../btw/text.ts";
import type { CompactionText } from "../compaction/text.ts";
import type { DoctorText } from "../doctor/text.ts";
import type { ContextBudgetText } from "../context-budget/text.ts";
import type { EffortText } from "../effort/text.ts";
import type { FileTrackerText } from "../file-tracker/text.ts";
import type { HooksText } from "../hooks/text.ts";
import type { InitText } from "../init/text.ts";
import type { LspText } from "../lsp/text.ts";
import type { McpText } from "../mcp/text.ts";
import type { MemoryText } from "../memory/text.ts";
import type { NotebookText } from "../notebook/text.ts";
import type { PermissionsText } from "../permissions/text.ts";
import type { PlanModeText } from "../plan-mode/text.ts";
import type { PluginsText } from "../plugins/text.ts";
import type { RecapText } from "../recap/text.ts";
import type { SessionTitleText } from "../session-title/text.ts";
import type { SkillText } from "../skill/text.ts";
import type { SubagentModelsText } from "../subagents/model-text.ts";
import type { SubagentsText } from "../subagents/text.ts";
import type { SystemPromptText } from "../system-prompt/text.ts";
import type { TasksText } from "../tasks/text.ts";
import type { ToolStyleText } from "../tool-style/text.ts";
import type { ToolSearchText } from "../tool-search/text.ts";
import type { WebFetchText } from "../web-fetch/text.ts";
import type { WorkflowText } from "../workflow/text.ts";
import type { WebSearchText } from "../web/text.ts";
import type { WorktreeGuardText, WorktreeText } from "../worktree/text.ts";
import type { HandbackText } from "./handback-text.ts";
import type { NativeWebText } from "./native-web-text.ts";
import type { NotificationsText } from "./notifications-text.ts";
import type { ContextText } from "./context-text.ts";
import type { ToolResultsText } from "./tool-results-text.ts";
import type { ToolCallCorruptionText } from "../tool-call-corruption/text.ts";
import type { ShellText } from "./shell-text.ts";
import type { FeatureId } from "./features.ts";
import type { LiveTools } from "./live-tools.ts";

/**
 * Every text the base shows the model, one group per feature that owns it.
 * A group of an optional feature may be left out when the profile turns that
 * feature off (lib/profile.ts requireText).
 */
export interface ProfileText {
	systemPrompt: SystemPromptText;
	notebook?: NotebookText;
	askUser?: AskUserText;
	tasks?: TasksText;
	worktree?: WorktreeText;
	webFetch?: WebFetchText;
	webSearch?: WebSearchText;
	/** Used by web_search and web_fetch (Anthropic's server-side tools). */
	nativeWeb?: NativeWebText;
	sessionTitle?: SessionTitleText;
	init?: InitText;
	btw?: BtwText;
	recap?: RecapText;
	effort?: EffortText;
	planMode?: PlanModeText;
	skill?: SkillText;
	mcp?: McpText;
	lsp?: LspText;
	hooks?: HooksText;
	memory?: MemoryText;
	/** Also read by subagents, for a child's cron tools. */
	background?: BackgroundText;
	artifacts?: ArtifactsText;
	toolStyle?: ToolStyleText;
	/** Also read by the system prompt, for its last line. */
	contextBudget?: ContextBudgetText;
	fileTracker?: FileTrackerText;
	compaction?: CompactionText;
	workflow?: WorkflowText;
	/** Read by the permission gate, which always runs: a profile must supply it. */
	autoMode?: AutoModeText;
	/** The auto-mode classifier's prompt (One Code's: Claude Code's ruleset, generated). */
	classifier?: ClassifierText;
	/** The `/auto-mode setup` drafting call. */
	autoModeSetup?: AutoModeSetupText;
	/** Used by bash and powershell (lib/shell-tool.ts). */
	shell?: ShellText;
	doctor?: DoctorText;
	/** The shared notification frames (lib/notifications.ts): every session uses them, so a profile must supply them. */
	notifications?: NotificationsText;
	/** The base's shared result rewrites (empty results, persisted output, a user's denial): a profile must supply them. */
	toolResults?: ToolResultsText;
	toolCallCorruption?: ToolCallCorruptionText;
	/** The first-message context (instructions, context block, date, environment, git status): every session sends it, so a profile must supply it. */
	context?: ContextText;
	/** tool-search is part of the required core: a profile must supply it. */
	toolSearch?: ToolSearchText;
	/** The permission gate always runs: a profile must supply it. */
	permissions?: PermissionsText;
	/** Every child session (subagents, forks, workflow agents) hands back through it. */
	handback?: HandbackText;
	subagents?: SubagentsText;
	/** A plugin command body's placeholders. */
	plugins?: PluginsText;
	/** Used by subagents and workflow agents (the model menu, the notices, the expensive-model gate). */
	subagentModels?: SubagentModelsText;
	/** Used by the worktree tools, subagents and workflows (each guards isolated sessions with it). */
	worktreeGuard?: WorktreeGuardText;
}

/** A profile's switches for one tool, by its registered name. Omitted fields keep the base's choice. */
export interface ToolSwitch {
	/**
	 * false: the tool is never registered, never active, and a call to it is
	 * denied. The harness's plumbing (`PINNED_TOOLS` in lib/profile.ts) can't be
	 * turned off or deferred.
	 */
	enabled?: boolean;
	/** true: behind `tool_search`; false: in the tool list from the first request. Fixed at load. */
	deferred?: boolean;
	/**
	 * true: runs without a permission prompt, like `tool_search` and `skill`.
	 * Plan mode still holds such a tool to its read-only rules.
	 */
	autoAllow?: boolean;
}

export interface Profile {
	/** Features to turn off (`false`); a feature left out stays on. */
	features: Partial<Record<FeatureId, boolean>>;
	/** Per-tool switches, keyed by tool name. */
	tools: Readonly<Record<string, ToolSwitch>>;
	/**
	 * Extension entry files, relative to the profile folder, that in-process
	 * child sessions (subagents, workflow agents) load after the base's own
	 * child extensions. The main session loads a product's extensions from the
	 * product's own package, after the base's. Either way they load after the
	 * request pipeline (`ledger/wire`, cache-marks), so a product extension
	 * must not shape the request tail in a `context` or payload hook; it adds
	 * tools, commands, reminders and prompt sections.
	 */
	childExtensions: readonly string[];
	/**
	 * The model-facing text, by owning feature, built once when the profile
	 * resolves. `live` answers which tools the session can have (the features
	 * and tool switches after the environment's off-switches), so text that
	 * names another tool, results and refusals included, leaves out what is off.
	 */
	text(env: TextEnv): ProfileText;
	/**
	 * The module, relative to the profile folder, whose `sources` export is the
	 * product's source provider (lib/sources.ts): where it reads beyond the
	 * base's own locations, such as another tool's instruction files. Loaded
	 * on first use, once per process. Absent: the base's locations only.
	 */
	sources?: string;
	/**
	 * The user's global AGENTS.md files the base reads besides pi's own
	 * `<agent dir>/AGENTS.md`, in order; `~/` is the home directory.
	 */
	globalAgentsFiles?: readonly string[];
}

/** What the profile's text is built for. */
export interface TextEnv {
	live: LiveTools;
}
