import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	AUTONOMOUS_LOOP,
	AUTONOMOUS_LOOP_DYNAMIC,
	freshDeliveryState,
	LOOP_FILE_CAP,
	LOOP_FILE_DYNAMIC_SENTINEL,
	LOOP_FILE_SENTINEL,
	readLoopFile,
	resolveLoopFire,
} from "../../extensions/background/loop-fire.ts";
import { AUTONOMOUS_PREAMBLE, AUTONOMOUS_PREAMBLE_PERSISTENT } from "../../extensions/background/loop-preamble.ts";
import { autonomousPreamble, loopSkillPrompt } from "../../extensions/background/loop-skill.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "loop-"));
	dirs.push(dir);
	return dir;
}

describe("loopSkillPrompt (Claude Code's /loop skill, 2.1.282)", () => {
	it("hands an explicit prompt to the model to parse and schedule with our tools", () => {
		const text = loopSkillPrompt("check the deploy every 20m", null);
		expect(text.startsWith("# /loop — schedule a recurring or self-paced prompt\n\nParse the input below into `[interval] <prompt…>` and schedule it.")).toBe(true);
		expect(text).toContain("1. Call cron_create with: `cron` (the expression above)");
		expect(text).toContain("recurring tasks auto-expire after 7 days, and that the user can cancel sooner with cron_delete (include the job ID).");
		expect(text).toContain("If it's a slash command, invoke it via the skill tool;");
		expect(text).toContain("call schedule_wakeup with `stop: true` (no other fields) and task_stop any monitor you armed (use task_output to find the task ID");
		expect(text).toContain("arm one now with `persistent: true`");
		expect(text.endsWith("## Input\n\ncheck the deploy every 20m")).toBe(true);
		// The claude.ai-only branches are gone, without leaving gaps.
		expect(text).not.toContain("Offer cloud first");
		expect(text).toContain("- `5m` → empty prompt → show usage\n\n## Fixed-interval mode (rules 1 and 2)");
		expect(text).not.toMatch(/\$\{|TaskList|CronCreate|ScheduleWakeup|Monitor\b/);
	});

	it("runs the autonomous default with dynamic pacing for a bare /loop", () => {
		const text = loopSkillPrompt("", null);
		expect(text.startsWith("# /loop — autonomous default with dynamic pacing")).toBe(true);
		expect(text).toContain(`the literal string \`${AUTONOMOUS_LOOP_DYNAMIC}\``);
		expect(text).toContain(`## Autonomous-loop instructions (for the immediate execution and every fire)\n\n${AUTONOMOUS_PREAMBLE}`);
	});

	it("schedules the autonomous default on a cron for an interval with no prompt, `every N` phrasing included", () => {
		const fixed = { text: loopSkillPrompt("5m", null) };
		expect(fixed.text.startsWith("# /loop — schedule the autonomous default")).toBe(true);
		expect(fixed.text).toContain("1. Convert `5m` to a 5-field cron expression.");
		expect(fixed.text).toContain(`the literal string \`${AUTONOMOUS_LOOP}\``);
		expect(loopSkillPrompt("every 2 hours", null)).toContain("1. Convert `2h` to a 5-field cron expression.");
	});

	it("uses a loop.md tasks file when one exists", () => {
		const file = { path: "/p/.claude/loop.md", content: "- keep CI green" };
		const dynamic = loopSkillPrompt("", file);
		expect(dynamic.startsWith("# /loop — loop.md tasks with dynamic pacing")).toBe(true);
		expect(dynamic).toContain(`\`${LOOP_FILE_DYNAMIC_SENTINEL}\``);
		expect(dynamic.endsWith("## Loop tasks (from /p/.claude/loop.md)\n\n- keep CI green")).toBe(true);
		expect(loopSkillPrompt("10m", file)).toContain(`\`${LOOP_FILE_SENTINEL}\``);
	});

	it("picks the persistent instructions with CLAUDE_CODE_LOOP_PERSISTENT", () => {
		expect(autonomousPreamble({})).toBe(AUTONOMOUS_PREAMBLE);
		expect(autonomousPreamble({ CLAUDE_CODE_LOOP_PERSISTENT: "1" })).toBe(AUTONOMOUS_PREAMBLE_PERSISTENT);
		for (const off of ["0", "false", "No", " off ", ""]) expect(autonomousPreamble({ CLAUDE_CODE_LOOP_PERSISTENT: off })).toBe(AUTONOMOUS_PREAMBLE);
		expect(AUTONOMOUS_PREAMBLE.startsWith("# Autonomous loop check\n")).toBe(true);
	});
});

describe("resolveLoopFire (Claude Code's sentinel expansion)", () => {
	const noFile = tempDir();
	const home = tempDir();

	it("passes an ordinary prompt through", () => {
		expect(resolveLoopFire(freshDeliveryState(), "check CI", noFile, "PRE", home)).toBe("check CI");
	});

	it("sends the full instructions once, then the short tick", () => {
		const state = freshDeliveryState();
		const first = resolveLoopFire(state, AUTONOMOUS_LOOP_DYNAMIC, noFile, "PRE", home);
		expect(first.startsWith("PRE\n\n---\n\n# Autonomous loop tick (dynamic pacing)")).toBe(true);
		const later = resolveLoopFire(state, AUTONOMOUS_LOOP_DYNAMIC, noFile, "PRE", home);
		expect(later.startsWith("# Autonomous loop tick (dynamic pacing)")).toBe(true);
		expect(later).toContain("call schedule_wakeup again at the end of this turn with `prompt` set to the literal sentinel `<<autonomous-loop-dynamic>>`");
		expect(resolveLoopFire(state, AUTONOMOUS_LOOP, noFile, "PRE", home)).toContain("The recurring cron will fire the next tick automatically — do not call schedule_wakeup from this tick.");
	});

	it("resends loop.md whenever it changed, and falls back to the instructions when it is gone", () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, ".claude"));
		const file = join(cwd, ".claude", "loop.md");
		writeFileSync(file, "- task one\n");
		const state = freshDeliveryState();
		expect(resolveLoopFire(state, LOOP_FILE_SENTINEL, cwd, "PRE", home)).toContain(`# /loop tick — tasks from ${file}\n\nThe user configured a loop-tasks file.`);
		expect(resolveLoopFire(state, LOOP_FILE_SENTINEL, cwd, "PRE", home).startsWith("# /loop tick — loop.md tasks\n")).toBe(true);
		writeFileSync(file, "- task two\n");
		expect(resolveLoopFire(state, LOOP_FILE_SENTINEL, cwd, "PRE", home)).toContain("- task two");
		rmSync(file);
		const absent = resolveLoopFire(freshDeliveryState(), LOOP_FILE_DYNAMIC_SENTINEL, cwd, "PRE", home);
		expect(absent.startsWith("PRE\n\n---\n\n# /loop tick — loop.md absent (dynamic pacing)")).toBe(true);
	});

	it("treats an unreadable loop.md as absent instead of throwing (it is read from the cron timer)", () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, ".claude"));
		const file = join(cwd, ".claude", "loop.md");
		writeFileSync(file, "- task\n");
		chmodSync(file, 0o000);
		try {
			expect(() => readLoopFile(cwd, tempDir())).not.toThrow();
		} finally {
			chmodSync(file, 0o644);
		}
	});

	it("finds ~/loop.md after the project's, and caps a long file at a line break with Claude Code's warning", () => {
		const cwd = tempDir();
		writeFileSync(join(home, "loop.md"), `${"a".repeat(LOOP_FILE_CAP - 5)}\n${"b".repeat(100)}`);
		const found = readLoopFile(cwd, home)!;
		expect(found.path).toBe(join(home, "loop.md"));
		expect(found.content).toBe(`${"a".repeat(LOOP_FILE_CAP - 5)}\n\n> WARNING: loop.md was truncated to ${LOOP_FILE_CAP} bytes. Keep the task list concise.`);
	});
});
