import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildClaudeMdBlock } from "../../extensions/lib/claude-context.ts";
import { wrapReminder } from "../../extensions/lib/reminders.ts";

describe("buildClaudeMdBlock", () => {
	it("assembles the block byte-for-byte per Claude Code's join rule", () => {
		const inner = buildClaudeMdBlock({
			contextFiles: [
				{
					path: "/g/CLAUDE.md",
					content: "Global rules.\n",
					descriptor: "user's private global instructions for all projects",
				},
				{
					path: "/p/CLAUDE.md",
					content: "Project rules.\n",
					descriptor: "project instructions, checked into the codebase",
				},
			],
			memoryIndex: { path: "/m/MEMORY.md", content: "# Memory index\n\n- entry\n" },
			email: "a@b.com",
			date: "2026-08-09",
		});

		// Exact bytes: preamble\n\n, sections joined by "\n" (raw content keeps its
		// trailing "\n", so inter-section gaps are "\n\n"), memory's own trailing
		// "\n" is the single "\n" before # userEmail, and a 6-space trailer.
		const expected = [
			"As you answer the user's questions, you can use the following context:",
			"# claudeMd",
			"Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.",
			"",
			"Contents of /g/CLAUDE.md (user's private global instructions for all projects):",
			"",
			"Global rules.",
			"",
			"Contents of /p/CLAUDE.md (project instructions, checked into the codebase):",
			"",
			"Project rules.",
			"",
			"Contents of /m/MEMORY.md (user's auto-memory, persists across conversations):",
			"",
			"# Memory index",
			"",
			"- entry",
			"# userEmail",
			"The user's email address is a@b.com.",
			"# currentDate",
			"Today's date is 2026-08-09.",
			"",
			"      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.",
		].join("\n");

		expect(inner).toBe(expected);
	});

	it("omits the memory section when the index is empty", () => {
		const inner = buildClaudeMdBlock({
			contextFiles: [
				{ path: "/p/CLAUDE.md", content: "Rules.\n", descriptor: "project instructions, checked into the codebase" },
			],
			memoryIndex: { path: "/m/MEMORY.md", content: "   \n" },
			email: "a@b.com",
			date: "2026-08-09",
		});
		expect(inner).not.toContain("MEMORY.md");
		expect(inner).toContain("Contents of /p/CLAUDE.md");
	});

	it("returns null when there is nothing to inject", () => {
		expect(buildClaudeMdBlock({ contextFiles: [], memoryIndex: null, email: null, date: "2026-08-09" })).toBeNull();
	});
});

// Real-capture validation: our preamble/trailer constants and email/date framing
// must match the wire bytes. Skips gracefully where the capture isn't present
// (it is an internal-only file, absent from the public repo / CI).
describe("against opus-4-8.json capture", () => {
	const capturePath = fileURLToPath(new URL("../../opus-4-8.json", import.meta.url));
	const run = existsSync(capturePath) ? it : it.skip;

	run("the claudeMd block starts/ends exactly as we assemble it", () => {
		const payload = JSON.parse(readFileSync(capturePath, "utf8"));
		const block: string = payload.messages[0].content
			.map((b: { text?: string }) => b.text ?? "")
			.find((t: string) => t.startsWith("<system-reminder>") && t.includes("# claudeMd"));
		expect(block).toBeTruthy();

		// Same wrapper the injector adds, plus Claude Code's `\n\n` suffix on this block.
		expect(block.startsWith("<system-reminder>\n")).toBe(true);
		expect(block.endsWith("\n</system-reminder>\n\n")).toBe(true);

		const inner = block.slice("<system-reminder>\n".length, block.length - "\n</system-reminder>\n\n".length);
		expect(
			inner.startsWith(
				"As you answer the user's questions, you can use the following context:\n# claudeMd\nCodebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n",
			),
		).toBe(true);
		expect(inner).toMatch(
			/\n\n {6}IMPORTANT: this context may or may not be relevant to your tasks\. You should not respond to this context unless it is highly relevant to your task\.$/,
		);
		expect(inner).toMatch(/\n# userEmail\nThe user's email address is .+\.\n# currentDate\nToday's date is \d{4}-\d{2}-\d{2}\.\n/);

		// A round-trip: our wrapper + suffix reproduces the exact wire block.
		expect(wrapReminder(inner) + "\n\n").toBe(block);
	});
});
