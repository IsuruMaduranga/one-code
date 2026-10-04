/** Only the main session takes Claude Code's git snapshot; a child session's context block has none. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import claudeContextExtension from "../../extensions/claude-context/index.ts";
import { GIT_SNAPSHOT_OWNER_CHANNEL } from "../../extensions/lib/git-status.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

describe("claude-context's git snapshot", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "claude-context-git-"));
		stubHome(dir);
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(dir, ".claude"));
		vi.stubEnv("GIT_AUTHOR_EMAIL", "a@b.com");
		execFileSync("git", ["init", "-q"], { cwd: dir });
		writeFileSync(join(dir, "f.txt"), "x");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	async function contextBlock(owner: boolean): Promise<string | undefined> {
		const fake = createFakePi();
		const texts: Array<{ key?: string; text?: string }> = [];
		fake.events.on(REMINDER_CHANNEL, (data) => texts.push(data as never));
		claudeContextExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd: dir });
		await fake.fireOne("session_start", {}, ctx);
		if (owner) fake.events.emit(GIT_SNAPSHOT_OWNER_CHANNEL, {});
		await fake.fireOne("turn_start", {}, ctx);
		return texts.find((t) => t.key === "claude-context-context")?.text;
	}

	it("is in the main session's context block", async () => {
		expect(await contextBlock(true)).toContain("# gitStatus\nThis is the git status at the start of the conversation.");
	});

	it("is left out in a session nobody claimed it for (a child), which keeps the email", async () => {
		const block = await contextBlock(false);
		expect(block).not.toContain("# gitStatus");
		expect(block).toContain("# userEmail");
	});
});
