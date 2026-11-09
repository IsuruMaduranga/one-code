/**
 * One Code's caveat above a local command's breadcrumb, Claude Code's with
 * the product named. How the base wraps it: test/unit/local-command.test.ts.
 */
import { describe, expect, it } from "vitest";
import { localCommandBlocks } from "../../extensions/lib/ui/local-command.ts";

describe("One Code's local-command caveat", () => {
	it("reproduces the /model trio byte for byte", () => {
		expect(localCommandBlocks({ name: "model", stdout: "Set model to `Sonnet 5` and saved as your default for new sessions" })[0]).toBe(
			"<local-command-caveat>The command below was run directly in One Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context for later messages.</local-command-caveat>\n",
		);
	});
});
