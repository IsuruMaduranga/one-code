/**
 * One Code's workflow tool description (its profile's `workflow` group): the
 * size-guideline line, Claude Code's Workflow text locked by length and hash,
 * and the bundled `workflow-authoring` skill the description points to. The
 * settings behind the guideline are tested in
 * test/unit/workflow-settings.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatterLoosely } from "../../extensions/lib/frontmatter.ts";
import { BUNDLED_SKILLS_DIR, scanSkills } from "../../extensions/lib/skill-scan.ts";
import { WORKFLOW_DESCRIPTION_BODY, workflowDescription, workflowSizeLine } from "../text/workflow/description.ts";
import { sha } from "./helpers/sha.ts";

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
		expect(sha(WORKFLOW_DESCRIPTION_BODY)).toBe("885d9a65c4fdae78");
	});

	it("points to the workflow-authoring skill", () => {
		expect(WORKFLOW_DESCRIPTION_BODY).toContain("load the `workflow-authoring` skill");
	});
});

describe("the workflow-authoring skill", () => {
	it("is a bundled skill with Claude Code's listing description", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "wf-skill-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "wf-skill-cwd-"));
		const home = mkdtempSync(join(tmpdir(), "wf-skill-home-"));
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
			for (const dir of [agentDir, cwd, home]) rmSync(dir, { recursive: true, force: true });
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
