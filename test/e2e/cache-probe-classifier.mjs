#!/usr/bin/env node
/**
 * Auto-mode classifier cache check over one pi run (cache-probe.sh's
 * classifier phase). Reads the log the classifier writes under
 * CC_AUTO_MODE_LOG (auto-mode/classifier.ts): one line per classifier reply
 * with its system and user text and pi-ai's normalized usage, in call order
 * (stage 1 and stage 2 of one gated call are consecutive lines). Being written
 * by the classifier itself, it covers every transport, Codex's WebSocket
 * included.
 *
 *   1. The system prompt (the ruleset) is byte-identical across requests.
 *   2. The transcript only grows: each request's text up to its `</transcript>`
 *      starts with the previous request's transcript minus its closing tag.
 *   3. Each request reads what the previous one cached. Explicit caches
 *      (Anthropic, Bedrock, Claude on OpenRouter): cacheRead[N+1] >= cacheRead[N] + cacheWrite[N] - slack,
 *      which holds when the breakpoint sits on the transcript history and not
 *      after the stage instruction (the stage text and the action under review
 *      are never written). Implicit caches (OpenAI, OpenRouter): at least the
 *      share of request N's prompt that request N+1 repeats, less one cache
 *      block; a miss there is a WARN, since OpenRouter can route consecutive
 *      calls to different upstream providers.
 *
 * Usage: node test/e2e/cache-probe-classifier.mjs <classifier.jsonl> [--slack N]
 * Exit 1 on a failed check.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
	console.error("usage: cache-probe-classifier.mjs <classifier.jsonl> [--slack N]");
	process.exit(2);
}
const slackIndex = args.indexOf("--slack");
const slack = slackIndex === -1 ? 0 : Number(args[slackIndex + 1] ?? 0);
const IMPLICIT_BLOCK = 256;

const rows = readFileSync(file, "utf8")
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l))
	.filter((r) => r.stopReason !== "error" && r.stopReason !== "aborted");

const firstDiff = (a, b) => {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return i;
};

const failures = [];
const warnings = [];
if (rows.length < 2) failures.push(`only ${rows.length} classifier request(s) recorded; the check needs at least two gated calls`);

const calls = rows.map((r) => {
	const u = r.usage ?? {};
	// Explicit breakpoints: Anthropic Messages, Bedrock Converse, and Claude on
	// OpenRouter (Chat Completions carrying Anthropic's cache_control).
	const explicit = r.api === "anthropic-messages" || r.api === "bedrock-converse-stream" || (r.api === "openai-completions" && /^openrouter\/anthropic\//.test(r.model ?? ""));
	const read = u.cacheRead ?? 0;
	return { text: r.system + r.user, system: r.system, user: r.user, explicit, read, write: u.cacheWrite ?? 0, total: (u.input ?? 0) + read + (u.cacheWrite ?? 0) };
});
const explicit = calls.some((c) => c.explicit);

console.log(`classifier model: ${rows[0]?.model ?? "?"} (${explicit ? "explicit" : "implicit"} cache)`);
console.log("call   total   cacheRead  cacheWrite  expected>=");
for (let i = 0; i < calls.length; i++) {
	const cur = calls[i];
	const prev = calls[i - 1];
	let need;
	if (prev) {
		if (cur.system !== prev.system) failures.push(`system prompt changed between classifier calls ${i} and ${i + 1}`);
		const prevTranscript = prev.user.slice(0, Math.max(0, prev.user.indexOf("</transcript>")));
		if (prevTranscript && !cur.user.startsWith(prevTranscript)) {
			const at = firstDiff(prevTranscript, cur.user);
			failures.push(`transcript of call ${i + 1} does not extend call ${i}'s (first difference at char ${at}: …${JSON.stringify(prevTranscript.slice(at, at + 60))})`);
		}
		need = explicit
			? prev.read + prev.write - slack
			: Math.floor((prev.total * firstDiff(prev.text, cur.text)) / prev.text.length) - IMPLICIT_BLOCK - slack;
		if (cur.read < need) {
			const msg = `classifier call ${i + 1} read ${cur.read} cached tokens; it should have read at least ${need} of what call ${i} sent (miss of ${need - cur.read})`;
			(explicit ? failures : warnings).push(msg);
		}
	}
	console.log(`${String(i + 1).padStart(4)}  ${String(cur.total).padStart(6)}  ${String(cur.read).padStart(9)}  ${String(cur.write).padStart(10)}  ${String(need ?? "-").padStart(10)}`);
}

for (const w of warnings) console.log(`WARN  ${w}`);
for (const f of failures) console.log(`FAIL  ${f}`);
console.log(failures.length === 0 ? `PASS  classifier transcript cached across ${calls.length} requests` : `FAILED  ${failures.length} classifier check(s)`);
process.exit(failures.length === 0 ? 0 : 1);
