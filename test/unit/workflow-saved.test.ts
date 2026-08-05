import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSavedWorkflows, findSavedWorkflow } from "../../extensions/workflow/saved-workflows.ts";

const SCRIPT = (name: string) =>
	`export const meta = { name: '${name}', description: 'a ${name} workflow' }\nreturn await agent('go')\n`;

function fixture() {
	const cwd = mkdtempSync(join(os.tmpdir(), "wf-saved-cwd-"));
	const home = mkdtempSync(join(os.tmpdir(), "wf-saved-home-"));
	mkdirSync(join(cwd, ".claude", "workflows"), { recursive: true });
	mkdirSync(join(home, ".claude", "workflows"), { recursive: true });
	return { cwd, home };
}

describe("discoverSavedWorkflows", () => {
	it("finds project and user workflows, project shadowing user", () => {
		const { cwd, home } = fixture();
		writeFileSync(join(cwd, ".claude", "workflows", "audit.js"), SCRIPT("audit"));
		writeFileSync(join(home, ".claude", "workflows", "audit.js"), SCRIPT("user-audit"));
		writeFileSync(join(home, ".claude", "workflows", "research.mjs"), SCRIPT("research"));
		writeFileSync(join(home, ".claude", "workflows", "notes.txt"), "not a workflow");

		const found = discoverSavedWorkflows(cwd, home);
		expect(found.map((w) => [w.name, w.source])).toEqual([
			["audit", "project"],
			["research", "user"],
		]);
		expect(found[0].meta?.description).toBe("a audit workflow");
	});

	it("lists scripts whose meta fails to parse, without meta", () => {
		const { cwd, home } = fixture();
		writeFileSync(join(cwd, ".claude", "workflows", "broken.js"), "const nope = 1\n");
		const found = discoverSavedWorkflows(cwd, home);
		expect(found).toHaveLength(1);
		expect(found[0].meta).toBeUndefined();
	});

	it("findSavedWorkflow resolves by name", () => {
		const { cwd, home } = fixture();
		writeFileSync(join(home, ".claude", "workflows", "review.js"), SCRIPT("review"));
		expect(findSavedWorkflow(cwd, home, "review")?.source).toBe("user");
		expect(findSavedWorkflow(cwd, home, "missing")).toBeUndefined();
	});
});
