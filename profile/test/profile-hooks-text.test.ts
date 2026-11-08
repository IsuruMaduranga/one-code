/**
 * One Code's hooks wording (profile/text/hooks/) for what the golden snapshot
 * cannot reach: a hook cancelled with its turn. The golden snapshot pins the
 * bytes of every other text (golden-hook.mjs); this also keeps the formatter
 * notice's guidance, which a weak model needs to read before it acts.
 */
import { describe, expect, it } from "vitest";
import { hooks } from "../../profile/text/hooks/index.ts";

describe("One Code's hooks text", () => {
	it("words a cancelled hook and a stated reason as they come", () => {
		expect(hooks.blockReason({ kind: "cancelled" })).toBe("Hook cancelled");
		expect(hooks.preToolUseBlocked({ reason: hooks.blockReason({ kind: "cancelled" }) })).toBe("PreToolUse hook: Hook cancelled");
		expect(hooks.blockReason({ kind: "stated", reason: "not here" })).toBe("not here");
	});

	it("names the output limit from the cap", () => {
		expect(hooks.blockReason({ kind: "outputLimit", maxBytes: 1_000_000 })).toBe(
			"Hook exceeded its output limit; reduce stdout/stderr to at most 1,000,000 bytes per stream.",
		);
	});

	it("names the rewritten file, forbids a revert, and asks for a read before reporting", () => {
		const text = hooks.fileChangedByHook({ path: "/repo/src/a.py" });
		expect(text).toContain("/repo/src/a.py");
		expect(text).toMatch(/do not revert/i);
		expect(text).toMatch(/read the file first/i);
	});
});
