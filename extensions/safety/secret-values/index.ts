/**
 * Redacts a product's secret values from every tool result before it is
 * stored (lib/profile/secrets.ts): the value layer under the gate's refusal
 * of secret files by name. A result is rewritten here, once, on its way into
 * the session, so the request stays append-only.
 *
 * Loads late in the main session and in every child session, after the
 * extensions whose `tool_result` handlers add to a result (pi runs them in
 * load order). It does nothing until a product registers a value.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { feature } from "../../lib/profile/feature.ts";
import { hasSecretValues, redactSecrets } from "../../lib/profile/secrets.ts";

/** A JSON value with every string redacted; the same reference when nothing changed. */
function redactJson(value: unknown): unknown {
	if (typeof value === "string") return redactSecrets(value);
	if (Array.isArray(value)) {
		const next = value.map(redactJson);
		return next.some((item, i) => item !== value[i]) ? next : value;
	}
	if (value && typeof value === "object") {
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			next[key] = redactJson(item);
			changed ||= next[key] !== item;
		}
		return changed ? next : value;
	}
	return value;
}

function secretValuesExtension(pi: ExtensionAPI) {
	pi.on("tool_result", (event) => {
		if (!hasSecretValues()) return undefined;
		let changed = false;
		const content = event.content.map((part) => {
			if (part.type !== "text" || typeof part.text !== "string") return part;
			const text = redactSecrets(part.text);
			if (text === part.text) return part;
			changed = true;
			return { ...part, text };
		});
		// pi drops structured content that is not replaced along with the text.
		const structured = event.structuredContent === undefined ? undefined : redactJson(event.structuredContent);
		const structuredChanged = structured !== event.structuredContent;
		if (!changed && !structuredChanged) return undefined;
		return { content, ...(structured !== undefined ? { structuredContent: structured as never } : {}) };
	});
}

export default feature("secret-values", secretValuesExtension);
