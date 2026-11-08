/**
 * The in-process child's permission gate with One Code's source provider on:
 * a repository's own `.claude/settings.json` allow rules count only once the
 * user consented to them. The provider is what supplies a repository's
 * settings file; the gate's other rules are tested in
 * test/unit/workflow-permission-gate.test.ts.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { envName } from "../../extensions/lib/brand.mjs";
import { persistProjectAllowApproval } from "../../extensions/permissions/project-trust.ts";
import { buildGate as buildGateHarness } from "../../test/unit/helpers/permission-gate-harness.ts";

describe("permissionGateFactory — project consent (P10)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("a repo's own allow rules count only with the user's stored consent", async () => {
		const store = mkdtempSync(join(os.tmpdir(), "gate-state-"));
		vi.stubEnv(envName("STATE_DIR"), store);
		const project = { permissions: { allow: ["Bash(curl:*)"] } };
		const untrusted = buildGateHarness({ permissions: {} }, undefined, project);
		expect((await untrusted.handler({ toolName: "bash", input: { command: "curl https://example.com" } }))?.block).toBe(true);

		const trusted = buildGateHarness({ permissions: {} }, undefined, project);
		persistProjectAllowApproval(trusted.cwd, ["Bash(curl:*)"]);
		const handler = captureAfterConsent(trusted.cwd, trusted.home);
		expect(await handler({ toolName: "bash", input: { command: "curl https://example.com" } })).toBeUndefined();
	});
});

/** The gate reads consent when it is built, so rebuild it over the same dirs after persisting. */
function captureAfterConsent(cwd: string, home: string) {
	return buildGateHarness.rebuild(cwd, home);
}
