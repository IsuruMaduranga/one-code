#!/usr/bin/env node
/**
 * The append-only check over a transition-probe.mjs run. It asserts the
 * invariants of the record-once design (working-docs/features/lifecycle-grid-hunt/design.md
 * sections 5 and 12) on the session's own requests:
 *
 *   ok       no request errored (a 400 from an undeclared tool reference, a
 *            rejected beta combination, anything with stopReason "error").
 *   declared every tool_reference, tool_addition and tool_removal name in a
 *            request is a tool the same request declares.
 *   order    (Anthropic) a system message with content is followed by an
 *            assistant message or ends the array; only the directive-only
 *            form (empty content with output_config) may sit anywhere. A
 *            failed reply that pi omits leaves our mid-conversation system
 *            messages before the next user message: a 400 on every request after.
 *   once     no tool is announced as newly available twice in one request.
 *   head     inside an epoch, the system prompt is byte-identical to the base
 *            request's, and every tool the base declared is still declared,
 *            unchanged, with the eager tools in the same order.
 *   prefix   inside an epoch, the base request's messages are a byte-identical
 *            prefix of this request's messages.
 *   cache    inside an epoch, this request reads at least what the base had
 *            read and written, less END_TOKENS: a request's last cache entry
 *            holds about 25 tokens past its final block that only the
 *            identical request reads back (findings §73). Anthropic usage;
 *            skipped where the provider reports no cache writes.
 *
 * The base of a step's first request is the last request of the step named
 * by its `base` (the branch it extends); a later request in a step extends
 * the one before it; a base whose reply errored is not compared against. A step marked `epoch` opens a new epoch and is checked
 * only for ok and declared. Side calls (wire.meta.jsonl `session: false`) and
 * pi's cache warms (an output cap of 1) are skipped. Cache markers are
 * stripped before comparing: their placement moves every request.
 *
 *   node test/e2e/transition-check.mjs <probe work dir>
 * Exit 1 on any failure.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const work = process.argv[2];
if (!work) {
	console.error("usage: transition-check.mjs <probe work dir>");
	process.exit(2);
}
const lines = (path) => readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const { steps } = JSON.parse(readFileSync(join(work, "steps.json"), "utf8"));
const wire = lines(join(work, "wire.jsonl"));
const meta = lines(join(work, "wire.meta.jsonl"));
if (meta.length !== wire.length) console.log(`WARN wire.jsonl has ${wire.length} lines, wire.meta.jsonl ${meta.length}`);

/** The tokens past a request's final block its cache entry holds and a longer request cannot read (findings §73: 25 on Sonnet 5.5). */
const END_TOKENS = 32;

/** A pi cache warm: the same body with the output cap at 1, top-level or nested (Bedrock, Google). */
const isWarm = (body) =>
	[body.max_tokens, body.max_output_tokens, body.max_completion_tokens, body.maxTokens, body.inferenceConfig?.maxTokens, body.config?.maxOutputTokens, body.generationConfig?.maxOutputTokens].includes(1);

/** The parts of a request the checks compare, in the request's own dialect. */
function shape(body) {
	if (Array.isArray(body.input)) return { system: body.instructions ?? null, tools: body.tools ?? [], messages: body.input };
	if (body.system !== undefined || body.anthropic_version !== undefined || Array.isArray(body.messages) && body.messages.every((m) => m.role !== "system" && m.role !== "developer")) {
		return { system: body.system ?? null, tools: body.tools ?? [], messages: body.messages ?? [] };
	}
	const messages = body.messages ?? [];
	const head = messages[0]?.role === "system" || messages[0]?.role === "developer" ? messages[0] : null;
	return { system: head, tools: body.tools ?? [], messages: head ? messages.slice(1) : messages };
}

function strip(value) {
	if (Array.isArray(value)) return value.map(strip);
	if (value && typeof value === "object") {
		const out = {};
		for (const [key, inner] of Object.entries(value)) if (key !== "cache_control" && key !== "cachePoint") out[key] = strip(inner);
		return out;
	}
	return value;
}
const same = (a, b) => JSON.stringify(strip(a)) === JSON.stringify(strip(b));
const toolName = (tool) => tool?.name ?? tool?.function?.name ?? tool?.toolSpec?.name;
const deferred = (tool) => tool?.defer_loading === true;

/** Every name a tool_reference / tool_addition / tool_removal block refers to. */
function referencedNames(value, out = new Set()) {
	if (Array.isArray(value)) for (const item of value) referencedNames(item, out);
	else if (value && typeof value === "object") {
		if (["tool_reference", "tool_addition", "tool_removal"].includes(value.type)) {
			const name = value.tool_name ?? value.name ?? value.tool?.name;
			if (typeof name === "string") out.add(name);
		}
		for (const inner of Object.values(value)) referencedNames(inner, out);
	}
	return out;
}

/** How many times each tool name is announced as newly available (a tool_addition block or the deferred-tool addendum). */
function announcements(messages) {
	const counts = new Map();
	const bump = (name) => counts.set(name, (counts.get(name) ?? 0) + 1);
	for (const message of messages) {
		const blocks = Array.isArray(message.content) ? message.content : [];
		const additions = blocks.filter((block) => block?.type === "tool_addition").map((block) => block.tool?.name ?? block.name);
		for (const name of additions) if (typeof name === "string") bump(name);
		if (additions.length) continue;
		for (const block of blocks) {
			const text = typeof block?.text === "string" ? block.text : typeof block?.content === "string" ? block.content : "";
			const at = text.indexOf("Additional deferred tools became available");
			if (at === -1) continue;
			for (const line of text.slice(at).split("\n").slice(1)) {
				const name = line.trim();
				if (/^[A-Za-z0-9_:-]+$/.test(name)) bump(name);
				else if (name) break;
			}
		}
	}
	return counts;
}

const preview = (value) => {
	const text = JSON.stringify(strip(value)) ?? "undefined";
	return text.length > 220 ? `${text.slice(0, 220)}…` : text;
};

// The session's own requests, per step, each with the assistant usage pi reported for it.
const perStep = new Map();
for (const step of steps) {
	const requests = [];
	for (let i = step.wireStart; i < step.wireEnd; i++) {
		if (meta[i] && meta[i].session === false) continue;
		if (isWarm(wire[i])) continue;
		requests.push({ index: i, body: wire[i] });
	}
	requests.forEach((request, n) => {
		request.end = step.ends[n] ?? null;
	});
	perStep.set(step.label, requests);
}

const failures = [];
const fail = (step, check, detail) => failures.push(`FAIL ${step.padEnd(10)} ${check.padEnd(8)} ${detail}`);
let checked = 0;

for (const step of steps) {
	const requests = perStep.get(step.label);
	if (step.error) fail(step.label, "ok", `the step did not run: ${step.error}`);
	if (requests.length === 0 && !step.error) fail(step.label, "ok", "no session request was dumped");
	for (const end of step.ends) if (end.stopReason === "error") fail(step.label, "ok", String(end.errorMessage).slice(0, 300));

	let base = step.epoch ? null : (perStep.get(step.base) ?? []).at(-1) ?? null;
	if (!step.epoch && !base) fail(step.label, "prefix", `base step ${step.base} has no request to compare with`);
	for (const request of requests) {
		checked++;
		const current = shape(request.body);
		const declared = new Set(current.tools.map(toolName));
		const missing = [...referencedNames(current.messages)].filter((name) => !declared.has(name));
		if (missing.length) fail(step.label, "declared", `request ${request.index} references undeclared tool(s): ${missing.join(", ")}`);
		if (Array.isArray(request.body.messages) && request.body.system !== undefined) {
			const stranded = request.body.messages.flatMap((message, i, all) => {
				const directive = Array.isArray(message.content) && message.content.length === 0;
				const next = all[i + 1];
				return message.role === "system" && !directive && next && next.role !== "assistant" && next.role !== "system" ? [i] : [];
			});
			if (stranded.length) fail(step.label, "order", `request ${request.index}: system message(s) ${stranded.join(", ")} followed by a ${request.body.messages[stranded[0] + 1].role} message`);
		}
		const announced = announcements(current.messages);
		const twice = [...announced].filter(([, count]) => count > 1).map(([name]) => name);
		if (twice.length) fail(step.label, "once", `request ${request.index} announces again: ${twice.join(", ")}`);
		// pi omits a failed reply before the next request, so an errored base's tail
		// changes legitimately: compare only against a request that got an answer.
		if (base && base.end?.stopReason !== "error") {
			const previous = shape(base.body);
			const where = `request ${request.index} against ${base.index}`;
			if (!same(previous.system, current.system)) fail(step.label, "head", `${where}: the system prompt changed`);
			const now = new Map(current.tools.map((tool) => [toolName(tool), tool]));
			const changed = previous.tools.filter((tool) => !now.has(toolName(tool)) || !same(tool, now.get(toolName(tool)))).map(toolName);
			if (changed.length) fail(step.label, "head", `${where}: tools removed or changed: ${changed.join(", ")}`);
			const eagerBefore = previous.tools.filter((tool) => !deferred(tool)).map(toolName);
			const eagerNow = current.tools.filter((tool) => !deferred(tool)).map(toolName);
			if (eagerBefore.some((name, i) => eagerNow[i] !== name)) fail(step.label, "head", `${where}: the eager tools changed order`);
			const at = previous.messages.findIndex((message, i) => !same(message, current.messages[i]));
			if (at !== -1) {
				fail(step.label, "prefix", `${where}: message ${at} of ${previous.messages.length} changed\n      was: ${preview(previous.messages[at])}\n      now: ${preview(current.messages[at])}`);
			}
			const had = base.end?.usage;
			const got = request.end?.usage;
			if (had && got && (had.cacheWrite ?? 0) > 0) {
				const floor = (had.cacheRead ?? 0) + (had.cacheWrite ?? 0) - END_TOKENS;
				if ((got.cacheRead ?? 0) < floor) fail(step.label, "cache", `${where}: read ${got.cacheRead ?? 0}, expected at least ${floor}`);
			}
		}
		base = request;
	}
}

const pass = failures.length === 0;
console.log(`--- transition check: ${checked} session requests over ${steps.length} steps`);
for (const line of failures) console.log(line);
console.log(pass ? "PASS" : `${failures.length} failure(s)`);
process.exit(pass ? 0 : 1);
