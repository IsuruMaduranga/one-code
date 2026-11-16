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
 */
export const MEASURED_HOSTS = { OpenInference: { block: 512, offsets: [33, 0] } };

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
 * OpenRouter records a generation a few seconds after the reply, so a 404 is
 * retried.
 */
export async function lookupHosts(ids) {
	const out = new Map();
	const wanted = [...new Set(ids.filter(isGenerationId))];
	if (wanted.length === 0) return out;
	const key = openRouterKey();
	for (const id of wanted) {
		if (!key) {
			out.set(id, { error: "no OpenRouter key to look the host up" });
			continue;
		}
		let result;
		for (let attempt = 0; attempt < 6 && !result; attempt++) {
			try {
				const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
				if (res.ok) {
					const host = (await res.json())?.data?.provider_name;
					result = host ? { host } : { error: "the generation names no host" };
				} else if (res.status !== 404 || attempt === 5) result = { error: `generation lookup returned ${res.status}` };
			} catch (error) {
				if (attempt === 5) result = { error: `generation lookup failed: ${error?.message ?? error}` };
			}
			if (!result) await new Promise((resolve) => setTimeout(resolve, 2000));
		}
		out.set(id, result);
	}
	return out;
}

/**
 * The shortfall a read may have under the host that served it: the host's
 * block when the host is measured and `read` is a whole number of its blocks
 * after one of its offsets, else `DEFAULT_BLOCK`.
 */
export function allowance(lookup, read) {
	const measured = lookup?.host ? MEASURED_HOSTS[lookup.host] : undefined;
	if (!measured || read <= 0) return DEFAULT_BLOCK;
	return measured.offsets.some((offset) => (read + offset) % measured.block === 0) ? Math.max(DEFAULT_BLOCK, measured.block) : DEFAULT_BLOCK;
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
