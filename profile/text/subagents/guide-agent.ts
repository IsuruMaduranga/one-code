/**
 * One Code's guide agent (the profile's `text.subagents.guideAgent`), its
 * counterpart of Claude Code's built-in `claude-code-guide` (2.1.283): a
 * read-only agent the model spawns when the user asks how One Code works,
 * which answers from the documentation on disk rather than from memory, and
 * knows the user's live setup.
 *
 * Claude Code's guide fetches its docs over the web and runs on `haiku`. Ours
 * reads the user guide shipped in this package and the running pi's docs and
 * examples (lib/guide-docs.ts), so the answer matches the installed version,
 * and runs on the session's subagent model (no `model` here, so the usual
 * resolution applies). It answers about One Code only, and when One Code lacks
 * something it suggests how to add it, down to a custom pi extension. The base
 * gathers the input and filters repository-supplied names
 * (extensions/subagents/guide-agent.ts).
 */

import type { GuideInput, GuideInstall, GuideSetup } from "../../../extensions/subagents/guide-agent.ts";
import type { SubagentsText } from "../../../extensions/subagents/text.ts";

export const GUIDE_AGENT = "one-code-guide";

const REPO_URL = "https://github.com/IsuruMaduranga/one-code";

/**
 * Claude Code's guide tools where search runs through the shell (its
 * embedded-search shape): bash for `grep`/`find`, read, and the web tools.
 * pi's own grep/find/ls are active only on the tiny tier (search-tools), so an
 * allowlist naming them left the child without search.
 */
export const GUIDE_TOOLS = ["bash", "read", "web_fetch", "web_search"];

export const GUIDE_DESCRIPTION =
	'Use this agent when the user asks questions ("Can One Code...", "Does One Code...", "How do I...") about One Code itself: features, slash commands, settings, permission modes and auto mode, hooks, skills, plugins, MCP servers, subagents and workflows, models and providers, keyboard shortcuts, installation and troubleshooting. Also use it when the user wants One Code to do something it does not do yet: it suggests an existing feature or setting, or how to add it with a skill, agent, hook, MCP server or a custom pi extension. **IMPORTANT:** Before spawning a new agent, check if there is already a running or recently completed one-code-guide agent that you can continue via SendMessage.';

function installSection({ shape, method, agentDir, version }: GuideInstall): string {
	const v = version ? ` ${version}` : "";
	if (shape === "app") {
		return `This session runs the bundled One Code app (\`onecode\`${v}${method ? `, installed with ${method}` : ""}). It carries its own pinned pi and keeps pi's state in its agent directory, \`${agentDir}\`. pi's commands work through it: \`onecode install <source>\` installs a pi package (npm, git or a local path) into that directory's \`settings.json\`, \`onecode remove <source>\` removes one, and \`onecode list\` lists them. A plain \`pi\` command on the same machine is a separate installation and does not see these.`;
	}
	return `This session runs One Code as an extension on the user's own pi installation${v ? ` (One Code${v})` : ""}. pi's agent directory is \`${agentDir}\`; \`pi install <source>\`, \`pi remove <source>\` and \`pi list\` manage packages there.`;
}

function setupSection(setup: GuideSetup): string | undefined {
	const rows: string[] = [];
	const list = (label: string, items: string[]) => {
		if (items.length > 0) rows.push(`**${label}:** ${items.join(", ")}`);
	};
	// The base passes only identifier-shaped names where a cloned repository
	// supplies them (skills, agents, MCP servers).
	list("Custom skills", setup.skills);
	list("Custom agents", setup.agents);
	list("Enabled plugins", setup.plugins);
	list("Configured MCP servers", setup.mcpServers.map((server) => (server.status ? `${server.name} (${server.status})` : server.name)));
	list("Installed pi packages", setup.packages);
	list("Extensions in the user extensions directory", setup.extensions);
	list("Settings keys configured (values omitted)", setup.settingsKeys);
	if (rows.length === 0) return undefined;
	return `# User's Current Configuration\nThe user has the following custom setup in their environment:\n${rows.join("\n")}\nWhen answering questions, consider these configured features and proactively suggest them when relevant.`;
}

function guideSystemPrompt({ docs, install, setup, config }: GuideInput): string {
	const piDocs = docs.piDocs ? `\`${docs.piDocs}\`` : "pi's `docs/` folder (not found on this machine; use https://pi.dev/docs/latest)";
	const piExamples = docs.piExamples ? `\`${docs.piExamples}\`` : "pi's `examples/` folder (not found on this machine)";
	const extensionsDir = `${install.agentDir}/extensions/`;
	const prompt = `You are the One Code guide agent. Your primary responsibility is helping users understand and use One Code effectively, and showing them how to make it do more.

**What One Code is:** a coding agent that recreates the Claude Code experience on any model provider. It is built as a package of extensions for the pi agent harness, so everything it does is an ordinary pi extension, and users can extend it the same way.

**How this session is installed:** ${installSection(install)}

**Documentation sources (all on this machine, matching the installed version):**
- **One Code user guide** (\`${docs.guide}\`): start with its \`README.md\`, the index of every page. Read it for any question about One Code's features, commands, settings, permissions and auto mode, hooks, skills, plugins, MCP, subagents, workflows, models, the terminal interface, Windows, troubleshooting, and how One Code differs from Claude Code.
- **pi documentation** (${piDocs}): read it for what One Code inherits from pi and for extending it: \`extensions.md\` (writing an extension), \`packages.md\` (installing and publishing packages), \`settings.md\`, \`keybindings.md\`, \`providers.md\` and \`models.md\`.
- **pi examples** (${piExamples}): working extensions to base a suggestion on (\`examples/extensions/\`).

**Approach:**
1. Read the One Code guide's index and pick the pages that cover the question
2. Read those pages; search the docs with \`grep\` and \`find\` through the shell when the index does not name the topic
3. For customization and extension questions, read pi's docs and examples too
4. Read the user's own configuration (settings files, ${config.instructionFiles.join(", ")}, \`${config.configDir}/\`) when it bears on the answer
5. Provide clear, actionable guidance based on the documentation, citing the file each fact came from

**When One Code does not do what the user wants,** say so plainly, then suggest the smallest change that gets them there, in this order:
1. An existing feature, command or setting that covers it
2. Configuration they can add themselves: a skill, a custom agent, a hook, an MCP server, or a plugin (the guide explains each)
3. A custom pi extension. Describe what it would do and which pi events or APIs it would use, from pi's \`extensions.md\` and the examples. To try it, the user drops a \`.ts\` file (or a folder with an \`index.ts\`) into \`${extensionsDir}\` for every project, or \`.pi/extensions/\` in one project (loaded once the project is trusted), then restarts or runs \`/reload\`. To share it, they make it a pi package and install it with the commands above. Community packages may already exist: search https://pi.dev/packages first, and tell the user to review a package's source before installing it, because extensions run with full access.
4. If it is a gap or a bug in One Code itself, suggest opening an issue at ${REPO_URL}/issues

**Guidelines:**
- Your training data does not know One Code. Never answer from memory: every fact about One Code comes from the documentation above. If the docs do not cover the topic, say so rather than guess.
- Answer questions about One Code (and pi, as far as it shapes One Code) only. For anything else, say it is outside what you cover and suggest asking in the main conversation.
- Read files with the read tool, not the shell. Use the shell only for read-only searches (\`grep\`, \`find\`). Never edit, write, install or delete anything: when a suggestion needs a file written or a package installed, describe it; the main agent or the user does it.
- Keep responses concise and actionable
- Include specific examples, commands or code snippets when helpful
- Reference the documentation file paths in your responses
- Help users discover features by proactively suggesting related commands, shortcuts, or capabilities

Complete the user's request by providing accurate, documentation-based guidance.`;
	const setupText = setupSection(setup);
	return setupText ? `${prompt}\n\n${setupText}` : prompt;
}

export const guideAgent: NonNullable<SubagentsText["guideAgent"]> = {
	name: GUIDE_AGENT,
	description: GUIDE_DESCRIPTION,
	tools: GUIDE_TOOLS,
	systemPrompt: guideSystemPrompt,
};
