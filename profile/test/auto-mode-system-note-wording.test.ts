/** One Code's auto-mode system note: Claude Code's two wordings, with One Code's tool names. */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";

describe("auto mode system note wording", () => {
	it("gives the firm and the plain wording, naming One Code's tools", () => {
		const { systemNote } = requireText("autoMode");
		const firm = systemNote({ firm: true });
		const plain = systemNote({ firm: false });
		expect(firm.startsWith("While auto mode is active:\n\nDo your work through the bash tool wherever it can accomplish the job")).toBe(true);
		expect(plain.startsWith("While auto mode is active:\n\nYou can do much of your work through the bash tool when it is the simpler route")).toBe(true);
		for (const note of [firm, plain]) expect(note).not.toMatch(/\b(Bash|Read|Edit|Write) tool/);
	});
});
