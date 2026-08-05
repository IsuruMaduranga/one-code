import { describe, expect, it } from "vitest";
import { describeChanges, FileTracker } from "../../extensions/file-tracker/tracker.ts";
import { looksLikeAnthropicRequest, withClearThinking } from "../../extensions/context-management/index.ts";

describe("FileTracker.status", () => {
	it("reports absent for a file that does not exist", () => {
		expect(new FileTracker().status("/x/new.ts", undefined)).toBe("absent");
	});

	it("reports unread for an existing file never observed", () => {
		expect(new FileTracker().status("/x/a.ts", "content")).toBe("unread");
	});

	it("reports fresh when disk matches what we last saw", () => {
		const tracker = new FileTracker();
		tracker.observe("/x/a.ts", "content", 1);
		expect(tracker.status("/x/a.ts", "content")).toBe("fresh");
	});

	it("reports stale when the file changed under us", () => {
		const tracker = new FileTracker();
		tracker.observe("/x/a.ts", "before", 1);
		expect(tracker.status("/x/a.ts", "after")).toBe("stale");
	});

	it("becomes fresh again after observing our own write", () => {
		const tracker = new FileTracker();
		tracker.observe("/x/a.ts", "before", 1);
		tracker.observe("/x/a.ts", "after", 2);
		expect(tracker.status("/x/a.ts", "after")).toBe("fresh");
	});

	it("forgets a deleted file", () => {
		const tracker = new FileTracker();
		tracker.observe("/x/a.ts", "c", 1);
		tracker.forget("/x/a.ts");
		expect(tracker.has("/x/a.ts")).toBe(false);
	});

	it("does not block edits to files too large to track by content", () => {
		const tracker = new FileTracker();
		tracker.observe("/x/big.ts", "x".repeat(600 * 1024), 1);
		expect(tracker.lastSeen("/x/big.ts")).toBe("");
		expect(tracker.status("/x/big.ts", "anything at all")).toBe("fresh");
	});

	it("evicts the oldest entry past the cap", () => {
		const tracker = new FileTracker();
		for (let i = 0; i < 320; i++) tracker.observe(`/x/${i}.ts`, "c", i);
		expect(tracker.tracked.length).toBeLessThanOrEqual(300);
		expect(tracker.has("/x/0.ts")).toBe(false);
		expect(tracker.has("/x/319.ts")).toBe(true);
	});
});

describe("describeChanges", () => {
	it("returns nothing when the content is identical", () => {
		expect(describeChanges("a\nb", "a\nb")).toBeUndefined();
	});

	it("shows the changed region with 1-indexed line numbers", () => {
		const before = "one\ntwo\nthree\nfour\nfive";
		const after = "one\ntwo\nCHANGED\nfour\nfive";
		const excerpt = describeChanges(before, after, { context: 1 });
		expect(excerpt?.firstChangedLine).toBe(3);
		expect(excerpt?.text).toContain("3\tCHANGED");
		expect(excerpt?.text).toContain("2\ttwo");
		expect(excerpt?.text).not.toContain("5\tfive");
	});

	it("handles an appended block", () => {
		const excerpt = describeChanges("a\n", "a\nb\nc\n", { context: 0 });
		expect(excerpt?.text).toContain("2\tb");
		expect(excerpt?.text).toContain("3\tc");
	});

	it("caps very large changes and says how many lines were dropped", () => {
		const after = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
		const excerpt = describeChanges("original", after, { context: 0, maxLines: 5 });
		expect(excerpt?.text.split("\n").filter((l) => /^\d+\t/.test(l))).toHaveLength(5);
		expect(excerpt?.text).toContain("more changed lines");
	});
});

describe("context management (opt-in)", () => {
	it("recognises an Anthropic-shaped payload", () => {
		expect(looksLikeAnthropicRequest({ model: "claude-opus-5", messages: [], max_tokens: 100 })).toBe(true);
		expect(looksLikeAnthropicRequest({ model: "gpt-5.5", input: [], messages: [] })).toBe(false);
		expect(looksLikeAnthropicRequest({ model: "claude-opus-5" })).toBe(false);
		expect(looksLikeAnthropicRequest(undefined)).toBe(false);
	});

	it("adds the clear-thinking edit without dropping existing ones", () => {
		const payload = withClearThinking({ model: "claude-opus-5", context_management: { edits: [{ type: "other" }] } });
		const edits = (payload.context_management as { edits: Array<{ type: string }> }).edits;
		expect(edits.map((e) => e.type)).toEqual(["other", "clear_thinking_20251015"]);
	});

	it("is idempotent", () => {
		const once = withClearThinking({ model: "claude-opus-5" });
		expect(withClearThinking(once)).toBe(once);
	});
});

describe("stale state survives change notification", () => {
	it("stays stale after we warn about a change, so the edit guard still fires", () => {
		const tracker = new FileTracker();
		tracker.observe("/x/a.ts", "before", 1);
		// Simulate the pre-turn scan: warn, but do not mark as read.
		tracker.markNotified("/x/a.ts", "after");
		expect(tracker.status("/x/a.ts", "after")).toBe("stale");
		expect(tracker.alreadyNotified("/x/a.ts", "after")).toBe(true);
		// A different change warrants a new warning.
		expect(tracker.alreadyNotified("/x/a.ts", "after again")).toBe(false);
	});

	it("clears the notification once the file is genuinely re-read", () => {
		const tracker = new FileTracker();
		tracker.observe("/x/a.ts", "before", 1);
		tracker.markNotified("/x/a.ts", "after");
		tracker.observe("/x/a.ts", "after", 2);
		expect(tracker.status("/x/a.ts", "after")).toBe("fresh");
		expect(tracker.alreadyNotified("/x/a.ts", "after")).toBe(false);
	});
});
