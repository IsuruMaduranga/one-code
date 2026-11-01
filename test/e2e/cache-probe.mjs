#!/usr/bin/env node
/**
 * Prompt-cache prefix check over one pi run (CACHE-REVIEW-2026-09-04 L3).
 *
 * Reads the requests `dump-requests.ts` wrote (one JSON payload per line) and
 * the `--mode json` event stream of the same run, and asserts what a healthy
 * prefix looks like. Three request shapes: Anthropic Messages (`system`,
 * `messages`), OpenAI Responses (`instructions`, `input`) and Chat
 * Completions (`messages` opening with a system message). Only the session's
 * own requests count: the model of the first request with tools; side
 * calls (the auto-mode classifier, a reader model) are dumped too and skipped.
 *
 *   1. `system`/`instructions` is byte-identical across every request.
 *   2. The head of the conversation, every item up to and including the first
 *      user message (its reminder stack), is byte-identical across every
 *      request — the H2 regression rewrote it. A request whose response
 *      errored (stopReason "error", e.g. "servers overloaded") cached nothing,
 *      so the head compares from the first request that did not error: a
 *      one-shot that arrived meanwhile legitimately rides message 1.
 *      pi's `cache_control` markers are stripped first: the breakpoint sits on
 *      the last user block in request 1 and moves to the tool result after,
 *      which is placement, not content.
 *   3. The eager tools (every entry without `defer_loading: true`) are identical
 *      in order and schema — `--eager-load-ok` downgrades this to a warning for
 *      models without tool references, where a tool_search load legitimately
 *      grows the array (findings §7).
 *   4. Request N+1 reads at least what request N had cached:
 *      cacheRead[N+1] >= cacheRead[N] + cacheWrite[N] - slack (default 0; the
 *      probe numbers in the review were exact). A provider that caches
 *      implicitly reports no writes (DeepSeek through OpenRouter); when no
 *      request of the run reports one, the floor is everything request N sent,
 *      input + cacheRead, less one cache block (IMPLICIT_BLOCK) for the
 *      provider's rounding.
 *
 *   5. Tool declarations, wherever the request keeps them: top-level `tools`,
 *      Responses `additional_tools` items (pi 1.4.0 puts the starting tools in
 *      one at `input[0]` for models flagged for mid-conversation system
 *      messages and additional tools) and `tool_search_output` items. The set
 *      of declared names never shrinks from one request to the next, no name
 *      is declared twice in one request, and a tool `tool_search` loaded is
 *      declared in every request from the one carrying that load's result.
 *   6. The system prompt is sent once per request: request 1's prompt
 *      (`system`, `instructions`, or the list's first system or developer
 *      message) appears once, never again further down the list.
 *
 *   7. With `--late-tool NAME` (cache-probe-late-tool.sh): NAME is absent from
 *      request 1, rides every later request's `tools` as `defer_loading: true`
 *      once it appears, and is announced either by a reference-form
 *      `tool_addition` in a system message or by the deferred-tool addendum.
 *      `--late-tool-form tool_addition|addendum` also requires that form.
 *
 * Usage: node test/e2e/cache-probe.mjs <wire.jsonl> <events.jsonl> [--slack N] [--eager-load-ok]
 *          [--late-tool NAME [--late-tool-form tool_addition|addendum]]
 * Exit 1 on any failed check. `cache-probe.sh` produces both inputs.
 */
import { readFileSync } from "node:fs";

const USAGE =
	"usage: cache-probe.mjs <wire.jsonl> <events.jsonl> [--slack N] [--eager-load-ok] [--late-tool NAME [--late-tool-form tool_addition|addendum]]";
const VALUE_FLAGS = new Set(["--slack", "--late-tool", "--late-tool-form"]);
const args = process.argv.slice(2);
const positional = [];
const flags = new Map();
for (let i = 0; i < args.length; i++) {
	if (VALUE_FLAGS.has(args[i])) flags.set(args[i], args[++i]);
	else if (args[i].startsWith("--")) flags.set(args[i], true);
	else positional.push(args[i]);
}
const lateToolForm = flags.get("--late-tool-form");
if (positional.length !== 2 || [...flags.values()].includes(undefined) || (lateToolForm !== undefined && !["tool_addition", "addendum"].includes(lateToolForm))) {
	console.error(USAGE);
	process.exit(2);
}
const slack = Number(flags.get("--slack") ?? 0);
const eagerLoadOk = flags.has("--eager-load-ok");
const lateTool = flags.get("--late-tool");

const lines = (path) =>
	readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l));

const dumped = lines(positional[0]);

/** A request's conversation list in any of the three shapes. */
const listOf = (p) => (Array.isArray(p?.input) ? p.input : Array.isArray(p?.messages) ? p.messages : []);
/** A tool entry's name in the Anthropic/Responses (`name`) or Chat Completions (`function.name`) shape. */
const toolNameOf = (t) => (typeof t?.name === "string" ? t.name : typeof t?.function?.name === "string" ? t.function.name : undefined);
/**
 * Every tool name a request declares, once per declaration, wherever it sits:
 * top-level `tools` (deferred entries included), and the Responses
 * `additional_tools` and `tool_search_output` items in the list.
 */
const declaredNames = (p) => {
	const names = (Array.isArray(p?.tools) ? p.tools : []).map(toolNameOf);
	for (const item of listOf(p)) {
		if ((item?.type === "additional_tools" || item?.type === "tool_search_output") && Array.isArray(item.tools)) names.push(...item.tools.map(toolNameOf));
	}
	return names.filter((name) => name !== undefined);
};
const hasTools = (p) => declaredNames(p).length > 0;
const sessionModel = dumped.find(hasTools)?.model;
const isSession = (p) => hasTools(p) && p.model === sessionModel;
const requests = dumped.filter(isSession);
const skipped = dumped.length - requests.length;
const responses = lines(positional[1])
	.filter((e) => e.type === "message_end" && e.message?.role === "assistant" && e.message.usage)
	.map((e) => e.message);
const usages = responses.map((m) => m.usage);
/** Whether request i's response errored; only knowable when every request has a response. */
const isErrored = (i) => responses.length === requests.length && responses[i].stopReason === "error";

/** Implicit caches store whole blocks (OpenAI 128 tokens, DeepSeek 64); allow one partial block of 256. */
const IMPLICIT_BLOCK = 256;
/**
 * A provider caches implicitly when no request of the run reports a write.
 * Decided for the whole run: one explicit-cache request that happens to write
 * nothing must not switch to the implicit floor.
 */
const implicitCache = usages.every((u) => (u.cacheWrite ?? 0) === 0);
/** The cached tokens request `i` must read, from what request `i - 1` sent. */
const readFloor = (prev) =>
	implicitCache ? (prev.input ?? 0) + (prev.cacheRead ?? 0) - IMPLICIT_BLOCK - slack : (prev.cacheRead ?? 0) + (prev.cacheWrite ?? 0) - slack;

const failures = [];
const warnings = [];

if (requests.length < 2) failures.push(`only ${requests.length} request(s) dumped; a prefix check needs at least two`);

/** The value with every `cache_control` marker removed — breakpoints move, bytes must not. */
const withoutCacheControl = (value) => {
	if (Array.isArray(value)) return value.map(withoutCacheControl);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([k]) => k !== "cache_control")
				.map(([k, v]) => [k, withoutCacheControl(v)]),
		);
	}
	return value;
};
const systemText = (p) => JSON.stringify(withoutCacheControl(p.system ?? p.instructions ?? null));
/** Every item up to and including the first user message: the cached head of the conversation. */
const conversationHead = (p) => {
	const items = p.messages ?? p.input ?? [];
	const firstUser = items.findIndex((item) => item?.role === "user");
	return JSON.stringify(withoutCacheControl(firstUser === -1 ? null : items.slice(0, firstUser + 1)));
};
/** The eager tools the head declares: top-level entries without `defer_loading`, plus a leading `additional_tools` item's. */
const eagerTools = (p) => {
	const head = listOf(p)[0];
	const leading = head?.type === "additional_tools" && Array.isArray(head.tools) ? head.tools : [];
	return JSON.stringify(withoutCacheControl([...(p.tools ?? []), ...leading].filter((t) => t?.defer_loading !== true)));
};

/** Index of the first differing char, for a readable pointer into a long string. */
const firstDiff = (a, b) => {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return i;
};

const checkStable = (label, pick, { downgrade = false, skipErrored = false } = {}) => {
	const indices = requests.map((_, i) => i).filter((i) => !(skipErrored && isErrored(i)));
	// Every request erroring leaves nothing to compare, which must not read as stable.
	if (indices.length < 2 && requests.length >= 2 && skipErrored) {
		failures.push(`${label}: only ${indices.length} of ${requests.length} requests finished without an error, too few to compare`);
		return;
	}
	if (indices.length === 0) return;
	const first = indices[0];
	const base = pick(requests[first]);
	for (const i of indices.slice(1)) {
		const cur = pick(requests[i]);
		if (cur === base) continue;
		const at = firstDiff(base, cur);
		const msg =
			`${label} changed between request ${first + 1} and request ${i + 1} ` +
			`(${base.length} → ${cur.length} chars; first difference at char ${at}: ` +
			`…${JSON.stringify(base.slice(at, at + 60))} vs …${JSON.stringify(cur.slice(at, at + 60))})`;
		(downgrade ? warnings : failures).push(msg);
		break;
	}
};

checkStable("system", systemText);
checkStable("conversation head (to the first user message)", conversationHead, { skipErrored: true });
checkStable("eager tools", eagerTools, { downgrade: eagerLoadOk });

// 5. Declarations: never shrink, never doubled, a loaded tool stays declared.
const declaredSets = requests.map((p) => new Set(declaredNames(p)));
requests.forEach((p, i) => {
	const names = declaredNames(p);
	const doubled = [...new Set(names.filter((name, at) => names.indexOf(name) !== at))];
	if (doubled.length > 0) failures.push(`request ${i + 1} declares ${doubled.join(", ")} more than once`);
	if (i > 0) {
		const lost = [...declaredSets[i - 1]].filter((name) => !declaredSets[i].has(name));
		if (lost.length > 0) failures.push(`request ${i + 1} no longer declares ${lost.join(", ")}, which request ${i} declared`);
	}
});
/** A wire call id: pi sends Responses ids as `<call_id>|<item_id>`. */
const wireCallId = (id) => String(id).split("|")[0];
/** Whether request p carries the result of tool call `callId` (Responses output, Anthropic tool_result, Completions tool message). */
const carriesResult = (p, callId) =>
	listOf(p).some(
		(item) =>
			item?.call_id === callId ||
			item?.tool_call_id === callId ||
			(Array.isArray(item?.content) && item.content.some((block) => block?.type === "tool_result" && block.tool_use_id === callId)),
	);
const toolLoads = lines(positional[1])
	.filter((e) => e.type === "tool_execution_end" && e.toolName === "tool_search" && Array.isArray(e.result?.details?.added))
	.map((e) => ({ callId: wireCallId(e.toolCallId), added: e.result.details.added }));
for (const load of toolLoads) {
	const from = requests.findIndex((p) => carriesResult(p, load.callId));
	if (from === -1) continue;
	for (let i = from; i < requests.length; i++) {
		const missing = load.added.filter((name) => !declaredSets[i].has(name));
		if (missing.length > 0) failures.push(`request ${i + 1} carries the tool_search load of ${missing.join(", ")} but does not declare it`);
	}
}

// 6. The system prompt once per request.
const asJson = (value) => JSON.stringify(withoutCacheControl(value));
const isInstruction = (item) => (item?.role === "system" || item?.role === "developer") && item.type === undefined;
const promptOf = (p) => {
	if (p.system !== undefined) return { field: "system", text: asJson(p.system) };
	if (p.instructions !== undefined) return { field: "instructions", text: asJson(p.instructions) };
	const first = listOf(p).find(isInstruction);
	return first ? { field: undefined, text: asJson(first.content) } : undefined;
};
const prompt = requests[0] ? promptOf(requests[0]) : undefined;
if (prompt) {
	requests.forEach((p, i) => {
		const inField = prompt.field !== undefined && asJson(p[prompt.field]) === prompt.text ? 1 : 0;
		const inList = listOf(p).filter((item) => isInstruction(item) && asJson(item.content) === prompt.text).length;
		if (inField + inList > 1) failures.push(`request ${i + 1} sends the system prompt ${inField + inList} times`);
	});
}

if (skipped > 0) console.log(`(${skipped} side-call request${skipped === 1 ? "" : "s"} skipped)`);
const erroredCount = requests.filter((_, i) => isErrored(i)).length;
if (erroredCount > 0) console.log(`(${erroredCount} errored request${erroredCount === 1 ? "" : "s"} left out of the head check)`);
if (usages.length !== requests.length) {
	warnings.push(`${requests.length} requests dumped but ${usages.length} assistant usages seen (retry or a request that did not complete?)`);
}

console.log("request  input  cacheRead  cacheWrite  expected>=");
for (let i = 0; i < usages.length; i++) {
	const u = usages[i];
	const expected = i === 0 ? "-" : String(readFloor(usages[i - 1]));
	console.log(
		`${String(i + 1).padStart(7)}  ${String(u.input ?? 0).padStart(5)}  ${String(u.cacheRead ?? 0).padStart(9)}  ${String(u.cacheWrite ?? 0).padStart(10)}  ${expected.padStart(10)}`,
	);
	if (i > 0) {
		const need = readFloor(usages[i - 1]);
		if ((u.cacheRead ?? 0) < need) {
			failures.push(`request ${i + 1} read ${u.cacheRead ?? 0} cached tokens; it should have read at least ${need} of what request ${i} sent (miss of ${need - (u.cacheRead ?? 0)} tokens)`);
		}
	}
}

/** The first line of the deferred-tool addendum (lib/tool-additions.ts ADDENDUM_HEAD). */
const ADDENDUM_START = "Additional deferred tools became available via tool_search";

if (lateTool !== undefined) {
	const entryIn = (p) => (p.tools ?? []).find((t) => t?.name === lateTool);
	const firstWith = requests.findIndex((p) => entryIn(p) !== undefined);
	const additionIn = (p) =>
		(p.messages ?? []).some(
			(m) => m?.role === "system" && Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_addition" && b.tool?.name === lateTool),
		);
	// The addendum lists the names one per line after its first line.
	const addendumIn = (p) => (p.messages ?? []).some((m) => JSON.stringify(m.content ?? "").includes(ADDENDUM_START) && JSON.stringify(m.content).includes(`\\n${lateTool}`));
	const form = requests.some(additionIn) ? "tool_addition" : requests.some(addendumIn) ? "addendum" : undefined;
	const called = responses.some((m) => (m.content ?? []).some((c) => c?.type === "toolCall" && c.name === lateTool));
	console.log(`late tool ${lateTool}: first in request ${firstWith === -1 ? "none" : firstWith + 1}, announced by ${form ?? "nothing"}, ${called ? "called" : "not called"}`);
	if (firstWith === 0) failures.push(`${lateTool} was already in request 1; the fixture registered it too early to test a late arrival`);
	else if (firstWith === -1) failures.push(`${lateTool} never reached a request's tools`);
	else {
		const eager = requests.slice(firstWith).findIndex((p) => entryIn(p)?.defer_loading !== true);
		if (eager !== -1) failures.push(`${lateTool} went out without defer_loading in request ${firstWith + eager + 1}; an eager late tool re-caches the conversation`);
	}
	if (form === undefined) failures.push(`${lateTool} was never announced, by tool_addition or by the addendum`);
	else if (lateToolForm !== undefined && form !== lateToolForm) failures.push(`${lateTool} was announced by ${form}, expected ${lateToolForm}`);
	if (!called) warnings.push(`the model never called ${lateTool}`);
}

for (const w of warnings) console.log(`WARN  ${w}`);
for (const f of failures) console.log(`FAIL  ${f}`);
console.log(failures.length === 0 ? `PASS  prefix stable across ${requests.length} requests` : `FAILED  ${failures.length} check(s)`);
process.exit(failures.length === 0 ? 0 : 1);
