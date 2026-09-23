import { describe, expect, it } from "vitest";
import {
	answerText,
	IMAGE_OMITTED_TEXT,
	stripImageBlocks,
	toolStubs,
	trimToTurnBoundary,
	withoutSystemMessages,
} from "../../extensions/lib/side-call.ts";

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

describe("withoutSystemMessages", () => {
	const msg = (role: string, id: string) => ({ role, id });

	it("drops the leading system message pi 0.86 hands context handlers, and any later one", () => {
		const context = [msg("system", "head"), msg("user", "u1"), msg("assistant", "a1"), msg("system", "update"), msg("toolResult", "t1")];
		expect(withoutSystemMessages(context)).toEqual([msg("user", "u1"), msg("assistant", "a1"), msg("toolResult", "t1")]);
	});

	it("returns the conversation unchanged when it carries no system message (pi 0.87)", () => {
		const context = [msg("user", "u1"), msg("assistant", "a1")];
		expect(withoutSystemMessages(context)).toEqual(context);
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

describe("stripImageBlocks", () => {
	it("removes image blocks, leaves text blocks, other roles, and string content untouched", () => {
		const msgs = [
			{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: {} }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "plain string" },
		];
		const out = stripImageBlocks(msgs);
		expect(out[0].content).toEqual([{ type: "text", text: "hi" }]);
		expect(out[1]).toBe(msgs[1]); // no images → same reference, untouched
		expect(out[2]).toBe(msgs[2]); // string content → untouched
	});

	it("replaces an image-only message with a placeholder, preserving other fields", () => {
		const msgs = [{ role: "toolResult", toolCallId: "t1", content: [{ type: "image", source: {} }] }];
		const out = stripImageBlocks(msgs);
		expect(out[0].content).toEqual([{ type: "text", text: IMAGE_OMITTED_TEXT }]);
		expect((out[0] as { toolCallId: string }).toolCallId).toBe("t1");
	});
});
