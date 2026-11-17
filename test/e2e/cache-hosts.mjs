/**
 * Which upstream host served an OpenRouter request, and how much of a cache
 * read that host may round away, for the cache-probe checks
 * (cache-probe.mjs, cache-probe-classifier.mjs, cache-probe-reader.mjs).
 *
 * OpenRouter routes one model to many hosts, each with its own cache, and some
 * read in larger blocks than the 256 tokens the checks allow by default.
 * `GET /api/v1/generation?id=<gen-id>` (the `responseId` pi records on each
 * reply) names the host in `provider_name`. A host in `MEASURED_HOSTS` may
 * fall one of its blocks short, but only when the read is a whole number of
 * blocks after one of its measured offsets; every other read keeps the default
 * rule, so a real miss still shows. When the lookup fails, the line says so and
 * the default stays.
 *
 * The key is OPENROUTER_API_KEY, or the `openrouter` entry of pi's auth.json
 * (PI_CODING_AGENT_DIR, else ~/.pi/agent). It is sent only to openrouter.ai and
 * never printed.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The default allowance: one partial implicit-cache block (OpenAI 128 tokens, DeepSeek 64 or 256). */
export const DEFAULT_BLOCK = 256;

/**
 * Hosts measured to read in larger blocks: the block size, and the offsets
 * (tokens before the reported prompt) the blocks are counted from.
 * OpenInference, 2026-11-16 (working-docs/findings/93): session reads plus 33
 * were whole 512-token blocks (28,639, 29,151, 29,663), and a classifier
 * prompt's identical repeat read 31,744, a whole number with no offset.
 * Morph, 2026-11-16: classifier prompts that grew read 31,232, 30,720 and
 * 30,208 of 31,607, 31,084 and 30,610 (61, 60 and 59 blocks of 512), where
 * 1,024-token blocks would have read 30,720, 30,720 and 29,696.
 * Relace, 2026-11-17: reads are whole 256-token blocks, but the last `tail`
 * tokens of the prompt it reads from are never read: 20 pinned requests of
 * 1,527 to 4,320 tokens (prefixes, a repeat and a growing prompt) each read
 * 256 x floor((prompt - k) / 256) with k 261 or 262 (a repeat of 2,990 read
 * 2,560), and so did the matrix reads of 31,744 and 7,424. So a read falls
 * 261 to 517 tokens short, past one block.
 */
export const MEASURED_HOSTS = { OpenInference: { block: 512, offsets: [33, 0] }, Morph: { block: 512, offsets: [0] }, Relace: { block: 256, offsets: [0], tail: 262 } };

/**
 * Waits before each retry of a lookup that 404'd (OpenRouter records a
 * generation some seconds after the reply, at times past 12 s), and the most
 * one `lookupHosts` call takes in all, requests included; past it the
 * remaining ids fail fast without a request.
 */
const RETRY_DELAYS_MS = [2000, 3000, 5000, 8000, 10000, 12000];
const TOTAL_WAIT_MS = 60_000;

/** Whether a response id is an OpenRouter generation id. */
export const isGenerationId = (id) => typeof id === "string" && id.startsWith("gen-");

function openRouterKey() {
	if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
	try {
		const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
		const entry = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")).openrouter;
		return entry?.key ?? entry?.access;
	} catch {
		return undefined;
	}
}

/**
 * The serving host of each generation id, as `{ host }` or `{ error }`.
 * OpenRouter records a generation some seconds after the reply, so a 404 is
 * retried (RETRY_DELAYS_MS, at most TOTAL_WAIT_MS in all per call).
 */
export async function lookupHosts(ids) {
	const out = new Map();
	const wanted = [...new Set(ids.filter(isGenerationId))];
	if (wanted.length === 0) return out;
	const key = openRouterKey();
	const started = Date.now();
	const deadline = started + TOTAL_WAIT_MS;
	for (const id of wanted) {
		if (!key) {
			out.set(id, { error: "no OpenRouter key to look the host up" });
			continue;
		}
		if (Date.now() >= deadline) {
			out.set(id, { error: `no time left to look the host up (${Math.round(TOTAL_WAIT_MS / 1000)} s spent)` });
			continue;
		}
		let result;
		for (let attempt = 0; !result; attempt++) {
			const remaining = Math.max(1, deadline - Date.now());
			// Decided once the request has answered: no retry when the next wait would pass the deadline.
			const isLast = () => attempt === RETRY_DELAYS_MS.length || RETRY_DELAYS_MS[attempt] > deadline - Date.now();
			try {
				const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(Math.min(10_000, remaining)) });
				if (res.ok) {
					const host = (await res.json())?.data?.provider_name;
					result = host ? { host } : { error: "the generation names no host" };
				} else if (res.status !== 404 || isLast()) result = { error: `generation lookup returned ${res.status}${res.status === 404 ? ` after ${Math.round((Date.now() - started) / 1000)} s of retries` : ""}` };
			} catch (error) {
				if (isLast()) result = { error: `generation lookup failed: ${error?.message ?? error}` };
			}
			if (!result) {
				await new Promise((resolve) => setTimeout(resolve, Math.min(RETRY_DELAYS_MS[attempt], Math.max(0, deadline - Date.now()))));
			}
		}
		out.set(id, result);
	}
	return out;
}

/**
 * The shortfall a read may have under the host that served it: the host's
 * block plus its unread tail when the host is measured and `read` is a whole
 * number of its blocks after one of its offsets, else `DEFAULT_BLOCK`.
 */
export function allowance(lookup, read) {
	const measured = lookup?.host ? MEASURED_HOSTS[lookup.host] : undefined;
	if (!measured || read <= 0) return DEFAULT_BLOCK;
	return measured.offsets.some((offset) => (read + offset) % measured.block === 0) ? Math.max(DEFAULT_BLOCK, measured.block + (measured.tail ?? 0)) : DEFAULT_BLOCK;
}

/** The note a line carries: the host, or why it is unknown; empty for a request that did not go through OpenRouter. */
export function hostNote(lookup) {
	if (!lookup) return "";
	return lookup.host ? ` [host ${lookup.host}]` : ` [host unknown: ${lookup.error}]`;
}

/** The note for a PASS line: every host the phase's requests went to. */
export function hostsNote(lookups) {
	const known = [...new Set(lookups.filter((l) => l?.host).map((l) => l.host))];
	const failed = lookups.some((l) => l && !l.host);
	if (known.length === 0 && !failed) return "";
	if (known.length === 0) return " [host unknown]";
	return ` [host${known.length === 1 ? "" : "s"} ${known.join(", ")}${failed ? "; some lookups failed" : ""}]`;
}
