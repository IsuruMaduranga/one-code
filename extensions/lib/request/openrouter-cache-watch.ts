/**
 * Tells the user when an OpenRouter host keeps missing the prompt cache, and
 * how to skip it.
 *
 * OpenRouter keeps a session on one host while its cache is warm, and hosts
 * cache at different grains (working-docs/findings/93-openrouter-hosts-and-the-prompt-cache.md):
 * most read nearly all of the previous prompt, some read up to about a
 * thousand tokens short (rounding, worth nothing to act on), and a few read
 * almost none of it, so every request pays the full input price. One Code
 * skips the hosts it measured doing that (openrouter-ignored-hosts.ts); this
 * catches the rest at run time.
 *
 * Each main-session reply on OpenRouter is compared with the one before it on
 * the same model and host: a reply whose cache read falls short of the
 * previous prompt by at least MIN_MISS tokens and a quarter of that prompt is
 * a miss. One miss is expected now and then (a compaction or a tool load
 * rebuilds the prompt, a long pause lets the cache expire), so only
 * MISS_STREAK misses in a row name the host, once per host and model in a
 * session. The notice is the user's alone: the model cannot change routing.
 *
 * Pure: no pi imports.
 */

/** A shortfall under this many tokens is a host's rounding, never a miss. */
export const MIN_MISS = 2048;

/** Misses in a row before the host is named. */
export const MISS_STREAK = 3;

/** What a reply's usage says about its prompt. */
export interface ReplyCache {
	/** `provider/id` of the model that replied. */
	model: string;
	/** The host OpenRouter named in the stream. */
	host: string;
	/** Prompt tokens not read from the cache (pi's `usage.input`). */
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

/** A host to name: its model, the misses in a row, and the tokens they sent again at the full price. */
export interface CacheMissStreak {
	model: string;
	host: string;
	misses: number;
	missedTokens: number;
}

export interface CacheWatch {
	/** Feed one reply; returns the streak to report the first time a host and model reach MISS_STREAK. */
	observe(reply: ReplyCache): CacheMissStreak | undefined;
}

export function createCacheWatch(): CacheWatch {
	let previous: { model: string; host: string; prompt: number } | undefined;
	let streak = { misses: 0, missedTokens: 0 };
	const named = new Set<string>();
	return {
		observe(reply) {
			const prompt = reply.input + reply.cacheRead + reply.cacheWrite;
			if (prompt <= 0) return undefined;
			const same = previous?.model === reply.model && previous.host === reply.host;
			// A prompt that shrank (a compaction) can be read only as far as it reaches.
			const reach = previous ? Math.min(previous.prompt, prompt) : 0;
			const shortfall = same ? reach - reply.cacheRead : 0;
			const miss = same && shortfall >= Math.max(MIN_MISS, reach / 4);
			streak = miss ? { misses: streak.misses + 1, missedTokens: streak.missedTokens + shortfall } : { misses: 0, missedTokens: 0 };
			previous = { model: reply.model, host: reply.host, prompt };
			const key = `${reply.model}\n${reply.host}`;
			if (streak.misses < MISS_STREAK || named.has(key)) return undefined;
			named.add(key);
			return { model: reply.model, host: reply.host, ...streak };
		},
	};
}

/** The notice for a streak; `pricePerMillion` is the model's input price less its cache-read price, when known. */
export function cacheMissNotice(streak: CacheMissStreak, pricePerMillion?: number): string {
	const extra = pricePerMillion && pricePerMillion > 0 ? (streak.missedTokens * pricePerMillion) / 1_000_000 : 0;
	const cost = extra > 0 ? `, about $${extra < 0.01 ? extra.toFixed(4) : extra.toFixed(2)} more` : "";
	return (
		`OpenRouter's host ${streak.host} missed the prompt cache on the last ${streak.misses} replies of ${streak.model} ` +
		`(${streak.missedTokens.toLocaleString("en-US")} tokens sent again at the full input price${cost}). ` +
		`To skip it, add ${streak.host} to the ignored providers in your OpenRouter account settings, ` +
		`or ignore it for this model with compat.openRouterRouting in pi's models.json.`
	);
}
