/**
 * What a profile supplies to the base harness (types only). One Code's own
 * profile is `profile/index.ts` at the repo root; a product replaces that
 * folder with its own implementation of this contract
 * (working-docs/decisions/bi-fork.md, working-docs/features/profiles/).
 *
 * It carries the feature and tool switches, the extra extensions child
 * sessions load, the text groups, and the source provider's module. The
 * brand is `brand.json` beside it (lib/profile/brand.mjs) and the catalogs
 * are folders (agents/, skills/, themes/).
 */

import type { ProductLanguageServer } from "./language-servers.ts";
import type { ReadOnlyCommands } from "../shell/product-read-only.ts";
import type { ProductProvider } from "./product-providers.ts";
import type { ArtifactsText } from "../../tools/artifacts/text.ts";
import type { AskUserText } from "../../tools/ask-user/text.ts";
import type { AutoModeSetupText, ClassifierText } from "../../safety/permissions/auto-mode/text.ts";
import type { PermissionsText } from "../rules/permission-text.ts";
import type { BackgroundText } from "../../tools/background/text.ts";
import type { BtwText } from "../../agents/btw/text.ts";
import type { CompactionText } from "../../context/compaction/text.ts";
import type { DoctorText } from "../../commands/doctor/text.ts";
import type { EffortText } from "../../ui/effort/text.ts";
import type { InitText } from "../../commands/init/text.ts";
import type { LspText } from "../../tools/lsp/text.ts";
import type { McpText } from "../../tools/mcp/text.ts";
import type { NotebookText } from "../../tools/notebook/text.ts";
import type { PlanModeText } from "../../safety/plan-mode/text.ts";
import type { RecapText } from "../../agents/recap/text.ts";
import type { SessionTitleText } from "../../agents/session-title/text.ts";
import type { SkillText } from "../../tools/skill/text.ts";
import type { SubagentModelsText } from "../models/subagent-model-text.ts";
import type { SubagentsText } from "../../agents/subagents/text.ts";
import type { SystemPromptText } from "../../request/system-prompt/text.ts";
import type { TasksText } from "../../tools/tasks/text.ts";
import type { ToolStyleText } from "../../tools/tool-style/text.ts";
import type { ToolSearchText } from "../../request/tool-search/text.ts";
import type { WebFetchText } from "../../tools/web-fetch/text.ts";
import type { WorkflowText } from "../../agents/workflow/text.ts";
import type { WebSearchText } from "../../tools/web/text.ts";
import type { WorktreeText } from "../../safety/worktree/text.ts";
import type { HandbackText } from "../agents/handback-text.ts";
import type { NativeWebText } from "../request/native-web-text.ts";
import type { NotificationsText } from "../notify/notifications-text.ts";
import type { ContextText } from "../context/context-text.ts";
import type { ShellText } from "../shell-run/shell-text.ts";
import type { FeatureId } from "./features.ts";
import type { LiveTools } from "./live-tools.ts";

/**
 * Every text the base shows the model, one group per feature that owns it.
 * An optional group may be left out when every feature that reads it is off
 * (lib/profile/profile.ts TEXT_GROUP_READERS, checked when the profile resolves).
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
	/** Also read by subagents, for a child's cron tools. */
	background?: BackgroundText;
	artifacts?: ArtifactsText;
	toolStyle?: ToolStyleText;
	compaction?: CompactionText;
	workflow?: WorkflowText;
	/** The profile's part of what the permission gate says, in every mode; the gate always runs, so a profile must supply it. */
	permissions: PermissionsText;
	/** The auto-mode classifier's prompt (One Code's: Claude Code's ruleset, generated): the permission gate always runs, so a profile must supply it. */
	classifier: ClassifierText;
	/** The `/auto-mode setup` drafting call, part of the permission gate: a profile must supply it. */
	autoModeSetup: AutoModeSetupText;
	/** Used by bash and powershell (lib/shell-run/shell-tool.ts). */
	shell?: ShellText;
	doctor?: DoctorText;
	/** The profile's part of the shared notification frames (lib/notify/notifications-text.ts): every session uses them, so a profile must supply it. */
	notifications: NotificationsText;
	/** The first-message context (instructions, context block, date, environment, git status): every session sends it, so a profile must supply it. */
	context: ContextText;
	/** tool-search is part of the required core: a profile must supply it. */
	toolSearch: ToolSearchText;
	/** Every child session (subagents, forks, workflow agents) hands back through it. */
	handback?: HandbackText;
	subagents?: SubagentsText;
	/** Used by subagents and workflow agents (the model menu, the notices, the expensive-model gate). */
	subagentModels?: SubagentModelsText;
}

/** A profile's switches for one tool, by its registered name. Omitted fields keep the base's choice. */
export interface ToolSwitch {
	/**
	 * false: the tool is never registered, never active, and a call to it is
	 * denied, so the name is gone for good; to replace a base tool with its
	 * own, a product turns off the feature that registers it instead. `bash`
	 * is the exception: its feature overrides pi's built-in, so turning the
	 * feature off removes the name too, and a product's own shell tool takes
	 * another name. The
	 * harness's plumbing (`PINNED_TOOLS` in lib/profile/profile.ts) can't be
	 * turned off or deferred.
	 */
	enabled?: boolean;
	/** true: behind `tool_search`; false: in the tool list from the first request. Fixed at load. */
	deferred?: boolean;
	/**
	 * true: runs without a permission prompt, like `tool_search` and `skill`.
	 * For a product's own tools only: on a base tool it is refused at load,
	 * since the allow comes before containment and the classifier. Plan mode
	 * still holds such a tool to its read-only rules.
	 */
	autoAllow?: boolean;
	/**
	 * true: the tool changes nothing (it reads the project, a server or the
	 * network), so plan mode lets it run, as it does the web tools; an ask rule
	 * still asks. It does not skip the prompt in other modes: that is
	 * `autoAllow`. For a product's own tools only: refused at load on a base
	 * tool, whose plan-mode rule the base decides. A tool with a read and a
	 * write mode is not read-only; a product splits it in two.
	 */
	readOnly?: boolean;
}

export interface Profile {
	/** Features to turn off (`false`); a feature left out stays on. */
	features: Partial<Record<FeatureId, boolean>>;
	/** Per-tool switches, keyed by tool name. */
	tools: Readonly<Record<string, ToolSwitch>>;
	/**
	 * Extension entry files, relative to the profile folder and under its
	 * `extensions/` folder, that in-process child sessions (subagents, workflow
	 * agents) load after the base's own child extensions; a missing file fails
	 * at load. The main session loads `extensions/<name>/index.ts` of every
	 * folder there, through the manifest's last entry
	 * (`lib/profile/features.ts PRODUCT_EXTENSIONS_ENTRY`). Either way they load
	 * after the request pipeline (`ledger/wire`, cache-marks), so a product
	 * extension must not shape the request tail in a `context` or payload hook;
	 * it adds tools, commands, reminders and prompt sections, and imports the
	 * base only through `extensions/sdk/extension.ts`. A prompt section
	 * announced in a child session is ignored: a child sends its agent's own
	 * prompt, or as a fork the parent's, which already carries the section.
	 */
	childExtensions: readonly string[];
	/**
	 * The model providers the product registers or vouches for, by pi provider
	 * name: whose models each serves and which Anthropic wire features its
	 * endpoint accepts (`lib/profile/product-providers.ts`). A provider with no
	 * entry and unknown to the base is opaque: the tiny tier and no Anthropic
	 * wire features. The product registers the provider itself, in one of its
	 * own extensions.
	 */
	providers?: Readonly<Record<string, ProductProvider>>;
	/**
	 * Bare file names that hold secrets (BI's `Config.toml`). In every mode the
	 * gate refuses a file tool on one and a shell command that names one
	 * (the text's `permissions.secretFileRefusal` words it). The product's
	 * extension registers the values themselves for redaction
	 * (`setSecretValues`, `extensions/sdk/extension.ts`).
	 */
	secretFiles?: readonly string[];
	/**
	 * Read-only subcommands of the product's own command-line tools, with the
	 * options each may carry (`lib/shell/product-read-only.ts`):
	 * `{ bal: { discover: { none: "--refresh", required: "--filter" } } }`.
	 * The shell pre-gate treats such a command as a read: it runs in plan mode
	 * and skips the classifier in auto mode. Anything outside the table
	 * escalates as before.
	 */
	readOnlyCommands?: ReadOnlyCommands;
	/**
	 * The product's own language servers, by name
	 * (`lib/profile/language-servers.ts`): the base routes a file to one by
	 * its extension and sends the model its diagnostics after each edit, as
	 * for any server. A product extension can send its own requests on the
	 * same connection (`lspRequest`, `extensions/sdk/extension.ts`).
	 */
	languageServers?: Readonly<Record<string, ProductLanguageServer>>;
	/**
	 * The model-facing text, by owning feature, built once when the profile
	 * resolves. `live` answers which tools the session can have (the features
	 * and tool switches after the environment's off-switches), so text that
	 * names another tool, results and refusals included, leaves out what is off.
	 */
	text(env: TextEnv): ProfileText;
	/**
	 * The module, relative to the profile folder, whose `sources` export is the
	 * product's source provider (lib/profile/sources.ts): where it reads beyond the
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
