/**
 * The profile's subagent words for the extension's modules (the runner, the
 * turn tracker, worktrees, run names, the agent catalog), which run inside
 * calls without the extension's own context. Fails closed (`requireText`)
 * when the profile has none. Workflow agents reach two of them too (an
 * unusable tools list, a refused worktree).
 */

import { requireText } from "../../lib/profile/profile.ts";
import type { SubagentsText } from "./text.ts";

export const subagentWords = (): SubagentsText => requireText("subagents");
