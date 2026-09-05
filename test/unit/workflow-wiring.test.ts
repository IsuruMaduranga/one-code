/**
 * workflow/index.ts wiring: the "ultracode" keyword arms a turn with a one-shot
 * reminder, except while `/effort ultracode` already has the standing block on
 * (STEERING-REVIEW-2026-09-05 L3: two instructions for one fact, the weaker one
 * on top).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ULTRACODE_MODE_CHANNEL } from "../../extensions/effort/slider.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import workflowExtension from "../../extensions/workflow/index.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

describe("workflow wiring: the ultracode keyword", () => {
	let fake: FakePi;
	const reminders: Array<{ text?: string; scope?: string }> = [];

	beforeEach(() => {
		fake = createFakePi();
		reminders.length = 0;
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as never));
		workflowExtension(fake.pi as never);
	});

	it("arms the turn with a next-turn one-shot when the keyword is in the prompt", async () => {
		await fake.fire("input", { text: "ultracode: audit every extension", source: "interactive" });
		expect(reminders).toHaveLength(1);
		expect(reminders[0].scope).toBe("next-turn");
		expect(reminders[0].text).toContain('keyword "ultracode"');

		reminders.length = 0;
		await fake.fire("input", { text: "no keyword here", source: "interactive" });
		expect(reminders).toHaveLength(0);
	});

	it("skips the one-shot while ultracode mode is on, and resumes when it is switched off", async () => {
		fake.events.emit(ULTRACODE_MODE_CHANNEL, { active: true });
		await fake.fire("input", { text: "ultracode: audit every extension", source: "interactive" });
		expect(reminders).toHaveLength(0);

		fake.events.emit(ULTRACODE_MODE_CHANNEL, { active: false });
		await fake.fire("input", { text: "ultracode: audit every extension", source: "interactive" });
		expect(reminders).toHaveLength(1);
	});
});

describe("workflow wiring: one-shot modes (LIFECYCLE-REVIEW-2026-09-06 M1)", () => {
	let sessionDir: string;
	let agentDir: string;
	beforeEach(() => {
		sessionDir = mkdtempSync(join(tmpdir(), "wf-oneshot-session-"));
		agentDir = mkdtempSync(join(tmpdir(), "wf-oneshot-agent-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(sessionDir, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});

	const ctxFor = (mode: string) =>
		createFakeCtx({
			mode,
			cwd: process.cwd(),
			sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined, getBranch: () => [], getSessionDir: () => sessionDir },
		});
	// No agent() call: completes without a model, so the run's shape alone is under test.
	const script = "export const meta = { name: 'one-shot-probe', description: 'returns a value' }\nreturn { answer: 42 }";

	it("in print/json mode a workflow runs to completion inside the tool call and reports inline", async () => {
		const fake = createFakePi();
		workflowExtension(fake.pi as never);
		const result = (await fake.tools.get("workflow")!.execute("c1", { script }, undefined, undefined, ctxFor("json"))) as {
			content: Array<{ text: string }>;
			details: { background?: boolean; status?: string };
			isError?: boolean;
		};
		expect(result.details.background).toBeUndefined();
		expect(result.details.status).toBe("completed");
		expect(result.isError).toBe(false);
		expect(result.content[0].text).toContain("This is a one-shot session, so the workflow ran to completion instead of in the background.");
		expect(result.content[0].text).toContain("42");
		// Nothing left to deliver later: no follow-up message is ever queued.
		await new Promise((r) => setTimeout(r, 50));
		expect(fake.sentMessages).toHaveLength(0);
		expect(fake.sentUserMessages).toHaveLength(0);
	});

	it("in the TUI the same call still goes to the background", async () => {
		const fake = createFakePi();
		workflowExtension(fake.pi as never);
		const result = (await fake.tools.get("workflow")!.execute("c1", { script }, undefined, undefined, ctxFor("tui"))) as {
			content: Array<{ text: string }>;
			details: { background?: boolean; runId: string };
		};
		expect(result.details.background).toBe(true);
		expect(result.content[0].text).toContain("started in the background");
		// Let the run finish so nothing leaks into the next test.
		await new Promise((r) => setTimeout(r, 200));
	});
});
