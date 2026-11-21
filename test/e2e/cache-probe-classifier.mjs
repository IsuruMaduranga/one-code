#!/usr/bin/env node
/**
 * Auto-mode classifier cache check over one pi run (cache-probe.sh's
 * classifier phase). Reads the log the classifier writes under
 * ONECODE_AUTO_MODE_LOG (safety/permissions/auto-mode/classifier.ts): one line per classifier reply
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
 *      are never written). OpenAI Responses with breakpoints on the history
 *      (the log row's `cacheMarks`, the history parts the classifier marked;
 *      GPT-5.6 and later): at least request N's marked history (the row's
 *      `systemChars` plus `markedHistoryChars`, its system prompt and the
 *      transcript up to the last marked part; `historyChars`, the transcript
 *      up to the pending action, on a row without it), estimated as that share
 *      of its tokens, less one cache block; a miss is a FAIL. A request without history breakpoints
 *      (its hook left the payload alone, `cacheEdited` false, or its model
 *      has no hook), and the request after it, are checked as an implicit
 *      cache, with a WARN. A skipped request's implicit
 *      breakpoint also writes the action and stage text, which no later
 *      request repeats, so read + write overshoots there.
 *      Implicit caches (Codex, OpenRouter): at least the share of request N's
 *      prompt that request N+1 repeats, less one cache block; a miss there is a
 *      WARN, since OpenRouter can route consecutive calls to different upstream
 *      providers. On OpenRouter each line names the call's serving host, looked
 *      up from the row's `responseId` (cache-hosts.mjs), and a host measured to
 *      read in larger blocks may fall one of its blocks short when the read is
 *      a whole number of them.
 *
 * With `--review` (cache-probe.sh's review phase) the log must also hold a
 * subagent's hand-back review (a row whose tool is `subagent-review`) after at
 * least one earlier call, so check 3 covers the review reading the
 * cache its spawn and the child's calls wrote.
 *
 * A log written before the classifier logged its cache hook has neither
 * `cacheBreakpoints` nor `cacheMarks`; its rows are checked under the implicit
 * rule.
 *
 * Usage: node test/e2e/cache-probe-classifier.mjs <classifier.jsonl> [--slack N] [--review]
 * Exit 1 on a failed check.
 */
import { readFileSync } from "node:fs";
import { allowance, hostNote, hostsNote, lookupHosts } from "./cache-hosts.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
	console.error("usage: cache-probe-classifier.mjs <classifier.jsonl> [--slack N] [--review]");
	process.exit(2);
}
const slackIndex = args.indexOf("--slack");
const slack = slackIndex === -1 ? 0 : Number(args[slackIndex + 1] ?? 0);

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
if (args.includes("--review")) {
	const at = rows.findIndex((r) => r.tool === "subagent-review");
	if (at < 1) failures.push(at === -1 ? "no hand-back review was recorded; did the model call the Agent tool, and did the child make a gated call?" : "the hand-back review is the first classifier call; nothing before it to read from");
}
if (rows.length < 2) failures.push(`only ${rows.length} classifier request(s) recorded; the check needs at least two gated calls`);

const calls = rows.map((r) => {
	const u = r.usage ?? {};
	// Explicit breakpoints: Anthropic Messages, Bedrock Converse, and Claude on
	// OpenRouter (Chat Completions carrying Anthropic's cache_control).
	const explicit = r.api === "anthropic-messages" || r.api === "bedrock-converse-stream" || (r.api === "openai-completions" && /^openrouter\/anthropic\//.test(r.model ?? ""));
	const historyMarks = r.api === "openai-responses" && r.cacheMarks > 0;
	const read = u.cacheRead ?? 0;
	return {
		text: r.system + r.user,
		system: r.system,
		user: r.user,
		explicit,
		historyMarks,
		skipped: r.cacheBreakpoints === true && r.cacheEdited === false,
		// Past MAX_RESPONSES_HISTORY_MARKS only the marked parts are cached; an older row lacks the field.
		history: (r.systemChars ?? 0) + (r.markedHistoryChars ?? r.historyChars ?? 0),
		read,
		write: u.cacheWrite ?? 0,
		total: (u.input ?? 0) + read + (u.cacheWrite ?? 0),
		responseId: r.responseId,
	};
});
const hosts = await lookupHosts(calls.map((c) => c.responseId));
const hostOf = (c) => hosts.get(c?.responseId);
const explicit = calls.some((c) => c.explicit);
const historyMarks = !explicit && calls.some((c) => c.historyMarks);

console.log(`classifier model: ${rows[0]?.model ?? "?"} (${explicit ? "explicit" : historyMarks ? "history breakpoints" : "implicit"} cache)`);
// The per-pair warnings below need one marked call in the phase; a hook that
// left every payload alone would otherwise read as a plain implicit cache.
const skippedAll = calls.filter((c) => c.skipped).length;
if (!explicit && !historyMarks && skippedAll > 0) warnings.push(`the classifier's cache hook ran on ${skippedAll} call(s) but left every payload unmarked (a blank part or an unexpected shape); the calls are checked as an implicit cache`);
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
		// Only a marked request after a marked one is held to the marked
		// history: a request without breakpoints (its hook left it alone, or
		// its model has no hook) cannot read the marked prefix, and the one
		// after it has none to read back to.
		const marked = historyMarks && prev.historyMarks && cur.historyMarks;
		if (historyMarks && prev.skipped) warnings.push(`classifier call ${i} had the cache hook but its payload was left alone (a blank part or an unexpected shape); call ${i + 1} is checked as an implicit cache`);
		if (historyMarks && cur.skipped) warnings.push(`classifier call ${i + 1} had the cache hook but it left this request unmarked (a blank part or an unexpected shape); it is checked as an implicit cache`);
		need = explicit
			? prev.read + prev.write - slack
			: Math.floor((prev.total * (marked ? prev.history : firstDiff(prev.text, cur.text))) / prev.text.length) - allowance(hostOf(cur), cur.read) - slack;
		if (cur.read < need) {
			const msg = `classifier call ${i + 1} read ${cur.read} cached tokens; it should have read at least ${need} of what call ${i} sent (miss of ${need - cur.read})${hostNote(hostOf(cur))}`;
			(explicit || marked ? failures : warnings).push(msg);
		}
	}
	console.log(`${String(i + 1).padStart(4)}  ${String(cur.total).padStart(6)}  ${String(cur.read).padStart(9)}  ${String(cur.write).padStart(10)}  ${String(need ?? "-").padStart(10)}${hostNote(hostOf(cur))}`);
}

const phaseHosts = hostsNote(calls.map(hostOf));
const withHosts = (line) => (line.includes(" [host ") ? line : `${line}${phaseHosts}`);
for (const w of warnings) console.log(`WARN  ${withHosts(w)}`);
for (const f of failures) console.log(`FAIL  ${withHosts(f)}`);
console.log(failures.length === 0 ? `PASS  classifier transcript cached across ${calls.length} requests${phaseHosts}` : `FAILED  ${failures.length} classifier check(s)${phaseHosts}`);
process.exit(failures.length === 0 ? 0 : 1);
