import { describe, expect, it } from "vitest";
import { subagentsText } from "../../profile/subagents/index.ts";

const DELEGATION_STEER = subagentsText(ALL_LIVE).delegationSteer;
import { DELEGATE_STRICT } from "../../profile/system-prompt/low.ts";
import { DELEGATING_WORK } from "../../profile/system-prompt/mid.ts";
import { ALL_LIVE } from "./helpers/live.ts";


/**
 * The delegation policy ships as three separately tuned prose registers — one
 * per model tier. The registers may word things differently, but the policy
 * invariants must not drift apart. If this fails after editing one block,
 * bring the siblings along: DELEGATE_STRICT (tiers/low.ts), DELEGATING_WORK
 * (tiers/mid.ts), the delegation steer (profile/subagents/index.ts).
 */
const REGISTERS = {
	DELEGATE_STRICT,
	DELEGATING_WORK,
	DELEGATION_STEER,
};

describe("delegation prose registers stay policy-aligned", () => {
	for (const [name, text] of Object.entries(REGISTERS)) {
		it(`${name} carries the shared policy invariants`, () => {
			// Broad many-file questions go to the explore agent via the Agent tool.
			expect(text).toMatch(/explore/);
			expect(text).toMatch(/Agent tool/);
			// A single targeted lookup is done directly, not delegated.
			expect(text).toMatch(/single|ONE known file/i);
			// The rationale: sweeping files yourself fills your own context.
			expect(text).toMatch(/fills? your context/);
		});
	}
});
