import { describe, expect, it } from "vitest";
import { upEditsQueue } from "../../extensions/branding/queued-edit.ts";

const editor = (line: number, autocomplete = false) => ({
	getCursor: () => ({ line, col: 0 }),
	isShowingAutocomplete: () => autocomplete,
});

describe("upEditsQueue", () => {
	it("restores the queue on the first line while a message waits", () => {
		expect(upEditsQueue(editor(0), true)).toBe(true);
	});

	it("leaves ↑ to history when nothing is queued", () => {
		expect(upEditsQueue(editor(0), false)).toBe(false);
	});

	it("leaves ↑ to the cursor below the first line", () => {
		expect(upEditsQueue(editor(2), true)).toBe(false);
	});

	it("leaves ↑ to an open autocomplete list", () => {
		expect(upEditsQueue(editor(0, true), true)).toBe(false);
	});
});
