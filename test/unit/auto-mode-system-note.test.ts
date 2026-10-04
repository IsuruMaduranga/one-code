import { describe, expect, it } from "vitest";
import { autoModeSystemNote } from "../../extensions/auto-mode/system-note.ts";

describe("autoModeSystemNote", () => {
	it("gives Fable the firmer wording and every other model Opus's, with One Code's tool names", () => {
		const fable = autoModeSystemNote("claude-fable-5-1");
		const opus = autoModeSystemNote("claude-opus-5-5");
		expect(fable.startsWith("While auto mode is active:\n\nDo your work through the bash tool wherever it can accomplish the job")).toBe(true);
		expect(opus.startsWith("While auto mode is active:\n\nYou can do much of your work through the bash tool when it is the simpler route")).toBe(true);
		expect(autoModeSystemNote("gpt-6-sol")).toBe(opus);
		for (const note of [fable, opus]) expect(note).not.toMatch(/\b(Bash|Read|Edit|Write) tool/);
	});
});
