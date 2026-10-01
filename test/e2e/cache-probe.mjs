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
 *      request — the H2 regression rewrote it.
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
 * Usage: node test/e2e/cache-probe.mjs <wire.jsonl> <events.jsonl> [--slack N] [--eager-load-ok]
 * Exit 1 on any failed check. `cache-probe.sh` produces both inputs.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
if (positional.length !== 2) {
	console.error("usage: cache-probe.mjs <wire.jsonl> <events.jsonl> [--slack N] [--eager-load-ok]");
	process.exit(2);
}
const slackIndex = args.indexOf("--slack");
const slack = slackIndex === -1 ? 0 : Number(args[slackIndex + 1] ?? 0);
const eagerLoadOk = args.includes("--eager-load-ok");

const lines = (path) =>
	readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l));

const dumped = lines(positional[0]);
const hasTools = (p) => Array.isArray(p?.tools) && p.tools.length > 0;
const sessionModel = dumped.find(hasTools)?.model;
const isSession = (p) => hasTools(p) && p.model === sessionModel;
const requests = dumped.filter(isSession);
const skipped = dumped.length - requests.length;
const usages = lines(positional[1])
	.filter((e) => e.type === "message_end" && e.message?.role === "assistant" && e.message.usage)
	.map((e) => e.message.usage);

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
const eagerTools = (p) => JSON.stringify(withoutCacheControl((p.tools ?? []).filter((t) => t?.defer_loading !== true)));

/** Index of the first differing char, for a readable pointer into a long string. */
const firstDiff = (a, b) => {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return i;
};

const checkStable = (label, pick, downgrade = false) => {
	const base = pick(requests[0]);
	for (let i = 1; i < requests.length; i++) {
		const cur = pick(requests[i]);
		if (cur === base) continue;
		const at = firstDiff(base, cur);
		const msg =
			`${label} changed between request 1 and request ${i + 1} ` +
			`(${base.length} → ${cur.length} chars; first difference at char ${at}: ` +
			`…${JSON.stringify(base.slice(at, at + 60))} vs …${JSON.stringify(cur.slice(at, at + 60))})`;
		(downgrade ? warnings : failures).push(msg);
		break;
	}
};

checkStable("system", systemText);
checkStable("conversation head (to the first user message)", conversationHead);
checkStable("eager tools", eagerTools, eagerLoadOk);

if (skipped > 0) console.log(`(${skipped} side-call request${skipped === 1 ? "" : "s"} skipped)`);
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

for (const w of warnings) console.log(`WARN  ${w}`);
for (const f of failures) console.log(`FAIL  ${f}`);
console.log(failures.length === 0 ? `PASS  prefix stable across ${requests.length} requests` : `FAILED  ${failures.length} check(s)`);
process.exit(failures.length === 0 ? 0 : 1);
