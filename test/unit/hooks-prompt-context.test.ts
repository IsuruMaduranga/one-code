import { describe, expect, it } from "vitest";
import { PromptContextRouter } from "../../extensions/hooks/prompt-context.ts";

describe("PromptContextRouter", () => {
	it("gives a queued message its own context, matched by the typed text, once", () => {
		const router = new PromptContextRouter();
		router.holdQueued("also do this", "queued context");
		expect(router.release("something else")).toBeUndefined();
		expect(router.release("also do this")).toBe("queued context");
		expect(router.release("also do this")).toBeUndefined();
		expect(router.isEmpty).toBe(true);
	});

	it("gives an idle prompt's context to the first unclaimed user message, which may carry its expansion", () => {
		const router = new PromptContextRouter();
		router.holdIdle("/review foo", "idle context");
		expect(router.release("Review the change in foo carefully.")).toBe("idle context");
		expect(router.release("Review the change in foo carefully.")).toBeUndefined();
	});

	it("never gives an idle prompt's context to a queued message whose hook added none", () => {
		const router = new PromptContextRouter();
		router.holdQueued("first", undefined);
		router.holdIdle("/tpl", "for the template");
		expect(router.isEmpty).toBe(false);
		expect(router.release("first")).toBeUndefined();
		expect(router.release("template body")).toBe("for the template");
	});

	it("matches an exact idle prompt only when asked for an exact match (a skill's typed input)", () => {
		const router = new PromptContextRouter();
		router.holdIdle("/skill:foo now", "skill context");
		expect(router.release("/skill:bar", true)).toBeUndefined();
		expect(router.release("/skill:foo now", true)).toBe("skill context");
	});

	it("drops stale idle context on a new idle prompt and everything on clear", () => {
		const router = new PromptContextRouter();
		router.holdIdle("old", "stale");
		router.holdQueued("queued", "kept");
		router.dropIdle();
		expect(router.release("anything")).toBeUndefined();
		expect(router.release("queued")).toBe("kept");
		router.holdQueued("q", undefined);
		router.holdIdle("i", "c");
		router.clear();
		expect(router.isEmpty).toBe(true);
	});
});
