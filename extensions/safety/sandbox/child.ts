/**
 * The sandbox section for an in-process child session
 * (lib/agents/child-extensions.ts). A child's shell commands run in the
 * process's sandbox, which the main session starts and stops, and its bash
 * tool has the sandbox's parameters, so its model reads the same section
 * with the rules of its own working directory (a worktree's, for an isolated
 * child). It starts nothing and registers no command.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { feature } from "../../lib/profile/feature.ts";
import { tellSandboxSection } from "./index.ts";

function childSandboxExtension(pi: ExtensionAPI) {
	tellSandboxSection(pi);
}

export default feature("sandbox", childSandboxExtension);
