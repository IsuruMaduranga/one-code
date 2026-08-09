/**
 * Claude Code system prompt, adapted for One Code, selected by model tier.
 *
 * The tier-specific section text lives in `tiers/` (one bundle per tier);
 * this module is the tier-agnostic composer — it places the dynamic blocks
 * (tools, memory, environment, scratchpad, project context, skills, cwd trailer)
 * around the bundle's `lead`/`tail` sections. Sections tied to Anthropic-hosted
 * features are dropped, and the environment block is generated dynamically.
 *
 * For a fixed tier this function must be pure and deterministic: same inputs,
 * byte-identical output (prompt-cache stability). The frontier bundle reproduces
 * the pre-tiering prompt exactly.
 */

import { formatSkillsForPrompt, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { memoryPromptSection } from "../lib/memory.ts";
import type { PromptTier } from "../lib/model-tier.ts";
import { scratchpadPromptSection } from "../lib/scratchpad.ts";
import type { EnvironmentInfo } from "./environment.ts";
import type { PromptBundle } from "./tiers/common.ts";
import { frontierBundle } from "./tiers/frontier.ts";
import { lowBundle } from "./tiers/low.ts";
import { midBundle } from "./tiers/mid.ts";

const BUNDLES: Record<PromptTier, PromptBundle> = {
	frontier: frontierBundle,
	mid: midBundle,
	low: lowBundle,
};

function buildToolsSection(options: BuildSystemPromptOptions): string {
	const tools = options.selectedTools ?? ["read", "bash", "edit", "write"];
	const visible = tools.filter((name) => !!options.toolSnippets?.[name]);
	const toolsList =
		visible.length > 0 ? visible.map((name) => `- ${name}: ${options.toolSnippets![name]}`).join("\n") : "(none)";

	const guidelines: string[] = [];
	const seen = new Set<string>();
	for (const g of options.promptGuidelines ?? []) {
		const trimmed = g.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			guidelines.push(trimmed);
		}
	}
	const guidelinesBlock = guidelines.length > 0 ? `\n\nGuidelines:\n${guidelines.map((g) => `- ${g}`).join("\n")}` : "";

	return `# Available tools\n${toolsList}${guidelinesBlock}`;
}

function buildEnvironmentSection(env: EnvironmentInfo): string {
	return `# Environment
 - Working directory: ${env.cwd}
 - Is a git repository: ${env.isGitRepo ? "yes" : "no"}
 - Platform: ${env.platform}
 - OS Version: ${env.osVersion}
 - Shell: ${env.shell}
 - Today's date: ${env.date}
 - Model: ${env.modelLine}`;
}

export function buildClaudeCodeSystemPrompt(
	options: BuildSystemPromptOptions,
	env: EnvironmentInfo,
	tier: PromptTier,
	/**
	 * Per-session (it embeds the session id), so it rides outside the
	 * (cwd, model, tier)-cached EnvironmentInfo — constant within a session, which
	 * is all provider prompt caching needs.
	 */
	scratchpadDir?: string,
): string {
	const bundle = BUNDLES[tier];
	const sections = [
		...bundle.lead,
		buildToolsSection(options),
		// Claude Code orders Memory just before Environment; mid/low use the long spec.
		memoryPromptSection(env.memoryDir, bundle.verboseMemory),
		buildEnvironmentSection(env),
		// Claude Code orders Scratchpad between Environment and the tail sections.
		...(scratchpadDir ? [scratchpadPromptSection(scratchpadDir)] : []),
		...bundle.tail,
	];

	let prompt = sections.join("\n\n");

	// Mirror pi's own custom-prompt assembly: append text, project context
	// files (CLAUDE.md / AGENTS.md), skills, and the trailing cwd line.
	if (options.appendSystemPrompt) {
		prompt += `\n\n${options.appendSystemPrompt}`;
	}

	const contextFiles = options.contextFiles ?? [];
	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		// Claude Code frames context files as overriding defaults; without that the
		// model treats CLAUDE.md as background reading rather than instructions.
		prompt += "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	const skills = options.skills ?? [];
	const hasRead = !options.selectedTools || options.selectedTools.includes("read");
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	prompt += `\nCurrent working directory: ${env.cwd.replace(/\\/g, "/")}`;

	return prompt;
}
