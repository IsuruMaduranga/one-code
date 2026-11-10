/**
 * Puts a profile in force for a test: the shipped profile's text with the
 * given fields, resolved as the base resolves any profile. Undo it with
 * `setActiveProfileForTest(undefined)` in `afterEach`.
 */
import type { Profile } from "../../../extensions/lib/profile/profile-contract.ts";
import { activeProfile, resolveProfile, setActiveProfileForTest } from "../../../extensions/lib/profile/profile.ts";

// Captured once: `activeProfile()` returns the test's own profile after the first `useProfile`.
const text = activeProfile().text;

export function useProfile(fields: Partial<Profile>, profileDir = "/p"): void {
	setActiveProfileForTest(resolveProfile({ features: {}, tools: {}, childExtensions: [], text: () => text, ...fields }, {}, profileDir));
}
