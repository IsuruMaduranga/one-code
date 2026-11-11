/**
 * The workflow tool's settings (decisions/subagents-workflows.md, "The
 * workflow tool"): `enableWorkflows`/`disableWorkflows` and
 * `workflowSizeGuideline` from the product's own settings (never ~/.claude),
 * the description the profile renders from the setting, and `scriptPath`
 * before `script`. One Code's description and its bundled
 * `workflow-authoring` skill are tested in
 * profile/test/workflow-settings-wording.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productProjectSettingsPath, productSettingsPath, readWorkflowSettings, type WorkflowSizeGuideline } from "../../extensions/lib/profile/product-settings.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/request/reminders.ts";
import { requireText } from "../../extensions/lib/profile/profile.ts";
import workflowExtension from "../../extensions/agents/workflow/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { envName } from "../../extensions/lib/profile/brand.mjs";
import { workflowResultText } from "../../extensions/agents/workflow/text.ts";

/** The tool's description for a guideline, in the profile's words. */
const workflowDescription = (guideline: WorkflowSizeGuideline, configured: boolean) =>
	requireText("workflow").description({ guideline, configured });

let state: string;
let cwd: string;
let home: string;
const env = () => ({ [envName("STATE_DIR")]: state });
const write = (path: string, value: unknown) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
};

beforeEach(() => {
	state = mkdtempSync(join(tmpdir(), "wf-settings-state-"));
	cwd = mkdtempSync(join(tmpdir(), "wf-settings-cwd-"));
	home = mkdtempSync(join(tmpdir(), "wf-settings-home-"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of [state, cwd, home]) rmSync(dir, { recursive: true, force: true });
});

describe("readWorkflowSettings", () => {
	it("defaults to enabled with the medium guideline, not configured", () => {
		expect(readWorkflowSettings(cwd, home, env())).toEqual({ enabled: true, sizeGuideline: "medium", sizeConfigured: false });
	});

	it("disableWorkflows wins over enableWorkflows, from either file", () => {
		write(productSettingsPath(home, env()), { enableWorkflows: true, disableWorkflows: true });
		expect(readWorkflowSettings(cwd, home, env()).enabled).toBe(false);
		write(productSettingsPath(home, env()), { enableWorkflows: true });
		write(productProjectSettingsPath(cwd, home, env()), { disableWorkflows: true });
		expect(readWorkflowSettings(cwd, home, env()).enabled).toBe(false);
	});

	it("enableWorkflows: false turns them off; the project file overrides the user file", () => {
		write(productSettingsPath(home, env()), { enableWorkflows: false, workflowSizeGuideline: "small" });
		expect(readWorkflowSettings(cwd, home, env())).toEqual({ enabled: false, sizeGuideline: "small", sizeConfigured: true });
		write(productProjectSettingsPath(cwd, home, env()), { enableWorkflows: true, workflowSizeGuideline: "large" });
		expect(readWorkflowSettings(cwd, home, env())).toEqual({ enabled: true, sizeGuideline: "large", sizeConfigured: true });
	});

	it("ignores an unknown size and a malformed file", () => {
		write(productSettingsPath(home, env()), { workflowSizeGuideline: "huge" });
		expect(readWorkflowSettings(cwd, home, env()).sizeGuideline).toBe("medium");
		writeFileSync(productSettingsPath(home, env()), "{ not json");
		expect(readWorkflowSettings(cwd, home, env())).toEqual({ enabled: true, sizeGuideline: "medium", sizeConfigured: false });
	});
});

describe("workflow wiring: settings at session start", () => {
	const start = async (fake: ReturnType<typeof createFakePi>) => {
		vi.stubEnv(envName("STATE_DIR"), state);
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, createFakeCtx({ cwd }));
	};

	it("renders a configured guideline into the description", async () => {
		write(productProjectSettingsPath(cwd, home, env()), { workflowSizeGuideline: "large" });
		const fake = createFakePi();
		workflowExtension(fake.pi as never);
		expect(fake.tools.get("workflow")!.description).toBe(workflowDescription("medium", false));
		await start(fake);
		expect(fake.tools.get("workflow")!.description).toBe(workflowDescription("large", true));
	});

	it("disabled: the tool leaves the active set and the keyword arms nothing", async () => {
		write(productProjectSettingsPath(cwd, home, env()), { disableWorkflows: true });
		const fake = createFakePi();
		const reminders: unknown[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data));
		workflowExtension(fake.pi as never);
		fake.setActiveTools(["read", "workflow", "bash"]);
		await start(fake);
		expect(fake.getActiveTools()).toEqual(["read", "bash"]);
		await fake.fire("input", { text: "ultracode: audit it", source: "interactive" });
		expect(reminders).toHaveLength(0);

		// A call that reaches the tool anyway is refused, loudly.
		const ctx = createFakeCtx({ cwd, sessionManager: { getSessionDir: () => cwd } });
		const refused = (await fake.tools.get("workflow")!.execute("c1", { script: "return 1" }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
			isError?: boolean;
		};
		expect(refused.isError).toBe(true);
		expect(refused.content[0].text).toBe(workflowResultText.refused({ kind: "turnedOff" }));

		// A later session with workflows on brings the tool back.
		write(productProjectSettingsPath(cwd, home, env()), {});
		await start(fake);
		expect(fake.getActiveTools()).toEqual(["read", "bash", "workflow"]);
	});
});

describe("workflow wiring: scriptPath takes precedence over script", () => {
	it("runs the file at scriptPath when both are given", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "wf-scriptpath-session-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", home);
		try {
			const scriptPath = join(cwd, "from-path.js");
			writeFileSync(scriptPath, "export const meta = { name: 'from-path', description: 'the file' }\nreturn 'FROM_PATH'");
			const inline = "export const meta = { name: 'inline', description: 'the inline script' }\nreturn 'INLINE'";
			const fake = createFakePi();
			workflowExtension(fake.pi as never);
			const ctx = createFakeCtx({
				mode: "json",
				cwd,
				sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined, getBranch: () => [], getSessionDir: () => sessionDir },
			});
			const result = (await fake.tools.get("workflow")!.execute("c1", { script: inline, scriptPath }, undefined, undefined, ctx)) as { content: Array<{ text: string }> };
			expect(result.content[0].text).toContain("FROM_PATH");
			expect(result.content[0].text).not.toContain("INLINE");
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});
});
