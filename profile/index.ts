/**
 * One Code's profile: everything that makes the base harness One Code
 * (working-docs/decisions/bi-fork.md). A product built on the base replaces
 * this folder with its own implementation of `Profile`
 * (extensions/lib/profile-contract.ts).
 *
 * One Code runs every feature and keeps each tool's base switches. Its text
 * lives beside this file, one folder per text group.
 */

import type { Profile } from "../extensions/lib/profile-contract.ts";
import { artifacts } from "./artifacts/index.ts";
import { askUser } from "./ask-user/index.ts";
import { autoMode } from "./auto-mode/index.ts";
import { background } from "./background/index.ts";
import { btw } from "./btw/index.ts";
import { compaction } from "./compaction/index.ts";
import { context } from "./context/index.ts";
import { contextBudget } from "./context-budget/index.ts";
import { doctor } from "./doctor/index.ts";
import { effort } from "./effort/index.ts";
import { fileTracker } from "./file-tracker/index.ts";
import { handback } from "./handback/index.ts";
import { hooks } from "./hooks/index.ts";
import { init } from "./init/index.ts";
import { lsp } from "./lsp/index.ts";
import { mcp } from "./mcp/index.ts";
import { memory } from "./memory/index.ts";
import { nativeWeb } from "./native-web/index.ts";
import { notebook } from "./notebook/index.ts";
import { notifications } from "./notifications/index.ts";
import { permissions } from "./permissions/index.ts";
import { planMode } from "./plan-mode/index.ts";
import { plugins } from "./plugins/index.ts";
import { recap } from "./recap/index.ts";
import { sessionTitle } from "./session-title/index.ts";
import { shell } from "./shell/index.ts";
import { skill } from "./skill/index.ts";
import { subagentModels } from "./subagent-models/index.ts";
import { subagents } from "./subagents/index.ts";
import { systemPrompt } from "./system-prompt/index.ts";
import { tasks } from "./tasks/index.ts";
import { toolCallCorruption } from "./tool-call-corruption/index.ts";
import { toolResults } from "./tool-results/index.ts";
import { toolSearch } from "./tool-search/index.ts";
import { toolStyle } from "./tool-style/index.ts";
import { webFetch } from "./web-fetch/index.ts";
import { webSearch } from "./web-search/index.ts";
import { workflow } from "./workflow/index.ts";
import { worktreeGuard } from "./worktree/guard.ts";
import { worktree } from "./worktree/index.ts";

export const profile: Profile = {
	features: {},
	tools: {},
	childExtensions: [],
	text: { systemPrompt, notebook, askUser, tasks, worktree, worktreeGuard, webFetch, webSearch, nativeWeb, sessionTitle, init, btw, recap, effort, planMode, skill, mcp, lsp, hooks, memory, background, artifacts, toolStyle, contextBudget, fileTracker, compaction, workflow, autoMode, shell, doctor, notifications, toolResults, toolCallCorruption, context, toolSearch, permissions, handback, subagentModels, subagents, plugins },
};
