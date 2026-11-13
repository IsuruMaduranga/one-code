/** One Code's PowerShell tool for an in-process child session (lib/agents/child-extensions.ts): the same tool and activation, prints nothing. */
import { feature } from "../../lib/profile/feature.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { powershellTool } from "./index.ts";

function childPowershellExtension(pi: ExtensionAPI) {
	powershellTool(pi, { announce: false });
}

export default feature("powershell", childPowershellExtension);
