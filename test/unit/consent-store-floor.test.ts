/**
 * The consent stores approve a repository's hooks, MCP servers, allow rules
 * and language servers for every later session, so a write to one is a
 * gate-control write: the safety floor stops it in every shape, before the
 * classifier could approve it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safetyControlWrite } from "../../extensions/auto-mode/safety-floor.ts";
import { consentStorePath, consentStorePaths } from "../../extensions/lib/consent-stores.ts";
import { forwardSlashes } from "../../extensions/lib/paths.ts";
import { approvalStorePath as hooksStore } from "../../extensions/hooks/trust.ts";
import { lspTrustStorePath } from "../../extensions/lsp/trust.ts";
import { approvalStorePath as mcpStore } from "../../extensions/mcp/trust.ts";
import { projectAllowStorePath } from "../../extensions/permissions/project-trust.ts";

let home: string;
let cwd: string;
const savedState = process.env.ONECODE_STATE_DIR;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "consent-floor-home-"));
	cwd = mkdtempSync(join(tmpdir(), "consent-floor-cwd-"));
	delete process.env.ONECODE_STATE_DIR;
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
	if (savedState === undefined) delete process.env.ONECODE_STATE_DIR;
	else process.env.ONECODE_STATE_DIR = savedState;
});

const check = (toolName: string, input: Record<string, unknown>) => safetyControlWrite({ toolName, input, cwd, home });

describe("the consent stores", () => {
	it("are the files the trust modules read", () => {
		expect([hooksStore(), mcpStore(), projectAllowStorePath(), lspTrustStorePath()].sort()).toEqual(consentStorePaths(homedir()).sort());
	});

	it("floor a write through the file tools", () => {
		for (const store of consentStorePaths(home)) {
			expect(check("write", { path: store }), store).toContain("permission rules");
			expect(check("edit", { file_path: store }), store).toBeDefined();
		}
	});

	it("floor a shell write, redirect or otherwise", () => {
		const store = forwardSlashes(consentStorePath("hooks", {}, home));
		expect(check("bash", { command: `echo '{}' > ${store}` })).toBeDefined();
		expect(check("bash", { command: `python3 -c 'import sys' ${store}` })).toBeDefined();
		expect(check("powershell", { command: `Set-Content -Path ${store} -Value x` })).toBeDefined();
	});

	it("floor a store under any literal .onecode, and a relocated state dir", () => {
		expect(check("write", { path: join(tmpdir(), "elsewhere", ".onecode", "mcp", "project-approvals.json") })).toBeDefined();
		process.env.ONECODE_STATE_DIR = join(home, "relocated");
		expect(check("write", { path: join(home, "relocated", "lsp", "trusted-projects.json") })).toBeDefined();
	});

	it("leave the rest of the state dir alone", () => {
		expect(check("write", { path: join(home, ".onecode", "plans", "brave-new-plan.md") })).toBeUndefined();
		expect(check("write", { path: join(home, ".onecode", "hooks", "hooks-decisions.jsonl") })).toBeUndefined();
	});
});
