import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPermissionSettings, persistAllowRule } from "../../extensions/permissions/settings.ts";

let dir: string;
let home: string;
let cwd: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cc-settings-"));
	home = join(dir, "home");
	cwd = join(dir, "project");
	mkdirSync(join(home, ".claude"), { recursive: true });
	mkdirSync(join(cwd, ".claude"), { recursive: true });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const write = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data));

describe("loadPermissionSettings", () => {
	it("merges user, project, and local files with local defaultMode winning", () => {
		write(join(home, ".claude", "settings.json"), {
			permissions: { allow: ["Bash(ls:*)"], defaultMode: "default" },
		});
		write(join(cwd, ".claude", "settings.json"), {
			permissions: { allow: ["Read"], deny: ["Bash(rm -rf:*)"], defaultMode: "acceptEdits" },
		});
		write(join(cwd, ".claude", "settings.local.json"), {
			permissions: { ask: ["Bash(git push:*)"] },
		});

		const s = loadPermissionSettings(cwd, home);
		expect(s.allow).toEqual(["Bash(ls:*)", "Read"]);
		expect(s.deny).toEqual(["Bash(rm -rf:*)"]);
		expect(s.ask).toEqual(["Bash(git push:*)"]);
		expect(s.defaultMode).toBe("acceptEdits");
	});

	it("tolerates missing and malformed files", () => {
		writeFileSync(join(cwd, ".claude", "settings.json"), "{not json");
		const s = loadPermissionSettings(cwd, home);
		expect(s).toEqual({ allow: [], deny: [], ask: [] });
	});
});

describe("persistAllowRule", () => {
	it("creates the file and appends without duplicating", () => {
		const target = join(cwd, ".claude", "settings.local.json");
		persistAllowRule("Bash(npm test:*)", target);
		persistAllowRule("Bash(npm test:*)", target);
		persistAllowRule("Read", target);
		const parsed = JSON.parse(readFileSync(target, "utf-8"));
		expect(parsed.permissions.allow).toEqual(["Bash(npm test:*)", "Read"]);
	});

	it("preserves unrelated keys", () => {
		const target = join(cwd, ".claude", "settings.json");
		write(target, { model: "opus", permissions: { deny: ["Bash(sudo:*)"] } });
		persistAllowRule("Read", target);
		const parsed = JSON.parse(readFileSync(target, "utf-8"));
		expect(parsed.model).toBe("opus");
		expect(parsed.permissions.deny).toEqual(["Bash(sudo:*)"]);
		expect(parsed.permissions.allow).toEqual(["Read"]);
	});
});
