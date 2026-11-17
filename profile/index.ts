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
import { permissionsText } from "./text/permissions/index.ts";
import { classifier } from "./text/auto-mode/classifier.ts";
import { autoModeSetup } from "./text/auto-mode/setup.ts";
import { backgroundText } from "./text/background/index.ts";
import { btw } from "./text/btw/index.ts";
import { compaction } from "./text/compaction/index.ts";
import { context } from "./text/context/index.ts";
import { doctorText } from "./text/doctor/index.ts";
import { effort } from "./text/effort/index.ts";
import { handback } from "./text/handback/index.ts";
import { init } from "./text/init/index.ts";
import { lsp } from "./text/lsp/index.ts";
import { mcp } from "./text/mcp/index.ts";
import { nativeWeb } from "./text/native-web/index.ts";
import { notebook } from "./text/notebook/index.ts";
import { notifications } from "./text/notifications/index.ts";
import { planModeText } from "./text/plan-mode/index.ts";
import { recap } from "./text/recap/index.ts";
import { sessionTitle } from "./text/session-title/index.ts";
import { shellText } from "./text/shell/index.ts";
import { skill } from "./text/skill/index.ts";
import { subagentModels } from "./text/subagent-models/index.ts";
import { subagentsText } from "./text/subagents/index.ts";
import { systemPromptText } from "./text/system-prompt/index.ts";
import { tasks } from "./text/tasks/index.ts";
import { toolSearchText } from "./text/tool-search/index.ts";
import { toolStyleText } from "./text/tool-style/index.ts";
import { webFetchText } from "./text/web-fetch/index.ts";
import { webSearch } from "./text/web-search/index.ts";
import { workflowText } from "./text/workflow/index.ts";
import { worktree } from "./text/worktree/index.ts";

/** The precisions OpenRouter may serve these vendors' models at: fp8, bf16, fp16 and fp32, plus "unknown" for endpoints that declare none; fp4, fp6, int4 and int8 endpoints are left out. */
const OPENROUTER_QUANTIZATION_FLOOR = ["fp8", "bf16", "fp16", "fp32", "unknown"];

export const profile: Profile = {
	features: {},
	// Search goes through the shell on every tier: pi's grep, find and ls are off (decisions/tools.md).
	tools: { grep: { enabled: false }, find: { enabled: false }, ls: { enabled: false } },
	childExtensions: [],
	// Smaller models think less by default: weak models at medium overthink far more than at low. Frontier keeps pi's level.
	defaultThinkingLevels: { workhorse: "medium", cheap: "low", tiny: "low" },
	// The floor on the vendors measured: one host per session and the same cache reads with it, and
	// every catalog model of theirs keeps a host (findings §93, 2026-11-17).
	openRouterRouting: {
		deepseek: { quantizations: OPENROUTER_QUANTIZATION_FLOOR },
		qwen: { quantizations: OPENROUTER_QUANTIZATION_FLOOR },
	},
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
		background: backgroundText(live),
		artifacts: artifactsText(live),
		toolStyle: toolStyleText(live),
		compaction,
		workflow: workflowText(live),
		permissions: permissionsText(live),
		classifier,
		autoModeSetup,
		shell: shellText(live),
		doctor: doctorText(live),
		notifications,
		context,
		toolSearch: toolSearchText(live),
		handback,
		subagentModels,
		subagents: subagentsText(live),
	}),
	sources: "claude-code/sources.ts",
	globalAgentsFiles: ["~/.agents/AGENTS.md"],
};
