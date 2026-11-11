/**
 * Base words that name another tool, built for the tools this session can
 * have: `forLive(build)` returns the words for the profile in force, built
 * once per live set (a test that swaps the profile gets its own). The
 * builder itself stays exported, for a test that passes a live set.
 */

import type { LiveTools } from "./live-tools.ts";
import { activeProfile } from "./profile.ts";

export function forLive<T>(build: (live: LiveTools) => T): () => T {
	const built = new WeakMap<LiveTools, T>();
	return () => {
		const { live } = activeProfile();
		if (!built.has(live)) built.set(live, build(live));
		return built.get(live) as T;
	};
}
