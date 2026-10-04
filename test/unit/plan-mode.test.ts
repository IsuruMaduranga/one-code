import { describe, expect, it } from "vitest";
import { buildPlanModeReminder } from "../../extensions/plan-mode/reminder.ts";
import { randomSlug } from "../../extensions/plan-mode/slug.ts";
import { clampOffset, decodeViewerKey, initialPlanChoice, renderPlanViewer, selectPlanChoice, wrapPlanText } from "../../extensions/plan-mode/viewer.ts";

/** The dialog's default choice list when auto mode is available (auto mode leads). */
const CHOICES = [
	"Approve — auto mode",
	"Approve — auto-accept edits",
	"Approve — manual approvals",
	"Keep planning",
] as const;

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
	const path = "/home/u/.onecode/plans/brisk-otter-map.md";

	it("is byte-stable for a path and file state (the sticky block must not re-anchor)", () => {
		expect(buildPlanModeReminder(path, false)).toBe(buildPlanModeReminder(path, false));
		expect(buildPlanModeReminder(path, true)).toBe(buildPlanModeReminder(path, true));
	});

	it("opens with Claude Code's text and its Plan File Info line for each file state", () => {
		const head =
			"Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.\n\n## Plan File Info:\n";
		const tail =
			"\nYou should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.\n\n## Plan Workflow\n\n### Phase 1: Initial Understanding\n";
		expect(buildPlanModeReminder(path, false).startsWith(`${head}No plan file exists yet. You should create your plan at ${path} using the write tool.${tail}`)).toBe(true);
		expect(
			buildPlanModeReminder(path, true).startsWith(
				`${head}A plan file already exists at ${path}. You can read it and make incremental edits using the edit tool.${tail}`,
			),
		).toBe(true);
	});

	it("carries the five phases with One Code's tool and agent names, and ends on Claude Code's closing note", () => {
		const text = buildPlanModeReminder(path, false);
		const phases = text.split("\n").filter((line) => line.startsWith("### Phase"));
		expect(phases).toEqual([
			"### Phase 1: Initial Understanding",
			"### Phase 2: Design",
			"### Phase 3: Review",
			"### Phase 4: Final Plan",
			"### Phase 5: Call exit_plan_mode",
		]);
		expect(text).toContain("Critical: In this phase you should only use the explore subagent type.");
		expect(text).toContain("2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.");
		expect(text).toContain("Launch plan agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.");
		expect(text).toContain("3. Use ask_user_question to clarify any remaining questions with the user");
		expect(text).toContain(
			"This is critical - your turn should only end with either using the ask_user_question tool OR calling exit_plan_mode. Do not stop unless it's for these 2 reasons",
		);
		expect(
			text.endsWith(
				"NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using the ask_user_question tool. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.",
			),
		).toBe(true);
		// Claude Code's PascalCase names never leak through.
		for (const name of ["AskUserQuestion", "ExitPlanMode", "Write tool", "Explore", "Plan agent"]) expect(text).not.toContain(name);
		// Claude Code's text with only the names changed: 5,395 characters around the path.
		expect(text).toHaveLength(5395 + path.length);
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
		const lines = renderPlanViewer({ lines: content, offset: 0, choice: 0, choices: CHOICES }, plain, width);
		for (const line of lines) {
			expect([...line].length, JSON.stringify(line)).toBeLessThanOrEqual(width);
		}
	});

	it("windows the content and reports the scroll position", () => {
		const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
		const out = renderPlanViewer(
			{ lines: content, offset: 5, choice: 3, choices: CHOICES, maxVisible: 10 },
			plain,
			80,
		);
		expect(out).toContain("line 6");
		expect(out).not.toContain("line 5");
		expect(out).not.toContain("line 16");
		expect(out.some((l) => l.includes("lines 6–15 of 30"))).toBe(true);
		expect(out.some((l) => l.includes("❯ 4. Keep planning"))).toBe(true);
	});

	it("leads the choice list with auto mode and numbers each choice", () => {
		const out = renderPlanViewer({ lines: ["plan"], offset: 0, choice: 0, choices: CHOICES }, plain, 80);
		expect(out.some((l) => l.includes("❯ 1. Approve — auto mode"))).toBe(true);
		expect(out.some((l) => l.includes("2. Approve — auto-accept edits"))).toBe(true);
		expect(out.some((l) => l.includes("1-4 pick"))).toBe(true);
	});
});

describe("initialPlanChoice", () => {
	it("highlights manual approvals even when auto mode leads the list", () => {
		// Enter without arrowing must approve into manual mode — never silently
		// switch the session into auto mode (the pre-auto-option behavior).
		const options = [{ mode: "auto" }, { mode: "acceptEdits" }, { mode: "default" }, {}];
		expect(initialPlanChoice(options)).toBe(2);
	});

	it("highlights manual approvals when auto mode is unavailable", () => {
		expect(initialPlanChoice([{ mode: "acceptEdits" }, { mode: "default" }, {}])).toBe(1);
	});

	it("falls back to the first option when no manual choice exists", () => {
		expect(initialPlanChoice([{ mode: "acceptEdits" }, {}])).toBe(0);
	});
});

describe("selectPlanChoice (RPC)", () => {
	const choices = ["Approve — Auto mode", "Approve — Default mode", "Keep planning"];
	const ui = (reply: string | undefined) => {
		const seen: Array<{ title: string; options: string[] }> = [];
		return { seen, select: async (title: string, options: string[]) => (seen.push({ title, options }), reply) };
	};

	it("asks with the plan in the title and returns the picked index", async () => {
		const client = ui("Approve — Default mode");
		expect(await selectPlanChoice(client, "1. Do it", "/plans/x.md", choices)).toBe(1);
		expect(client.seen).toEqual([{ title: "Plan (/plans/x.md):\n\n1. Do it\n\nApprove the plan?", options: choices }]);
	});

	it("reads a dismissal or an unknown reply as no choice", async () => {
		expect(await selectPlanChoice(ui(undefined), "p", "/x.md", choices)).toBeNull();
		expect(await selectPlanChoice(ui("Approve"), "p", "/x.md", choices)).toBeNull();
	});
});
