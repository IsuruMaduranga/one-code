import { describe, expect, it } from "vitest";
import { buildPlanModeReminder } from "../../extensions/plan-mode/reminder.ts";
import { randomSlug } from "../../extensions/plan-mode/slug.ts";
import { clampOffset, decodeViewerKey, renderPlanViewer, wrapPlanText } from "../../extensions/plan-mode/viewer.ts";

describe("randomSlug", () => {
	it("produces three distinct lowercase words joined by dashes", () => {
		const slug = randomSlug();
		const words = slug.split("-");
		expect(words).toHaveLength(3);
		expect(new Set(words).size).toBe(3);
		expect(slug).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
	});

	it("is deterministic under an injected rng", () => {
		let calls = 0;
		const rng = () => {
			calls += 1;
			return (calls * 0.37) % 1;
		};
		const a = randomSlug(rng);
		calls = 0;
		const b = randomSlug(rng);
		expect(a).toBe(b);
	});

	it("skips duplicate picks rather than repeating a word", () => {
		// An rng stuck on one value would loop forever if duplicates were kept;
		// step it just enough to eventually move on.
		const values = [0.1, 0.1, 0.1, 0.2, 0.3];
		let i = 0;
		const slug = randomSlug(() => values[Math.min(i++, values.length - 1)]);
		expect(new Set(slug.split("-")).size).toBe(3);
	});
});

describe("buildPlanModeReminder", () => {
	const path = "/home/u/.claude/plans/brisk-otter-map.md";

	it("is byte-stable for the same state", () => {
		const a = buildPlanModeReminder({ filePath: path, fileExists: false });
		const b = buildPlanModeReminder({ filePath: path, fileExists: false });
		expect(a).toBe(b);
	});

	it("flips wording once the file exists", () => {
		const before = buildPlanModeReminder({ filePath: path, fileExists: false });
		const after = buildPlanModeReminder({ filePath: path, fileExists: true });
		expect(before).toContain("No plan file exists yet");
		expect(before).toContain(path);
		expect(after).toContain("Continue building your plan");
		expect(after).not.toContain("No plan file exists yet");
	});

	it("names the pincer tools the workflow relies on", () => {
		const text = buildPlanModeReminder({ filePath: path, fileExists: false });
		for (const needle of ['`agent: "explore"`', '`agent: "plan"`', "`ask_user_question`", "`exit_plan_mode`"]) {
			expect(text).toContain(needle);
		}
	});
});

describe("plan viewer", () => {
	const plain = (_color: string, text: string) => text;

	it("wraps long lines and preserves blank lines", () => {
		const lines = wrapPlanText(`${"a".repeat(25)}\n\nshort`, 10);
		expect(lines).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(5), "", "short"]);
	});

	it("clamps the scroll offset to the content", () => {
		expect(clampOffset(-3, 20, 10)).toBe(0);
		expect(clampOffset(99, 20, 10)).toBe(10);
		expect(clampOffset(2, 5, 10)).toBe(0);
	});

	it("decodes scroll, choice, pick, confirm, and cancel keys", () => {
		expect(decodeViewerKey("\x1b[A", 12)).toEqual({ kind: "scroll", delta: -1 });
		expect(decodeViewerKey("\x1b[6~", 12)).toEqual({ kind: "scroll", delta: 12 });
		expect(decodeViewerKey("\x1b[C", 12)).toEqual({ kind: "choice", delta: 1 });
		expect(decodeViewerKey("2", 12)).toEqual({ kind: "pick", index: 1 });
		expect(decodeViewerKey("\r", 12)).toEqual({ kind: "confirm" });
		expect(decodeViewerKey("\x1b", 12)).toEqual({ kind: "cancel" });
		expect(decodeViewerKey("x", 12)).toBeUndefined();
	});

	it("never renders a line wider than the given width", () => {
		const width = 24;
		const content = wrapPlanText(`# Plan\n${"word ".repeat(40)}\nshort`, width - 1);
		const lines = renderPlanViewer({ lines: content, offset: 0, choice: 0 }, plain, width);
		for (const line of lines) {
			expect([...line].length, JSON.stringify(line)).toBeLessThanOrEqual(width);
		}
	});

	it("windows the content and reports the scroll position", () => {
		const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
		const out = renderPlanViewer({ lines: content, offset: 5, choice: 2, maxVisible: 10 }, plain, 80);
		expect(out).toContain("line 6");
		expect(out).not.toContain("line 5");
		expect(out).not.toContain("line 16");
		expect(out.some((l) => l.includes("lines 6–15 of 30"))).toBe(true);
		expect(out.some((l) => l.includes("❯ 3. Keep planning"))).toBe(true);
	});
});
