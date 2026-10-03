/**
 * The workflow tool's settings and description (decisions/subagents-workflows.md,
 * "The workflow tool"): `enableWorkflows`/`disableWorkflows` and
 * `workflowSizeGuideline` from One Code's own settings (never ~/.claude), the
 * size-guideline line rendered from the setting, `scriptPath` before `script`,
 * and the bundled `workflow-authoring` skill the description points to.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFrontmatterLoosely } from "../../extensions/lib/frontmatter.ts";
import { oneCodeProjectSettingsPath, oneCodeSettingsPath, readWorkflowSettings } from "../../extensions/lib/one-code-settings.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { BUNDLED_SKILLS_DIR, scanSkills } from "../../extensions/lib/skill-scan.ts";
import { WORKFLOW_DESCRIPTION_BODY, workflowDescription, workflowSizeLine } from "../../extensions/workflow/description.ts";
import workflowExtension from "../../extensions/workflow/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

let state: string;
let cwd: string;
let home: string;
const env = () => ({ ONECODE_STATE_DIR: state });
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
		write(oneCodeSettingsPath(home, env()), { enableWorkflows: true, disableWorkflows: true });
		expect(readWorkflowSettings(cwd, home, env()).enabled).toBe(false);
		write(oneCodeSettingsPath(home, env()), { enableWorkflows: true });
		write(oneCodeProjectSettingsPath(cwd, home, env()), { disableWorkflows: true });
		expect(readWorkflowSettings(cwd, home, env()).enabled).toBe(false);
	});

	it("enableWorkflows: false turns them off; the project file overrides the user file", () => {
		write(oneCodeSettingsPath(home, env()), { enableWorkflows: false, workflowSizeGuideline: "small" });
		expect(readWorkflowSettings(cwd, home, env())).toEqual({ enabled: false, sizeGuideline: "small", sizeConfigured: true });
		write(oneCodeProjectSettingsPath(cwd, home, env()), { enableWorkflows: true, workflowSizeGuideline: "large" });
		expect(readWorkflowSettings(cwd, home, env())).toEqual({ enabled: true, sizeGuideline: "large", sizeConfigured: true });
	});

	it("ignores an unknown size and a malformed file", () => {
		write(oneCodeSettingsPath(home, env()), { workflowSizeGuideline: "huge" });
		expect(readWorkflowSettings(cwd, home, env()).sizeGuideline).toBe("medium");
		writeFileSync(oneCodeSettingsPath(home, env()), "{ not json");
		expect(readWorkflowSettings(cwd, home, env())).toEqual({ enabled: true, sizeGuideline: "medium", sizeConfigured: false });
	});
});

describe("the size-guideline line", () => {
	it("is Claude Code's default line for an unset guideline", () => {
		expect(workflowSizeLine("medium", false)).toBe(
			"This session has the default workflow size guideline: medium — keep workflows under 10 agents. This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale. The user can raise or remove it with `workflowSizeGuideline` in ~/.onecode/settings.json.",
		);
		expect(workflowDescription("medium", false)).toBe(`${WORKFLOW_DESCRIPTION_BODY}\n\n${workflowSizeLine("medium", false)}`);
		expect(workflowDescription("medium", false).length).toBe(3497);
	});

	it("says configured for a set guideline, and is left out when unrestricted", () => {
		expect(workflowSizeLine("small", true)).toMatch(/^A workflow size guideline is configured for this session: small — keep workflows under 5 agents\./);
		expect(workflowSizeLine("large", true)).toContain("under 50 agents");
		expect(workflowSizeLine("unrestricted", true)).toBeUndefined();
		expect(workflowDescription("unrestricted", true)).toBe(WORKFLOW_DESCRIPTION_BODY);
	});

	it("carries Claude Code's Workflow text before the line, locked by length and hash", () => {
		expect(WORKFLOW_DESCRIPTION_BODY.length).toBe(3207);
		expect(createHash("sha256").update(WORKFLOW_DESCRIPTION_BODY).digest("hex").slice(0, 16)).toBe("885d9a65c4fdae78");
	});

	it("points to the workflow-authoring skill", () => {
		expect(WORKFLOW_DESCRIPTION_BODY).toContain("load the `workflow-authoring` skill");
	});
});

describe("workflow wiring: settings at session start", () => {
	const start = async (fake: ReturnType<typeof createFakePi>) => {
		vi.stubEnv("ONECODE_STATE_DIR", state);
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, createFakeCtx({ cwd }));
	};

	it("renders a configured guideline into the description", async () => {
		write(oneCodeProjectSettingsPath(cwd, home, env()), { workflowSizeGuideline: "large" });
		const fake = createFakePi();
		workflowExtension(fake.pi as never);
		expect(fake.tools.get("workflow")!.description).toBe(workflowDescription("medium", false));
		await start(fake);
		expect(fake.tools.get("workflow")!.description).toBe(workflowDescription("large", true));
	});

	it("disabled: the tool leaves the active set and the keyword arms nothing", async () => {
		write(oneCodeProjectSettingsPath(cwd, home, env()), { disableWorkflows: true });
		const fake = createFakePi();
		const reminders: unknown[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data));
		workflowExtension(fake.pi as never);
		fake.setActiveTools(["read", "workflow", "bash"]);
		await start(fake);
		expect(fake.getActiveTools()).toEqual(["read", "bash"]);
		await fake.fire("input", { text: "ultracode: audit it", source: "interactive" });
		expect(reminders).toHaveLength(0);

		// A later session with workflows on brings the tool back.
		write(oneCodeProjectSettingsPath(cwd, home, env()), {});
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

describe("the workflow-authoring skill", () => {
	it("is a bundled skill with Claude Code's listing description", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "wf-skill-agent-"));
		try {
			const skill = scanSkills(cwd, home, agentDir, [], BUNDLED_SKILLS_DIR).find((s) => s.name === "workflow-authoring");
			expect(skill).toBeDefined();
			const { frontmatter, body } = parseFrontmatterLoosely(readFileSync(skill!.path, "utf8"));
			expect(frontmatter.name).toBe("workflow-authoring");
			expect(String(frontmatter.description).replace(/\s+/g, " ").trim()).toBe(
				"Reference for writing a workflow tool script (script API and gotchas, resume, quality patterns, worked examples). Load before authoring a script for a workflow the user already opted into; it does not itself authorize running one.",
			);
			expect(body).toMatch(/^# Workflow authoring reference/m);
			expect(body).toContain("**Ultracode.**");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("describes One Code's engine: no per-phase model, no +500k directive, tokenBudget and allowExpensive", () => {
		const body = readFileSync(join(BUNDLED_SKILLS_DIR, "workflow-authoring", "SKILL.md"), "utf8");
		expect(body).not.toContain("Add `model` to a phase entry");
		expect(body).not.toContain("+500k");
		expect(body).not.toContain("StructuredOutput");
		expect(body).toContain("`tokenBudget`");
		expect(body).toContain("allowExpensive");
		expect(body).toContain("<session dir>/workflows/<runId>/journal.jsonl");
	});
});
