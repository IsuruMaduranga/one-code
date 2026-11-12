/**
 * One Code's worktree-tool words (the profile's `text.worktree`): Claude Code's
 * EnterWorktree/ExitWorktree descriptions (descriptions.ts) and the parameter
 * words.
 */

import type { WorktreeText } from "../../../extensions/sdk/profile.ts";
import { enterWorktreeDescription, ENTER_WORKTREE_PARAMS, EXIT_WORKTREE_DESCRIPTION, EXIT_WORKTREE_PARAMS } from "./descriptions.ts";

export const worktree: WorktreeText = {
	descriptions: { enter_worktree: enterWorktreeDescription, exit_worktree: EXIT_WORKTREE_DESCRIPTION },
	params: { enter: ENTER_WORKTREE_PARAMS, exit: EXIT_WORKTREE_PARAMS },
	searchKeywords: {
		enter_worktree: ["worktree", "isolate", "branch", "checkout"],
		exit_worktree: ["worktree", "leave", "return", "cleanup"],
	},
};
