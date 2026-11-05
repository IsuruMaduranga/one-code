/**
 * One Code's first-message context text (the profile's `text.context`):
 * Claude Code's instructions, context, date, environment and git-status
 * blocks byte for byte, with One Code named as the harness that attached
 * them, and One Code's own ONECODE.md preamble and notes.
 */

import type { ContextChange, ContextText, InstructionSource } from "../../extensions/lib/context-text.ts";

const DESCRIPTORS: Record<InstructionSource, string> = {
	global: "user's private global instructions for all projects",
	managed: "organization-managed policy instructions",
	project: "project instructions, checked into the codebase",
	local: "user's private project instructions, not checked in",
	memory: "user's auto-memory, persists across conversations",
	oneCode: "One Code-specific instructions, not read by Claude Code",
	oneCodeGlobal: "One Code-specific global instructions for all projects, not read by Claude Code",
	agents: "cross-tool agent instructions, AGENTS.md standard",
};

const CHANGES: Record<ContextChange, string> = {
	git: "git status changed",
	memory: "the memory index changed",
	instructions: "CLAUDE.md-family instructions changed",
};

export const context: ContextText = {
	instructionsPreamble:
		"Codebase and user instructions are shown below. Be sure to adhere to these instructions. " +
		"IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.",
	descriptor: (source) => DESCRIPTORS[source],
	section: ({ path, descriptor, content }) => `Contents of ${path} (${descriptor}):\n\n${content}`,
	oneCodePreamble: ({ above }) =>
		"# oneCodeMd\n" +
		"The following are One Code-specific instructions, read only by One Code and not by other tools. " +
		`IMPORTANT: they take precedence over the ${above} instructions above and over any default behavior — ` +
		`where they conflict with ${above}, follow these. Follow them exactly as written.`,
	nestedFile: ({ path, content }) => `Contents of ${path}:\n\n${content}`,
	contextPreamble: "As you answer the user's questions, you can use the following context:",
	// Claude Code's sentence after the email.
	email: ({ email }) =>
		`# userEmail\nThe user's email address is ${email}. ` +
		"Use it only to identify the user, such as for authorship, attribution, or filtering their own work. " +
		"Never send it to an unrelated service, such as in a request header, URL, or payload, unless the user explicitly asks.",
	contextFooter:
		"One Code attached this context automatically; it isn't part of the user's message. " +
		"It describes the user's own account and workspace, so they don't need it reported back.",
	date: ({ date }) => `Today's date is ${date}.`,
	dateChanged: ({ date }) => `The date has changed. Today's date is now ${date}. No need to announce the new date — the user's own clock shows it.`,
	environment: (env) => {
		const lines = [
			"# Environment",
			"You have been invoked in the following environment: ",
			` - Primary working directory: ${env.cwd}`,
			` - Is a git repository: ${env.isGitRepo}`,
		];
		if (env.workspaceDirs?.length) lines.push(" - Additional working directories:", ...env.workspaceDirs.map((dir) => `  - ${dir}`));
		lines.push(` - Platform: ${env.platform}`, ` - Shell: ${env.shell}`, ` - OS Version: ${env.osVersion}`);
		if (env.scratchpadDir) {
			lines.push(
				` - Scratchpad directory: ${env.scratchpadDir} — always use it for temporary files (intermediate results, scripts, outputs that don't belong in the project) instead of \`/tmp\` or other system temp directories; it is session-specific, isolated from the project, and can generally be used without permission prompts. Only use \`/tmp\` if the user explicitly asks.`,
			);
		}
		return lines.join("\n");
	},
	modelLine: ({ name, id, cutoff }) => {
		const base = `You are powered by the model named ${name}. The exact model ID is ${id}.`;
		return cutoff ? `${base} Assistant knowledge cutoff is ${cutoff}.` : base;
	},
	gitStatus: ({ snapshot: s, at }) =>
		[
			`# gitStatus\nThis is the git status at ${at === "start" ? "the start of the conversation" : "the latest compaction"}. ` +
				"Note that this status is a snapshot in time, and will not update during the conversation.",
			"",
			`Current branch: ${s.branch}`,
			"",
			`Main branch (you will usually use this for PRs): ${s.mainBranch}`,
			"",
			...(s.user ? [`Git user: ${s.user}`, ""] : []),
			"Status:",
			s.status || "(clean)",
			"",
			"Recent commits:",
			s.commits,
		].join("\n"),
	gitStatusClipped: ({ shellTool }) => `\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" using ${shellTool})`,
	changedSinceSnapshot: ({ changes, atCompaction }) =>
		`Since the saved context snapshot, ${changes.map((change) => CHANGES[change]).join("; ")}. The earlier context block reflects ${atCompaction ? "the latest compaction" : "the session's start"}, not the current workspace. Read the current files or run git status if needed.`,
	skippedInstruction: ({ tokens, contextWindow, imported }) => {
		const what = imported.length > 0 ? `This file and the files it imports (${imported.join(", ")}) are not loaded: together they are` : "This file is not loaded: it is";
		return (
			`${what} about ${tokens.toLocaleString("en-US")} tokens, and instruction files may take at most half of this model's ` +
			`${contextWindow.toLocaleString("en-US")}-token context window. Read the parts of it that bear on your task when you need them.\n`
		);
	},
	classifierSkippedInstruction: ({ tokens, contextWindow }) =>
		`(Not shown: this instruction file is about ${tokens.toLocaleString("en-US")} tokens, and instruction files may take at most half of the session model's ` +
		`${contextWindow.toLocaleString("en-US")}-token context window, so it is left out here as it is for the agent. Leaving it out grants no permission.)`,
};
