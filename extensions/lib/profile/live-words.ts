/**
 * Base words that name another tool, built for the tools this session can
 * have: `forLive(build)` returns the words for the profile in force, built
 * once per live set (a test that swaps the profile gets its own). A child
 * session passes its own live set (lib/agents/child-extensions.ts
 * `sessionView`), since it shares these modules with the main session.
 *
 * A base sentence that carries a clause of the profile's has one path:
 * `wordsInForce(group, build)`. The builder takes the live set and the
 * profile's text group and reads the clause itself, so a call site passes
 * only the facts of what happened.
 */

import { memoOn } from "../core/text-spans.ts";
import type { LiveTools } from "./live-tools.ts";
import { activeProfile, requireText } from "./profile.ts";
import type { ProfileText } from "./profile-contract.ts";

export function forLive<T>(build: (live: LiveTools) => T): (live?: LiveTools) => T {
	const built = memoOn(build);
	return (live = activeProfile().live) => built(live);
}

/**
 * The words of a builder that takes a profile text group, for the profile in
 * force: built once per live set and group. Fails closed when the group is
 * missing (`requireText`), so an optional group's readers are listed in
 * `TEXT_GROUP_READERS`.
 */
export function wordsInForce<K extends keyof ProfileText, T>(group: K, build: (live: LiveTools, text: NonNullable<ProfileText[K]>) => T): (live?: LiveTools) => T {
	const built = memoOn((live: LiveTools) => memoOn((text: NonNullable<ProfileText[K]>) => build(live, text)));
	return (live = activeProfile().live) => built(live)(requireText(group));
}
