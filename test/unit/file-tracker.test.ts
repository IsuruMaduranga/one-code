import { describe, expect, it } from "vitest";
import { describeChanges, FileTracker, RACY_STAMP_MS } from "../../extensions/file-tracker/tracker.ts";
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

// The change scan runs after every tool call; the stamp is what lets it skip
// the full read for every tracked file whose mtime and size have not moved.
describe("FileTracker disk stamps", () => {
	const stamp = { mtimeMs: 1000, size: 5 };

	it("reports a file unchanged only while the stamp recorded at observe matches", () => {
		const tracker = new FileTracker();
		tracker.observe("/x/a.ts", "hello", 1, stamp);
		expect(tracker.unchangedOnDisk("/x/a.ts", { ...stamp })).toBe(true);
		expect(tracker.unchangedOnDisk("/x/a.ts", { mtimeMs: 2000, size: 5 })).toBe(false);
		expect(tracker.unchangedOnDisk("/x/a.ts", { mtimeMs: 1000, size: 6 })).toBe(false);
	});

	it("never reports unchanged without a recorded stamp, so a stamp-less observe is always re-read", () => {
		const tracker = new FileTracker();
		tracker.observe("/x/a.ts", "hello", 1);
		expect(tracker.unchangedOnDisk("/x/a.ts", stamp)).toBe(false);
		// An observe without a stamp also drops a stale one.
		tracker.observe("/x/a.ts", "hello", 2, stamp);
		tracker.observe("/x/a.ts", "hello", 3);
		expect(tracker.unchangedOnDisk("/x/a.ts", stamp)).toBe(false);
	});

	it("never trusts a stamp younger than the racy window, so a same-size rewrite right after our read is still re-read", () => {
		const tracker = new FileTracker();
		const now = 50_000;
		const fresh = { mtimeMs: now - RACY_STAMP_MS + 1, size: 5 };
		tracker.observe("/x/a.ts", "hello", 1, fresh);
		expect(tracker.unchangedOnDisk("/x/a.ts", fresh, now)).toBe(false);
		// Once it has aged past the window the same stamp is trusted.
		expect(tracker.unchangedOnDisk("/x/a.ts", fresh, now + RACY_STAMP_MS)).toBe(true);
	});

	it("moves with the scan's own reads and is dropped with the file", () => {
		const tracker = new FileTracker();
		tracker.observe("/x/a.ts", "hello", 1, stamp);
		const later = { mtimeMs: 3000, size: 9 };
		tracker.recordStamp("/x/a.ts", later);
		expect(tracker.unchangedOnDisk("/x/a.ts", later)).toBe(true);
		expect(tracker.unchangedOnDisk("/x/a.ts", stamp)).toBe(false);
		// The scan recording a stamp does not make the file count as read.
		expect(tracker.lastSeen("/x/a.ts")).toBe("hello");
		tracker.forget("/x/a.ts");
		expect(tracker.unchangedOnDisk("/x/a.ts", later)).toBe(false);
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
