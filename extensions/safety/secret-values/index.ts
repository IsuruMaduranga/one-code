/**
 * Redacts a product's secret values from every tool result before it is
 * stored (lib/profile/secrets.ts): the value layer under the gate's refusal
 * of secret files by name. A result is rewritten here, once, on its way into
 * the session, so the request stays append-only.
 *
 * Loads last, in the main session and in every child session: after the
 * base's extensions and after a product's own, so whatever their
 * `tool_result` handlers add to a result is redacted too (pi runs handlers
 * in load order). It does nothing until a product registers a value.
 *
 * The model sees `[secret:name]` where a value was, so a file it rewrites
 * from what it read would lose the real value. A file-writing tool whose
 * input carries such a placeholder is refused, with the reason.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { feature } from "../../lib/profile/feature.ts";
import { carriesSecretPlaceholder, hasSecretValues, redactSecretValues, redactSecretValuesIn } from "../../lib/profile/secrets.ts";
import { toolResultWords } from "../../lib/request/tool-results-words.ts";
import { isWritingTool } from "../../lib/shell/paths.ts";

function secretValuesExtension(pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (!hasSecretValues() || !isWritingTool(event.toolName)) return undefined;
		if (!carriesSecretPlaceholder(JSON.stringify(event.input ?? {}))) return undefined;
		return { block: true, reason: toolResultWords().secretPlaceholderWrite };
	});

	pi.on("tool_result", (event) => {
		if (!hasSecretValues()) return undefined;
		let changed = false;
		const content = event.content.map((part) => {
			if (part.type !== "text" || typeof part.text !== "string") return part;
			const text = redactSecretValues(part.text);
			if (text === part.text) return part;
			changed = true;
			return { ...part, text };
		});
		// pi drops structured content that is not replaced along with the text.
		const structured = event.structuredContent === undefined ? undefined : redactSecretValuesIn(event.structuredContent);
		const structuredChanged = structured !== event.structuredContent;
		if (!changed && !structuredChanged) return undefined;
		return { content, ...(structured !== undefined ? { structuredContent: structured as never } : {}) };
	});
}

export default feature("secret-values", secretValuesExtension);
