/** One Code's bash tool for an in-process child session (lib/agents/child-extensions.ts): the same tool, prints nothing. */
import { feature } from "../../lib/profile/feature.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bashTool } from "./index.ts";

function childBashExtension(pi: ExtensionAPI) {
	bashTool(pi, { announce: false });
}

export default feature("bash", childBashExtension);
