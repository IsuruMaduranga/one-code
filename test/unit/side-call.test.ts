import { describe, expect, it } from "vitest";
import { answerText, toolStubs, trimToTurnBoundary } from "../../extensions/lib/side-call.ts";

describe("toolStubs", () => {
	it("builds a name-only, empty-schema stub per tool with the given reason", () => {
		const stubs = toolStubs(["Read", "Bash"], "Unavailable for X; answer in text.") as unknown as {
			name: string;
			description: string;
			parameters: { type: string; properties: Record<string, unknown> };
		}[];
		expect(stubs.map((s) => s.name)).toEqual(["Read", "Bash"]);
		for (const stub of stubs) {
			expect(stub.description).toBe("Unavailable for X; answer in text.");
			expect(stub.parameters).toEqual({ type: "object", properties: {} });
		}
	});

	it("uses a generic default reason", () => {
		const [stub] = toolStubs(["Read"]) as unknown as { description: string }[];
		expect(stub.description).toBe("Unavailable for this call; answer in text.");
	});
});

describe("trimToTurnBoundary", () => {
	const msg = (role: string, id: string) => ({ role, id });

	it("drops a leading orphan tool-result, starting at the first turn boundary", () => {
		const context = [msg("toolResult", "orphan"), msg("user", "u1"), msg("assistant", "a1")];
		expect(trimToTurnBoundary(context)).toEqual([msg("user", "u1"), msg("assistant", "a1")]);
	});

	it("starts at a leading assistant message", () => {
		const context = [msg("assistant", "a1"), msg("user", "u2")];
		expect(trimToTurnBoundary(context)).toEqual(context);
	});

	it("returns nothing when there is no safe boundary", () => {
		expect(trimToTurnBoundary([msg("toolResult", "x"), msg("toolResult", "y")])).toEqual([]);
		expect(trimToTurnBoundary([])).toEqual([]);
	});
});

describe("answerText", () => {
	it("joins text blocks and drops non-text ones", () => {
		const content = [
			{ type: "thinking", text: "hidden" } as { type: string; text?: string },
			{ type: "text", text: "Hello" },
			{ type: "tool_use" } as { type: string },
			{ type: "text", text: "world" },
		];
		expect(answerText(content)).toBe("Hello\nworld");
	});

	it("trims surrounding whitespace", () => {
		expect(answerText([{ type: "text", text: "  spaced  " }])).toBe("spaced");
	});
});
