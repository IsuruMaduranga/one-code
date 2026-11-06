/**
 * The profile's built-in guide agent (One Code's `one-code-guide`,
 * profile/subagents/guide-agent.ts): a read-only agent the model spawns when
 * the user asks how the product works. The profile supplies its name,
 * description, tools and prompt (`SubagentsText.guideAgent`); a profile
 * without one has no guide. The base gathers what the prompt needs at spawn
 * (the docs on disk, how the session is installed, the user's live setup)
 * and keeps repository-supplied names out unless they are identifiers.
 *
 * The lowest-precedence definition, so a user or project agent file of the
 * same name replaces it. Pure (no pi imports): the subagents extension
 * gathers the inputs.
 */

import type { AgentDefinition } from "./agents.ts";
import { subagentWords } from "./words.ts";

export interface GuideInstall {
	/** `app` for the bundled app, `extension` for the package on the user's own pi. */
	shape: "app" | "extension";
	/** How the app was installed (`npm`, `brew`), when known. */
	method?: string;
	/** pi's agent directory for this session (`getAgentDir()`). */
	agentDir: string;
	/** The product version, when known. */
	version?: string;
}

/** The user's live setup, listed so the answer can build on it. Names only. */
export interface GuideSetup {
	skills: string[];
	agents: string[];
	plugins: string[];
	/** Every configured MCP server, with its status when it is not connected. */
	mcpServers: { name: string; status?: string }[];
	/** Extensions dropped into the user's pi extensions directory. */
	extensions: string[];
	/** pi packages the user installed, the product's own entry excluded. */
	packages: string[];
	/** Keys set in pi's settings file for this session (values omitted). */
	settingsKeys: string[];
}

export interface GuideInput {
	docs: { guide: string; piDocs?: string; piExamples?: string };
	install: GuideInstall;
	setup: GuideSetup;
	/** Whether Claude Code's sources are read (CLAUDE.md), and the project config folder's name. */
	config: { claudeSources: boolean; configDir: string };
}

/**
 * The packages and settings keys in pi's settings file (its raw text), minus
 * the product's own package entry (`ownRoot`, this package's directory, which
 * the app registers on every launch). Unreadable text gives nothing.
 */
export function settingsSetup(raw: string | undefined, ownRoot: string): Pick<GuideSetup, "packages" | "settingsKeys"> {
	let settings: unknown;
	try {
		settings = raw === undefined ? undefined : JSON.parse(raw);
	} catch {
		return { packages: [], settingsKeys: [] };
	}
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return { packages: [], settingsKeys: [] };
	const record = settings as Record<string, unknown>;
	const sources = (Array.isArray(record.packages) ? record.packages : [])
		.map((entry) => (typeof entry === "string" ? entry : (entry as { source?: unknown } | null)?.source))
		.filter((source): source is string => typeof source === "string");
	const own = (source: string) => source === ownRoot || /[/\\]one-code-extension$/.test(source) || /^npm:one-code-extension(@.*)?$/.test(source);
	return { packages: sources.filter((source) => !own(source)), settingsKeys: Object.keys(record).sort() };
}

/**
 * Whether a repository-supplied name may be listed in the guide's system
 * prompt: an identifier (letters, digits, `_ . : @ -`, at most 64), never free
 * text a cloned repo could use to smuggle instructions in.
 */
export function listableName(name: string): boolean {
	return /^[A-Za-z0-9_.:@-]{1,64}$/.test(name);
}

/** The setup with only identifier-shaped names where a cloned repository supplies them (skills, agents, MCP servers). */
function listableSetup(setup: GuideSetup): GuideSetup {
	return {
		...setup,
		skills: setup.skills.filter(listableName),
		agents: setup.agents.filter(listableName),
		mcpServers: setup.mcpServers.filter((server) => listableName(server.name)),
	};
}

/** The guide's system prompt from the profile, over the filtered setup; undefined when the profile has no guide. */
export function guideSystemPrompt(input: GuideInput): string | undefined {
	return subagentWords().guideAgent?.systemPrompt({ ...input, setup: listableSetup(input.setup) });
}

/**
 * The definition, with the prompt built on first read: the catalog lists the
 * guide on every agent listing and spawn, and only a spawn of the guide needs
 * its prompt (the setup it lists costs a settings read and directory scans).
 * Undefined when the profile has no guide.
 */
export function guideAgentDefinition(input: () => GuideInput): AgentDefinition | undefined {
	const guide = subagentWords().guideAgent;
	if (!guide) return undefined;
	let prompt: string | undefined;
	return {
		name: guide.name,
		description: guide.description,
		tools: [...guide.tools],
		get systemPrompt() {
			if (prompt === undefined) {
				const value = input();
				prompt = guide.systemPrompt({ ...value, setup: listableSetup(value.setup) });
			}
			return prompt;
		},
		source: "built-in",
	};
}
