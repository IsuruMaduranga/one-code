/**
 * Classifier wire probe: append every auto-mode classifier request (a body
 * holding `<transcript>`) with the usage its streamed response reports, one
 * JSON line each, to the file CLASSIFIER_DUMP names. The classifier calls its
 * provider through `completeSimple`, outside the session's request hooks, and
 * its usage reaches only the cost bus, so the cache numbers come from the
 * response stream itself. Wraps `globalThis.fetch`, as dump-requests.ts does;
 * the response is teed, never altered.
 *
 *   CLASSIFIER_DUMP=/tmp/cls.jsonl pi -e test/e2e/dump-classifier.ts --permission-mode auto -p "…"
 *
 * Read by test/e2e/cache-probe-classifier.mjs (cache-probe.sh's classifier phase).
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The last value of a numeric JSON field in a streamed response, or undefined. */
function lastNumber(text: string, field: string): number | undefined {
	const all = [...text.matchAll(new RegExp(`"${field}"\\s*:\\s*(\\d+)`, "g"))];
	return all.length > 0 ? Number(all[all.length - 1][1]) : undefined;
}

export default function dumpClassifier(_pi: ExtensionAPI) {
	const file = process.env.CLASSIFIER_DUMP;
	if (!file) return;
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const body = typeof init?.body === "string" ? init.body : undefined;
		const response = await original(input, init);
		if (!body?.includes("<transcript>") || !response.body) return response;
		const [mine, theirs] = response.body.tee();
		void new Response(mine)
			.text()
			.then((text) => {
				const usage = {
					// Anthropic Messages
					inputTokens: lastNumber(text, "input_tokens"),
					cacheRead: lastNumber(text, "cache_read_input_tokens"),
					cacheWrite: lastNumber(text, "cache_creation_input_tokens"),
					// OpenAI Chat Completions / Responses
					promptTokens: lastNumber(text, "prompt_tokens"),
					cachedTokens: lastNumber(text, "cached_tokens"),
				};
				appendFileSync(file, `${JSON.stringify({ status: response.status, body, usage })}\n`);
			})
			.catch(() => {});
		return new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers });
	}) as typeof fetch;
}
