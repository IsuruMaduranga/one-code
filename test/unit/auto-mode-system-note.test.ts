import { describe, expect, it } from "vitest";
import { autoModeSystemNote } from "../../extensions/auto-mode/system-note.ts";

const model = (provider: string, id: string, input?: number) =>
	({ provider, id, name: id, cost: input === undefined ? undefined : { input, output: input * 4 }, contextWindow: 200_000 }) as any;

describe("autoModeSystemNote", () => {
	it("gives Fable the firmer wording and every other model Opus's, with One Code's tool names", () => {
		const fable = autoModeSystemNote(model("anthropic", "claude-fable-5-1"))!;
		const opus = autoModeSystemNote(model("anthropic", "claude-opus-5-5"))!;
		expect(fable.startsWith("While auto mode is active:\n\nDo your work through the bash tool wherever it can accomplish the job")).toBe(true);
		expect(opus.startsWith("While auto mode is active:\n\nYou can do much of your work through the bash tool when it is the simpler route")).toBe(true);
		expect(autoModeSystemNote(model("openai", "gpt-6-sol"))).toBe(opus);
		for (const note of [fable, opus]) expect(note).not.toMatch(/\b(Bash|Read|Edit|Write) tool/);
	});

	// The cheap and tiny tool texts say to read with the read tool; the note
	// telling them to use cat/head/sed contradicted them.
	it("sends no note to a cheap or tiny model", () => {
		expect(autoModeSystemNote(model("anthropic", "claude-haiku-4-5"))).toBeUndefined();
		expect(autoModeSystemNote(model("openai", "gpt-6-luna"))).toBeUndefined();
	});
});
