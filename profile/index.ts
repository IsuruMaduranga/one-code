/**
 * One Code's profile: everything that makes the base harness One Code
 * (working-docs/decisions/bi-fork.md). A product built on the base replaces
 * this folder with its own implementation of `Profile`
 * (extensions/lib/profile/profile-contract.ts), importing the base only through
 * extensions/sdk/.
 *
 * One Code runs every feature and keeps each tool's base switches. Its text
 * lives in text/, one folder per owning feature; agents/, skills/ and themes/
 * are its bundled catalogs; claude-code/ holds the code that reads
 * Claude Code's own files (the source provider).
 */

import type { Profile } from "../extensions/sdk/profile.ts";
import { artifactsText } from "./text/artifacts/index.ts";
import { askUserText } from "./text/ask-user/index.ts";
import { autoModeText } from "./text/auto-mode/index.ts";
import { classifier } from "./text/auto-mode/classifier.ts";
import { autoModeSetup } from "./text/auto-mode/setup.ts";
import { background } from "./text/background/index.ts";
import { btw } from "./text/btw/index.ts";
import { compaction } from "./text/compaction/index.ts";
import { context } from "./text/context/index.ts";
import { contextBudget } from "./text/context-budget/index.ts";
import { doctorText } from "./text/doctor/index.ts";
import { effort } from "./text/effort/index.ts";
import { handback } from "./text/handback/index.ts";
import { init } from "./text/init/index.ts";
import { lsp } from "./text/lsp/index.ts";
import { mcp } from "./text/mcp/index.ts";
import { nativeWeb } from "./text/native-web/index.ts";
import { notebook } from "./text/notebook/index.ts";
import { notificationsText } from "./text/notifications/index.ts";
import { permissionsText } from "./text/permissions/index.ts";
import { planModeText } from "./text/plan-mode/index.ts";
import { recap } from "./text/recap/index.ts";
import { sessionTitle } from "./text/session-title/index.ts";
import { shellText } from "./text/shell/index.ts";
import { skill } from "./text/skill/index.ts";
import { subagentModels } from "./text/subagent-models/index.ts";
import { subagentsText } from "./text/subagents/index.ts";
import { systemPromptText } from "./text/system-prompt/index.ts";
import { tasks } from "./text/tasks/index.ts";
import { toolResults } from "./text/tool-results/index.ts";
import { toolSearchText } from "./text/tool-search/index.ts";
import { toolStyleText } from "./text/tool-style/index.ts";
import { webFetchText } from "./text/web-fetch/index.ts";
import { webSearch } from "./text/web-search/index.ts";
import { workflowText } from "./text/workflow/index.ts";
import { worktree } from "./text/worktree/index.ts";

export const profile: Profile = {
	features: {},
	tools: {},
	childExtensions: [],
	text: ({ live }) => ({
		systemPrompt: systemPromptText(live),
		notebook,
		askUser: askUserText(live),
		tasks,
		worktree,
		webFetch: webFetchText(live),
		webSearch,
		nativeWeb,
		sessionTitle,
		init,
		btw,
		recap,
		effort,
		planMode: planModeText(live),
		skill,
		mcp,
		lsp,
		background,
		artifacts: artifactsText(live),
		toolStyle: toolStyleText(live),
		contextBudget,
		compaction,
		workflow: workflowText(live),
		autoMode: autoModeText(live),
		classifier,
		autoModeSetup,
		shell: shellText(live),
		doctor: doctorText(live),
		notifications: notificationsText(live),
		toolResults,
		context,
		toolSearch: toolSearchText(live),
		permissions: permissionsText(live),
		handback,
		subagentModels,
		subagents: subagentsText(live),
	}),
	sources: "claude-code/sources.ts",
	globalAgentsFiles: ["~/.agents/AGENTS.md"],
};
