/**
 * Reader side-call cache probe. The driver writes one CC_SIDE_CALL_LOG JSONL
 * row per completed reader attempt and the pi JSON event stream records the
 * two outer web_fetch calls. The reader's system prompt is intentionally
 * short, so this proves repeated reads of one page only. It does not claim
 * that different pages share a useful cached prefix.
 *
 * Usage: node test/e2e/cache-probe-reader.mjs <side-calls.jsonl> <events.jsonl> [--short]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const READER_PROBE_LONG_URL = "https://handbook.example.com/editorial-guide";
export const READER_PROBE_SHORT_URL = "https://handbook.example.com/editorial-guide-short";
export const READER_PROBE_QUESTION = "What does section 12 require before publication?";

const IMPLICIT_BLOCK = 256;
const DEFAULT_CACHE_MINIMUM = 1024;
const HAIKU_CACHE_MINIMUM = 4096;
const IMPLICIT_APIS = new Set(["openai-responses", "openai-codex-responses", "openai-completions"]);

function cacheMinimum(row) {
	// Anthropic's Haiku 4.5 cache minimum is 4,096 tokens; Sonnet uses 1,024.
	return row.api === "anthropic-messages" && row.model.slice(row.model.indexOf("/") + 1).toLowerCase().includes("haiku")
		? HAIKU_CACHE_MINIMUM
		: DEFAULT_CACHE_MINIMUM;
}

function number(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function firstDiff(a, b) {
	let index = 0;
	while (index < a.length && index < b.length && a[index] === b[index]) index++;
	return index;
}

function toolFailures(events, short) {
	const failures = [];
	if (!Array.isArray(events) || events.length === 0) {
		return ["no pi JSON events recorded; cannot prove web_fetch ran"];
	}
	const starts = events
		.map((event, index) => ({ event, index }))
		.filter(({ event }) => event?.type === "tool_execution_start" && event.toolName === "web_fetch");
	const ends = events
		.map((event, index) => ({ event, index }))
		.filter(({ event }) => event?.type === "tool_execution_end" && event.toolName === "web_fetch");
	if (starts.length !== 2) failures.push(`expected exactly 2 web_fetch starts, found ${starts.length}`);
	if (ends.length !== 2) failures.push(`expected exactly 2 web_fetch results, found ${ends.length}`);

	const expectedUrl = short ? READER_PROBE_SHORT_URL : READER_PROBE_LONG_URL;
	for (const [call, start] of starts.entries()) {
		const args = start.event.args ?? {};
		if (args.url !== expectedUrl) failures.push(`web_fetch call ${call + 1} used ${JSON.stringify(args.url)}, not ${JSON.stringify(expectedUrl)}`);
		if (args.prompt !== READER_PROBE_QUESTION) failures.push(`web_fetch call ${call + 1} changed the reader question`);
		const end = ends.find(({ event }) => event.toolCallId === start.event.toolCallId);
		if (!end) {
			failures.push(`web_fetch call ${call + 1} has no matching result`);
			continue;
		}
		if (end.index <= start.index) failures.push(`web_fetch call ${call + 1} completed before it started`);
		if (end.event.result?.isError || end.event.isError) failures.push(`web_fetch call ${call + 1} returned an error`);
		if (call > 0) {
			const previous = starts[call - 1];
			const previousEnd = ends.find(({ event }) => event.toolCallId === previous.event.toolCallId);
			if (!previousEnd || start.index <= previousEnd.index) failures.push("the second web_fetch started before the first completed");
		}
	}
	if (events.some((event) => event?.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error")) {
		failures.push("the outer model returned an error");
	}
	return failures;
}

function readerFailures(readers) {
	const failures = [];
	if (readers.length !== 2) failures.push(`expected exactly 2 completed reader attempts, found ${readers.length}`);
	for (const [index, row] of readers.entries()) {
		const call = index + 1;
		if (row?.stopReason === "error" || row?.stopReason === "aborted") failures.push(`reader call ${call} stopped with ${row.stopReason}`);
		if (typeof row?.stopReason !== "string" || row.stopReason.length === 0) failures.push(`reader call ${call} lacks a stop reason`);
		if (typeof row?.model !== "string" || !row.model.includes("/")) failures.push(`reader call ${call} lacks a provider/id model`);
		if (typeof row?.api !== "string" || !row.api) failures.push(`reader call ${call} lacks an API name`);
		if (typeof row?.sessionId !== "string" || !row.sessionId.endsWith(":reader")) failures.push(`reader call ${call} lacks the :reader cache key`);
		if (typeof row?.system !== "string") failures.push(`reader call ${call} lacks system text`);
		if (!Array.isArray(row?.messages) || row.messages.length !== 1 || row.messages[0]?.role !== "user" || typeof row.messages[0]?.content !== "string") {
			failures.push(`reader call ${call} must record exactly one user message`);
		}
		const usage = row?.usage;
		for (const field of ["input", "cacheRead", "cacheWrite"]) {
			if (number(usage?.[field]) === undefined) failures.push(`reader call ${call} has no usable usage.${field}`);
		}
	}
	if (readers.length === 2) {
		const [first, second] = readers;
		for (const field of ["model", "api", "sessionId", "system"]) {
			if (first[field] !== second[field]) failures.push(`reader ${field} changed between calls`);
		}
		const firstUser = first.messages?.[0]?.content;
		const secondUser = second.messages?.[0]?.content;
		if (typeof firstUser === "string" && typeof secondUser === "string" && firstUser !== secondUser) {
			const at = firstDiff(firstUser, secondUser);
			failures.push(`reader user message changed between calls (first difference at char ${at})`);
		}
	}
	return failures;
}

/**
 * Check already-parsed evidence. `status` is `skip` only for --short below the
 * selected model's known cache floor or for an API whose cache accounting is
 * not implemented here; a skip never prints PASS. A reasoning retry is logged
 * as a completed attempt too, so any error row deliberately fails this probe
 * rather than being hidden as a successful two-call result.
 */
export function checkReaderProbe(rows, events, { short = false } = {}) {
	const readers = Array.isArray(rows) ? rows.filter((row) => row?.kind === "reader") : [];
	const failures = [...toolFailures(events, short), ...readerFailures(readers)];
	const lines = [];
	if (failures.length) return { status: "fail", failures, lines };

	const [first, second] = readers;
	const firstUsage = first.usage;
	const secondUsage = second.usage;
	const firstTotal = firstUsage.input + firstUsage.cacheRead + firstUsage.cacheWrite;
	const secondTotal = secondUsage.input + secondUsage.cacheRead + secondUsage.cacheWrite;
	const api = first.api;
	lines.push(`reader model: ${first.model} (${api})`);
	lines.push("call   total   cacheRead  cacheWrite  expected>=");
	lines.push(`   1  ${String(firstTotal).padStart(6)}  ${String(firstUsage.cacheRead).padStart(9)}  ${String(firstUsage.cacheWrite).padStart(10)}           -`);

	if (api !== "anthropic-messages" && !IMPLICIT_APIS.has(api)) {
		lines.push(`SKIP  cache accounting for API ${api} is unsupported; this is not a cache PASS.`);
		return { status: "skip", failures: [], lines };
	}
	const minimum = cacheMinimum(first);
	if (short && firstTotal < minimum && secondTotal < minimum) {
		lines.push(`SKIP  --short produced ${firstTotal}/${secondTotal} prompt tokens, below ${first.model}'s known ${minimum}-token cache minimum.`);
		return { status: "skip", failures: [], lines };
	}
	if (firstTotal < minimum || secondTotal < minimum) {
		return {
			status: "fail",
			failures: [`reader prompt is below ${first.model}'s ${minimum}-token cache minimum; rerun with the long fixture or explicitly use --short`],
			lines,
		};
	}

	const explicit = api === "anthropic-messages";
	const warnings = [];
	const expected = explicit ? firstUsage.cacheRead + firstUsage.cacheWrite : Math.max(minimum, firstTotal - IMPLICIT_BLOCK);
	lines.push(`   2  ${String(secondTotal).padStart(6)}  ${String(secondUsage.cacheRead).padStart(9)}  ${String(secondUsage.cacheWrite).padStart(10)}  ${String(expected).padStart(10)}`);
	if (expected <= 0) failures.push("the first Anthropic reader call reported no cache read or write evidence");
	if (secondUsage.cacheRead < expected) {
		// An implicit cache (OpenAI, Codex, OpenRouter) may reuse only part of an
		// identical prompt, or route it elsewhere: a warning, as in the classifier phase.
		(explicit ? failures : warnings).push(`reader call 2 read ${secondUsage.cacheRead} cached tokens; it should have read at least ${expected} from call 1 (miss of ${expected - secondUsage.cacheRead} tokens)`);
	}
	for (const warning of warnings) lines.push(`WARN  ${warning}`);
	return { status: failures.length ? "fail" : "pass", failures, lines };
}

function readJsonl(path) {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line, index) => {
			try {
				return JSON.parse(line);
			} catch (error) {
				throw new Error(`${path}:${index + 1} is not valid JSON: ${error.message}`);
			}
		});
}

export function runReaderProbe(argv = process.argv.slice(2)) {
	const short = argv.includes("--short");
	const positional = argv.filter((argument) => !argument.startsWith("--"));
	if (positional.length !== 2) {
		return { status: "fail", failures: ["usage: cache-probe-reader.mjs <side-calls.jsonl> <events.jsonl> [--short]"], lines: [], usage: true };
	}
	try {
		return checkReaderProbe(readJsonl(positional[0]), readJsonl(positional[1]), { short });
	} catch (error) {
		return { status: "fail", failures: [(error instanceof Error ? error.message : String(error))], lines: [] };
	}
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const result = runReaderProbe();
	for (const line of result.lines) console.log(line);
	for (const failure of result.failures) console.log(`FAIL  ${failure}`);
	if (result.status === "pass") console.log("PASS  reader cache warm for the repeated identical page");
	if (result.status === "skip") console.log("SKIP  reader cache was not measured");
	if (result.status === "fail") console.log(`FAILED  ${result.failures.length} check(s)`);
	process.exitCode = result.status === "fail" ? (result.usage ? 2 : 1) : 0;
}
