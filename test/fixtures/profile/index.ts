/**
 * A minimal product profile for the base's own tests: every text group as
 * marker text (text.ts), its own brand (brand.json), and catalogs holding only
 * the names the base relies on (the `general-purpose` agent, the `loop` and
 * `code-review` skills, one theme). It has no source provider, so the base
 * reads only its own locations. It stands in for One Code's profile in the
 * base suite (scripts/test-base.sh, the CI "base" job); compiling it shows a
 * second product can fill the contract.
 */

import type { Profile } from "../extensions/lib/profile-contract.ts";
import * as text from "./text.ts";

export const profile: Profile = {
	features: {},
	tools: {},
	childExtensions: [],
	text: () => ({
		systemPrompt: text.systemPrompt,
		notebook: text.notebook,
		askUser: text.askUser,
		tasks: text.tasks,
		worktree: text.worktree,
		webFetch: text.webFetch,
		webSearch: text.webSearch,
		nativeWeb: text.nativeWeb,
		sessionTitle: text.sessionTitle,
		init: text.init,
		btw: text.btw,
		recap: text.recap,
		effort: text.effort,
		planMode: text.planMode,
		skill: text.skill,
		mcp: text.mcp,
		lsp: text.lsp,
		hooks: text.hooks,
		memory: text.memory,
		background: text.background,
		artifacts: text.artifacts,
		toolStyle: text.toolStyle,
		contextBudget: text.contextBudget,
		fileTracker: text.fileTracker,
		compaction: text.compaction,
		workflow: text.workflow,
		autoMode: text.autoMode,
		classifier: text.classifier,
		autoModeSetup: text.autoModeSetup,
		shell: text.shell,
		doctor: text.doctor,
		notifications: text.notifications,
		toolResults: text.toolResults,
		toolCallCorruption: text.toolCallCorruption,
		context: text.context,
		toolSearch: text.toolSearch,
		permissions: text.permissions,
		handback: text.handback,
		subagents: text.subagents,
		plugins: text.plugins,
		subagentModels: text.subagentModels,
		worktreeGuard: text.worktreeGuard,
	}),
};
