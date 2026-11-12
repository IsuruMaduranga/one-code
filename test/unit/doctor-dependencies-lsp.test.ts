/** /doctor checks language servers only for a session that has the language-server tool. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDependencies } from "../../extensions/commands/doctor/dependencies.ts";
import { setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import { useProfile } from "./helpers/profile.ts";

describe("checkDependencies and the lsp feature", () => {
	let cwd: string | undefined;
	afterEach(() => {
		setActiveProfileForTest(undefined);
		if (cwd) rmSync(cwd, { recursive: true, force: true });
	});

	const report = () => {
		cwd = mkdtempSync(join(tmpdir(), "doctor-lsp-"));
		writeFileSync(join(cwd, "go.mod"), "module x");
		return checkDependencies({ cwd, env: { PATH: "" }, platform: "darwin", mcpServers: [], webSearchSettings: {} });
	};

	it("lists the project's language server and warns when it is missing", () => {
		const { checks, findings } = report();
		expect(checks.find((check) => check.name === "gopls")).toMatchObject({ found: false, need: "project" });
		expect(findings.some((finding) => finding.text.includes("gopls is not installed"))).toBe(true);
	});

	it("says nothing about language servers when the feature is off", () => {
		useProfile({ features: { lsp: false } });
		const { checks, findings } = report();
		expect(checks.some((check) => check.name === "gopls")).toBe(false);
		expect(findings.some((finding) => finding.text.includes("language-server"))).toBe(false);
	});
});
