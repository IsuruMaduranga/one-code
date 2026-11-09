import { describe, expect, it } from "vitest";
import { autoModeSystemNote } from "../../extensions/permissions/auto-mode/system-note.ts";
import { requireText } from "../../extensions/lib/profile.ts";

const model = (provider: string, id: string, input?: number) =>
	({ provider, id, name: id, cost: input === undefined ? undefined : { input, output: input * 4 }, contextWindow: 200_000 }) as any;

describe("autoModeSystemNote", () => {
	it("gives Fable the firmer wording and every other model Opus's", () => {
		const { systemNote } = requireText("autoMode");
		const fable = autoModeSystemNote(model("anthropic", "claude-fable-5-1"))!;
		const opus = autoModeSystemNote(model("anthropic", "claude-opus-5-5"))!;
		expect(fable).toBe(systemNote({ firm: true }));
		expect(opus).toBe(systemNote({ firm: false }));
		expect(autoModeSystemNote(model("openai", "gpt-6-sol"))).toBe(opus);
	});

	// The cheap and tiny tool texts say to read with the read tool; the note
	// telling them to use cat/head/sed contradicted them.
	it("sends no note to a cheap or tiny model", () => {
		expect(autoModeSystemNote(model("anthropic", "claude-haiku-4-5"))).toBeUndefined();
		expect(autoModeSystemNote(model("openai", "gpt-6-luna"))).toBeUndefined();
	});
});
