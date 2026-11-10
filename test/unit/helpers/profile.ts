/**
 * Puts a profile in force for a test, resolved as the base resolves any
 * profile, so its switches, its live tool set and its text always agree.
 */
import { afterEach, beforeEach } from "vitest";
import type { Profile } from "../../../extensions/lib/profile/profile-contract.ts";
import { activeProfile, PRODUCT_DIR, PROFILE_DIR, type ResolvedProfile, resolveProfile, setActiveProfileForTest } from "../../../extensions/lib/profile/profile.ts";
import { profile as shippedSource } from "../../../profile/index.ts";

// Captured once: `activeProfile()` returns the test's own profile after the first `useProfile`.
const shipped = activeProfile();

/**
 * The shipped profile's text with the given fields. The text is built for
 * the new profile's own live tools. Undo it with
 * `setActiveProfileForTest(undefined)` in `afterEach`.
 */
export function useProfile(fields: Partial<Profile>, profileDir = "/p"): void {
	setActiveProfileForTest(resolveProfile({ features: {}, tools: {}, childExtensions: [], text: ({ live }) => shipped.textFor(live), ...fields }, {}, profileDir));
}

let allTools: ResolvedProfile | undefined;

/** The shipped profile with every tool it turns off turned back on; its other switches stay. Resolved once per test file. */
export function shippedProfileWithAllTools(): ResolvedProfile {
	if (!allTools) {
		const tools = Object.fromEntries(Object.entries(shippedSource.tools).map(([name, { enabled: _enabled, ...rest }]) => [name, rest]));
		allTools = resolveProfile({ ...shippedSource, tools }, {}, PROFILE_DIR, PRODUCT_DIR);
	}
	return allTools;
}

/**
 * For a file that tests how the base handles tools a product may turn off
 * (pi's grep, find and ls, for one): every test in it runs on the shipped
 * profile with all its tools on, whatever the profile turns off. Call it once
 * at the top of the file; it registers its own setup and teardown.
 */
export function useShippedProfileWithAllTools(): void {
	beforeEach(() => setActiveProfileForTest(shippedProfileWithAllTools()));
	afterEach(() => setActiveProfileForTest(undefined));
}
