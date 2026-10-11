/** One Code's PowerShell tool for an in-process child session (lib/child-extensions.ts): the same tool and activation, prints nothing. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { powershellTool } from "./index.ts";

export default function childPowershellExtension(pi: ExtensionAPI) {
	powershellTool(pi, { announce: false });
}
