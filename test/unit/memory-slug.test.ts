import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigModeForTest } from "../../extensions/lib/config-mode.ts";
import { memoryDir, projectSlug } from "../../extensions/lib/memory.ts";
import { oneCodeProjectSettingsPathFor } from "../../extensions/lib/one-code-settings.ts";

// Golden suffixes come from Claude Code 2.1.296's DO/Le/Use expressions:
// 200 sanitized characters, then "-" and abs(signed UTF-16 hash).toString(36).
describe("projectSlug long-path compatibility", () => {
	let scratch: string | undefined;

	beforeEach(() => resetConfigModeForTest("claude-compatible"));
	afterEach(() => {
		if (scratch) rmSync(scratch, { recursive: true, force: true });
		scratch = undefined;
		resetConfigModeForTest();
	});

	it("leaves exactly 200 sanitized characters unhashed", () => {
		expect(projectSlug(`/tmp/${"a".repeat(195)}`)).toBe(`-tmp-${"a".repeat(195)}`);
	});

	it("adds the original path's base-36 hash at 201 characters", () => {
		expect(projectSlug(`/tmp/${"a".repeat(196)}`)).toBe(`-tmp-${"a".repeat(195)}-r0traf`);
	});

	it("hashes the original Unicode text rather than the sanitized slug", () => {
		const prefix = `/tmp/${"a".repeat(195)}`;
		expect(projectSlug(`${prefix}é`)).toBe(`-tmp-${"a".repeat(195)}-r0tre7`);
		expect(projectSlug(`${prefix}ø`)).toBe(`-tmp-${"a".repeat(195)}-r0trem`);
	});

	it("hashes UTF-16 code units with signed 32-bit overflow and an absolute suffix", () => {
		expect(projectSlug(`/tmp/${"a".repeat(195)}😀`)).toBe(`-tmp-${"a".repeat(195)}-emo82r`);
	});

	it("uses the full path to distinguish identical 200-character prefixes", () => {
		const prefix = `/tmp/${"a".repeat(195)}`;
		expect(projectSlug(`${prefix}/one`)).toBe(`-tmp-${"a".repeat(195)}-n9tre7`);
		expect(projectSlug(`${prefix}/two`)).toBe(`-tmp-${"a".repeat(195)}-n9tngp`);
	});

	it("preserves short-path Unicode replacement without normalizing the input", () => {
		expect(projectSlug("/tmp/café")).toBe("-tmp-caf-");
		expect(projectSlug("/tmp/cafe\u0301")).toBe("-tmp-cafe-");
		expect(projectSlug("/tmp/😀")).toBe("-tmp---");
	});

	it.each([201, 255])("retains existing legacy settings for a %i-character project root", (length) => {
		const root = mkdtempSync(join(os.tmpdir(), "memory-slug-"));
		scratch = root;
		const project = `/tmp/${"a".repeat(length - 5)}`;
		const uncapped = project.replace(/[^A-Za-z0-9-]/g, "-");
		const legacy = join(root, ".onecode", "projects", uncapped, "settings.json");
		mkdirSync(join(legacy, ".."), { recursive: true });
		const saved = JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] }, hasTrustDialogAccepted: true });
		writeFileSync(legacy, saved);

		expect(oneCodeProjectSettingsPathFor(project, root, {})).toBe(legacy);
		expect(readFileSync(legacy, "utf8")).toBe(saved);
		expect(existsSync(join(root, ".onecode", "projects", projectSlug(project), "settings.json"))).toBe(false);
	});

	it("uses hashed settings for new roots but prefers legacy state when both files exist", () => {
		const root = mkdtempSync(join(os.tmpdir(), "memory-slug-"));
		scratch = root;
		const project = `/tmp/${"a".repeat(196)}`;
		const hashed = join(root, ".onecode", "projects", projectSlug(project), "settings.json");
		expect(oneCodeProjectSettingsPathFor(project, root, {})).toBe(hashed);
		mkdirSync(join(hashed, ".."), { recursive: true });
		writeFileSync(hashed, "{}");
		const legacy = join(root, ".onecode", "projects", project.replace(/[^A-Za-z0-9-]/g, "-"), "settings.json");
		mkdirSync(join(legacy, ".."), { recursive: true });
		writeFileSync(legacy, '{"permissions":{"deny":["Write"]}}');
		expect(oneCodeProjectSettingsPathFor(project, root, {})).toBe(legacy);
		expect(readFileSync(hashed, "utf8")).toBe("{}");
	});

	it("creates a memory directory for a real project path longer than a filesystem component", () => {
		const root = mkdtempSync(join(os.tmpdir(), "memory-slug-"));
		scratch = root;
		const project = join(root, "a".repeat(100), "b".repeat(100), "c".repeat(100));
		mkdirSync(project, { recursive: true });
		expect(project.length).toBeGreaterThan(255);

		// The former uncapped slug turns the whole absolute project path into
		// one component. Confirm the real filesystem failure before testing the fix.
		const uncapped = project.replace(/[^A-Za-z0-9-]/g, "-");
		expect(() => mkdirSync(join(root, "uncapped", uncapped, "memory"), { recursive: true })).toThrow();

		const dir = memoryDir(join(root, "home"), project);
		mkdirSync(dir, { recursive: true });
		expect(statSync(dir).isDirectory()).toBe(true);
		expect(basename(join(dir, ".."))).toMatch(/^[A-Za-z0-9-]{200}-[a-z0-9]+$/);
	});
});
