import { describe, expect, it } from "vitest";
import { capField, sessionBackgroundTask, sessionCron } from "../../extensions/lib/session-work.ts";

describe("session work for the Stop hook (Claude Code's session_crons / background_tasks)", () => {
	it("caps a field at 1000 characters with Claude Code's in-string marker", () => {
		expect(capField("short")).toBe("short");
		expect(capField("x".repeat(1003))).toBe(`${"x".repeat(1000)}… [+3 chars]`);
	});

	it("shapes a cron job as a session_crons item", () => {
		expect(sessionCron({ id: "ab12cd34", cron: "*/5 * * * *", recurring: true, prompt: "poll" })).toEqual({
			id: "ab12cd34",
			schedule: "*/5 * * * *",
			recurring: true,
			prompt: "poll",
		});
	});

	it("labels task kinds the way Claude Code does and keeps a command only for shells", () => {
		expect(sessionBackgroundTask({ id: "b1", kind: "bash", status: "running", description: "dev server", command: "npm run dev" })).toEqual({
			id: "b1",
			type: "shell",
			status: "running",
			description: "dev server",
			command: "npm run dev",
		});
		expect(sessionBackgroundTask({ id: "a1", kind: "agent", status: "running", description: "review", command: "x" })).toEqual({
			id: "a1",
			type: "subagent",
			status: "running",
			description: "review",
		});
		expect(sessionBackgroundTask({ id: "z", kind: "odd", status: "running", description: "d" }).type).toBe("odd");
	});
});
