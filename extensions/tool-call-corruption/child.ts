/** The OpenRouter stream guard for an in-process child session (lib/child-extensions.ts): blocks and stops, prints nothing. */
import { feature } from "../lib/feature.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toolCallCorruptionGuard } from "./index.ts";

function childToolCallCorruptionExtension(pi: ExtensionAPI) {
	toolCallCorruptionGuard(pi, { announce: false });
}

export default feature("tool-call-corruption", childToolCallCorruptionExtension);
