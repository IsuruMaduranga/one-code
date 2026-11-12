import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSavedWorkflows, findSavedWorkflow } from "../../extensions/agents/workflow/saved-workflows.ts";
import { projectConfigDir, userConfigDir } from "../../extensions/lib/profile/sources.ts";
import { tempHome } from "./helpers/temp-home.ts";

const SCRIPT = (name: string) =>
	`export const meta = { name: '${name}', description: 'a ${name} workflow' }\nreturn await agent('go')\n`;

function fixture() {
	const { cwd, home } = tempHome("wf-saved-");
	// The profile's config folders: where saved workflows are read from.
	const project = join(projectConfigDir(cwd), "workflows");
	const user = join(userConfigDir(home), "workflows");
	mkdirSync(project, { recursive: true });
	mkdirSync(user, { recursive: true });
	return { cwd, home, project, user };
}

describe("discoverSavedWorkflows", () => {
	it("finds project and user workflows, project shadowing user", () => {
		const { cwd, home, project, user } = fixture();
		writeFileSync(join(project, "audit.js"), SCRIPT("audit"));
		writeFileSync(join(user, "audit.js"), SCRIPT("user-audit"));
		writeFileSync(join(user, "research.mjs"), SCRIPT("research"));
		writeFileSync(join(user, "notes.txt"), "not a workflow");

		const found = discoverSavedWorkflows(cwd, home);
		expect(found.map((w) => [w.name, w.source])).toEqual([
			["audit", "project"],
			["research", "user"],
		]);
		expect(found[0].meta?.description).toBe("a audit workflow");
	});

	it("lists scripts whose meta fails to parse, without meta", () => {
		const { cwd, home, project } = fixture();
		writeFileSync(join(project, "broken.js"), "const nope = 1\n");
		const found = discoverSavedWorkflows(cwd, home);
		expect(found).toHaveLength(1);
		expect(found[0].meta).toBeUndefined();
	});

	it("findSavedWorkflow resolves by name", () => {
		const { cwd, home, user } = fixture();
		writeFileSync(join(user, "review.js"), SCRIPT("review"));
		expect(findSavedWorkflow(cwd, home, "review")?.source).toBe("user");
		expect(findSavedWorkflow(cwd, home, "missing")).toBeUndefined();
	});
});
