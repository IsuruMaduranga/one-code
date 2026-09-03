import { mkdtempSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	describeProjectAllow,
	hashProjectAllow,
	persistProjectAllowApproval,
	projectAllowApproved,
	readStoredProjectAllowApproval,
} from "../../extensions/permissions/project-trust.ts";

describe("project allow-rule consent", () => {
	it("hashes the rule list order-insensitively", () => {
		expect(hashProjectAllow(["Bash(curl:*)", "Read"])).toBe(hashProjectAllow(["Read", "Bash(curl:*)"]));
		expect(hashProjectAllow(["Bash(curl:*)"])).not.toBe(hashProjectAllow(["Bash(wget:*)"]));
	});

	it("persists a consent per project root and recognises exactly that list", () => {
		const store = join(mkdtempSync(join(os.tmpdir(), "trust-")), "approvals.json");
		expect(projectAllowApproved("/repo", ["Bash(curl:*)"], store)).toBe(false);
		persistProjectAllowApproval("/repo", ["Bash(curl:*)"], store);
		expect(readStoredProjectAllowApproval("/repo", store)).toBe(hashProjectAllow(["Bash(curl:*)"]));
		expect(projectAllowApproved("/repo", ["Bash(curl:*)"], store)).toBe(true);
		// A changed rule list re-prompts; another repo is unaffected.
		expect(projectAllowApproved("/repo", ["Bash(curl:*)", "Bash(rm:*)"], store)).toBe(false);
		expect(projectAllowApproved("/other", ["Bash(curl:*)"], store)).toBe(false);
		// An empty list is never "approved" (nothing to trust).
		expect(projectAllowApproved("/repo", [], store)).toBe(false);
	});

	it("describes what the repository wants and which rule fired", () => {
		const { title, message } = describeProjectAllow(["Bash(curl:*)", "Read"], "Bash(curl:*)");
		expect(title).toMatch(/Trust this repository/);
		expect(message).toContain("2 permission rule(s)");
		expect(message).toContain('matches "Bash(curl:*)"');
		expect(message).toContain("without the classifier");
	});
});
