/**
 * A minimal product profile for the base's own tests: every text group as
 * marker text (text.ts), its own brand (brand.json), and catalogs holding only
 * the names the base relies on (the `general-purpose` agent, the `loop` and
 * `code-review` skills, one theme). It has no source provider, so the base
 * reads only its own locations. It stands in for One Code's profile in the
 * base suite (scripts/test-base.sh, the CI "base-suite" job); compiling it shows a
 * second product can fill the contract.
 */

import type { Profile, ProfileText } from "../extensions/sdk/profile.ts";
import * as text from "./text.ts";

// Every group the contract names, optional ones too: a group the contract
// gains fails to compile here until the fixture fills it.
const { mark: _mark, ...groups } = text;
const allGroups = groups satisfies Required<ProfileText>;

export const profile: Profile = {
	features: {},
	tools: {},
	childExtensions: [],
	text: () => allGroups,
};
