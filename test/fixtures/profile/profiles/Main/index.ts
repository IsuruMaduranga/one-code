/**
 * A minimal product profile for the base's own tests: every text group as
 * marker text (../../text.ts), the product's brand (../../brand.json), and
 * catalogs holding only the names the base relies on (the `general-purpose`
 * agent, the `loop` and `code-review` skills, one theme). It has no source
 * provider, so the base reads only its own locations. It stands in for One
 * Code's profile in the base suite (scripts/test-base.sh, the CI "base-suite"
 * job); compiling it shows a second product can fill the contract.
 *
 * Unlike One Code's, the fixture product's default profile sits in a folder of
 * its own, which the brand names (`defaultProfile`), beside its other profile
 * `Alt`; `profile/` holds only what the profiles share (the brand, the text,
 * the extensions and the catalogs). It has no `brand.json` of its own, so the
 * product's names apply. The base suite thus runs on that shape, and One
 * Code's own suite on a default profile at `profile/index.ts`.
 */

import type { Profile, ProfileText } from "../../../extensions/sdk/profile.ts";
import * as text from "../../text.ts";

// Every group the contract names, optional ones too: a group the contract
// gains fails to compile here until the fixture fills it.
const { mark: _mark, ...groups } = text;
const allGroups = groups satisfies Required<ProfileText>;

export const profile: Profile = {
	features: {},
	tools: {},
	childExtensions: [],
	// A provider of the product's own, as a sign-in proxy would be declared.
	providers: { "fixture-llm": { serves: "anthropic", wire: ["tool-references"] } },
	secretFiles: ["Fixture.secret"],
	readOnlyCommands: { fixturectl: { show: { none: "--all", required: "--name" } } },
	languageServers: {
		fixture: {
			command: "fixture-language-server",
			extensions: { ".fixturelang": "fixture" },
			// A hint by code, and one by message for a diagnostic that carries no code.
			fixHints: { byCode: { F100: "[fixture:hint F100]" }, byMessage: [["fixture: unknown name", "[fixture:hint unknown name]"]] },
		},
	},
	// The probe extension's switch for its tier notice (../../extensions/probe, PROBE_TIER_SETTING).
	settings: { fixtureTierNotice: { type: "boolean", project: true, description: "[fixture:setting.fixtureTierNotice]" } },
	// Unlike One Code's: a frontier level, and none for workhorse or cheap.
	defaultThinkingLevels: { frontier: "high", tiny: "minimal" },
	// A floor on one vendor's OpenRouter models, as a product that wants no fp4 hosts would set it.
	openRouterRouting: { qwen: { quantizations: ["bf16", "fp16", "unknown"] } },
	text: () => allGroups,
};
