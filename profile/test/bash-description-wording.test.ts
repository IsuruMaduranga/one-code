/**
 * One Code's bash description and its timeout parameter state the unit as Claude Code does:
 * milliseconds, never pi's "timeout in seconds".
 */
import { describe, expect, it } from "vitest";
import bashExtension from "../../extensions/tools/bash/index.ts";
import { createFakePi } from "../../test/unit/helpers/fake-pi.ts";

describe("bash tool description states milliseconds, not seconds", () => {
	it("says the timeout is in milliseconds", () => {
		const fake = createFakePi();
		bashExtension(fake.pi as never);
		const description = fake.tools.get("bash")?.description ?? "";
		expect(description).not.toMatch(/timeout in seconds/i);
		expect(description).toContain("`timeout` is in milliseconds");
	});

	it("words the timeout parameter in milliseconds", () => {
		const fake = createFakePi();
		bashExtension(fake.pi as never);
		const schema = fake.tools.get("bash")?.parameters as { properties?: Record<string, { description?: string }> } | undefined;
		expect(schema?.properties?.timeout?.description).toMatch(/millisecond/i);
	});
});
