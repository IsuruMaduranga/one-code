import { describe, expect, it } from "vitest";
import bashExtension from "../../extensions/bash/index.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

/**
 * The bash tool's `timeout` parameter and execute path are in milliseconds
 * (Claude Code's Bash unit; pi's executor divides by 1000). pi's base
 * description ends "Optionally provide a timeout in seconds." — a contradiction
 * a model that trusts the description acts on by sending `timeout: 120` and
 * getting a 120 ms deadline (TOOL-FIDELITY-REVIEW-2026-09-07 H3). The extension
 * swaps that sentence for CC's; this locks it so pi's wording can't reappear.
 */
describe("bash tool description states milliseconds, not seconds", () => {
	it("composed description agrees with the timeout parameter's unit", () => {
		const fake = createFakePi();
		bashExtension(fake.pi as never);
		const bash = fake.tools.get("bash");
		expect(bash).toBeDefined();
		const description = bash?.description ?? "";
		expect(description).not.toMatch(/timeout in seconds/i);
		expect(description).toContain("`timeout` is in milliseconds");
	});
});
