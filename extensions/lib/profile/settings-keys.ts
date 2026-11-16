/**
 * The keys the base reads from the product's own settings files, and the
 * settings a profile declares for its own extensions (`Profile.settings`).
 * /doctor's table of which file supplies each key (commands/doctor/compat.ts)
 * takes the product's rows from here, and the profile's load check refuses a
 * declared key the base already reads, so a product setting can never shadow
 * or be shadowed by one of the base's (`permissions`, `autoMode`, `env`).
 *
 * A leaf: no imports, so the profile loader can use it.
 */

/** The auto-memory switch, as Claude Code spells it (lib/context/auto-memory.ts). */
export const AUTO_MEMORY_KEY = "autoMemoryEnabled";

/** The base's workflow keys, read from the product's user and project files (lib/profile/product-settings.ts). */
export const WORKFLOW_KEYS = ["enableWorkflows", "disableWorkflows", "workflowSizeGuideline"] as const;

/** The base's keys in the product's user file. */
export const PRODUCT_USER_KEYS: readonly string[] = [
	"subagentModel",
	"subagentModelSetFor",
	"autoMode",
	"permissions",
	"webSearch",
	"disabledMcpServers",
	// The /memory panel's auto-memory row (lib/context/auto-memory.ts).
	AUTO_MEMORY_KEY,
	"modelTiers",
	"suggestNewerModels",
	"refreshModelCatalog",
	"artifacts",
	...WORKFLOW_KEYS,
	// Remembered "No" answers to startup questions (ui/branding/declined.ts).
	"compactionKeepDeclined",
	"piBuiltinsTurnOffDeclined",
	// The first outside-read prompt in auto mode, answered (lib/rules/settings.ts outsideReadPromptSeen).
	"hasSeenAutoModeOutsideReadPrompt",
	// The desktop notification channel (ui/desktop-notify).
	"preferredNotifChannel",
];

/** The base's keys in the product's per-project file (in its state folder, outside the checkout). */
export const PRODUCT_LOCAL_KEYS: readonly string[] = [
	"permissions",
	"disabledMcpServers",
	AUTO_MEMORY_KEY,
	...WORKFLOW_KEYS,
	// The external CLAUDE.md includes answer, per repository (lib/context/external-includes.ts).
	"hasClaudeMdExternalIncludesApproved",
	"hasClaudeMdExternalIncludesWarningShown",
	"claudeMdExternalIncludesRoot",
];

/** The MCP approval keys, read from the primary settings file (tools/mcp/trust.ts). */
export const MCP_POLICY_KEYS = ["enableAllProjectMcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers"] as const;

/**
 * Keys the base takes from a file by its role rather than its row: `hooks`
 * and `disableAllHooks` from the primary file's family
 * (safety/hooks/settings.ts), `env` and the MCP approvals from the primary
 * file, which is the product's user file when no source provider names
 * another (lib/profile/settings-files.ts), and `$schema`.
 */
const ROLE_KEYS: readonly string[] = ["hooks", "disableAllHooks", "env", ...MCP_POLICY_KEYS, "$schema"];

/** Every key the base reads from the product's files: a profile cannot declare one of these. */
export const BASE_PRODUCT_KEYS: ReadonlySet<string> = new Set([...PRODUCT_USER_KEYS, ...PRODUCT_LOCAL_KEYS, ...ROLE_KEYS]);

/** One setting a profile declares for its own extensions (`Profile.settings`). */
export interface ProductSetting {
	/** The JSON type of the value; a value of another type reads as unset. */
	type: "boolean" | "string" | "number";
	/** Also read from the product's per-project file, which wins; otherwise the user file alone. */
	project?: boolean;
	/** What the setting does, shown by /doctor. */
	description: string;
}

const SETTING_TYPES = new Set(["boolean", "string", "number"]);

/** What is wrong with a profile's declared settings, one sentence each. */
export function productSettingProblems(settings: Readonly<Record<string, ProductSetting>>): string[] {
	const problems: string[] = [];
	for (const [key, setting] of Object.entries(settings)) {
		if (key.trim() === "") problems.push("a declared setting has an empty name");
		else if (BASE_PRODUCT_KEYS.has(key)) problems.push(`the setting "${key}" is one the base reads from the product's settings files: declare it under another name`);
		if (!SETTING_TYPES.has(setting?.type)) problems.push(`the setting "${key}" has type ${JSON.stringify(setting?.type)}: use "boolean", "string" or "number"`);
		if (typeof setting?.description !== "string" || setting.description.trim() === "") problems.push(`the setting "${key}" needs a description: /doctor shows it`);
	}
	return problems;
}
