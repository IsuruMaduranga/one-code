/**
 * Base words that name another tool, built for the tools this session can
 * have: `forLive(build)` returns the words for the profile in force, built
 * once per live set (a test that swaps the profile gets its own). The
 * builder itself stays exported, for a test that passes a live set.
 */

import { memoOn } from "../core/text-spans.ts";
import type { LiveTools } from "./live-tools.ts";
import { activeProfile } from "./profile.ts";

export function forLive<T>(build: (live: LiveTools) => T): () => T {
	const built = memoOn(build);
	return () => built(activeProfile().live);
}
