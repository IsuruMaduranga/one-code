#!/usr/bin/env node
/**
 * Prompt-cache prefix check over one pi run (CACHE-REVIEW-2026-09-04 L3).
 *
 * Reads the requests `dump-requests.ts` wrote (one JSON payload per line) and
 * the `--mode json` event stream of the same run, and asserts what a healthy
 * prefix looks like:
 *
 *   1. `system` is byte-identical across every request of the run.
 *   2. `messages[0]` (the first user message with its reminder stack) is
 *      byte-identical across every request — the H2 regression rewrote it.
 *      pi's `cache_control` markers are stripped first: the breakpoint sits on
 *      the last user block in request 1 and moves to the tool result after,
 *      which is placement, not content.
 *   3. The eager tools (every entry without `defer_loading: true`) are identical
 *      in order and schema — `--eager-load-ok` downgrades this to a warning for
 *      models without tool references, where a tool_search load legitimately
 *      grows the array (findings §7).
 *   4. Request N+1 reads at least what request N had cached:
 *      cacheRead[N+1] >= cacheRead[N] + cacheWrite[N] - slack (default 0; the
 *      probe numbers in the review were exact).
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

const requests = lines(positional[0]);
const usages = lines(positional[1])
	.filter((e) => e.type === "message_end" && e.message?.role === "assistant" && e.message.usage)
	.map((e) => e.message.usage);

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
const systemText = (p) => JSON.stringify(withoutCacheControl(p.system ?? null));
const firstMessage = (p) => JSON.stringify(withoutCacheControl(p.messages?.[0] ?? null));
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
checkStable("messages[0]", firstMessage);
checkStable("eager tools", eagerTools, eagerLoadOk);

if (usages.length !== requests.length) {
	warnings.push(`${requests.length} requests dumped but ${usages.length} assistant usages seen (retry or a request that did not complete?)`);
}

console.log("request  input  cacheRead  cacheWrite  expected>=");
for (let i = 0; i < usages.length; i++) {
	const u = usages[i];
	const expected = i === 0 ? "-" : String((usages[i - 1].cacheRead ?? 0) + (usages[i - 1].cacheWrite ?? 0) - slack);
	console.log(
		`${String(i + 1).padStart(7)}  ${String(u.input ?? 0).padStart(5)}  ${String(u.cacheRead ?? 0).padStart(9)}  ${String(u.cacheWrite ?? 0).padStart(10)}  ${expected.padStart(10)}`,
	);
	if (i > 0) {
		const need = (usages[i - 1].cacheRead ?? 0) + (usages[i - 1].cacheWrite ?? 0) - slack;
		if ((u.cacheRead ?? 0) < need) {
			failures.push(`request ${i + 1} read ${u.cacheRead ?? 0} cached tokens; request ${i} had cached ${need + slack} (miss of ${need - (u.cacheRead ?? 0)} tokens)`);
		}
	}
}

for (const w of warnings) console.log(`WARN  ${w}`);
for (const f of failures) console.log(`FAIL  ${f}`);
console.log(failures.length === 0 ? `PASS  prefix stable across ${requests.length} requests` : `FAILED  ${failures.length} check(s)`);
process.exit(failures.length === 0 ? 0 : 1);
