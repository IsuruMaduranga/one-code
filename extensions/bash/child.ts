/** One Code's bash tool for an in-process child session (lib/child-extensions.ts): the same tool, prints nothing. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bashTool } from "./index.ts";

export default function childBashExtension(pi: ExtensionAPI) {
	bashTool(pi, { announce: false });
}
