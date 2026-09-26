/**
 * The read tools' outside-read fast path (auto mode, frontier and workhorse
 * models) must not read the harness's own secret stores unclassified, nor
 * search a directory tree whose credentials no check of the named path sees.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { runtimeSecretPaths } from "../../extensions/lib/permission-gate.ts";
import { decide } from "../../extensions/permissions/matcher.ts";

const cwd = join(tmpdir(), "harness-secret-reads-project");
const secretPaths = runtimeSecretPaths(homedir());
const capable = {
	cwd,
	mode: "auto" as const,
	deny: [],
	ask: [],
	allow: [],
	claudeCodeFastPaths: true,
	secretPaths,
};

const saved = { claude: process.env.CLAUDE_CONFIG_DIR, state: process.env.ONECODE_STATE_DIR };
afterEach(() => {
	if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = saved.claude;
	if (saved.state === undefined) delete process.env.ONECODE_STATE_DIR;
	else process.env.ONECODE_STATE_DIR = saved.state;
});

describe("the harness's own secret stores", () => {
	const home = homedir();
	const stores = [
		join(home, ".onecode", "settings.json"),
		join(home, ".onecode", "mcp-auth", "github-0badc0de.json"),
		join(getAgentDir(), "models.json"),
		join(getAgentDir(), "auth.json"),
		join(home, ".claude", "settings.json"),
		join(home, ".claude.json"),
	];

	it.each(stores)("classifies an outside read of %s", (path) => {
		expect(decide({ ...capable, toolName: "read", subject: path }).decision).toBe("classify");
	});

	it("keeps the fast path for an ordinary outside read", () => {
		expect(decide({ ...capable, toolName: "read", subject: "/etc/hosts" })).toMatchObject({ decision: "allow", cause: "outside-read" });
		expect(decide({ ...capable, toolName: "read", subject: join(home, ".claude", "CLAUDE.md") })).toMatchObject({ decision: "allow", cause: "outside-read" });
	});

	it("follows a relocated CLAUDE_CONFIG_DIR and ONECODE_STATE_DIR", () => {
		process.env.CLAUDE_CONFIG_DIR = "/tmp/relocated-cc";
		process.env.ONECODE_STATE_DIR = "/tmp/relocated-oc";
		const relocated = runtimeSecretPaths(home);
		for (const path of ["/tmp/relocated-cc/settings.json", "/tmp/relocated-cc/.claude.json", "/tmp/relocated-oc/settings.json", "/tmp/relocated-oc/mcp-auth/x.json"]) {
			expect(decide({ ...capable, secretPaths: relocated, toolName: "read", subject: path }).decision, path).toBe("classify");
		}
	});

	it("are not working space inside a workspace directory", () => {
		const stateDir = join(home, ".onecode");
		expect(decide({ ...capable, mode: "default", toolName: "read", subject: join(stateDir, "settings.json"), workspaceDirs: [stateDir] }).decision).toBe("ask");
		expect(decide({ ...capable, mode: "default", toolName: "read", subject: join(stateDir, "plans", "p.md"), workspaceDirs: [stateDir] }).decision).toBe("allow");
	});
});

describe("an outside content search", () => {
	const root = mkdtempSync(join(tmpdir(), "harness-secret-grep-"));
	mkdirSync(join(root, "sub"));
	writeFileSync(join(root, "sub", "notes.txt"), "x");
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("classifies a grep rooted at a directory, the home directory included", () => {
		expect(decide({ ...capable, toolName: "grep", subject: homedir() }).decision).toBe("classify");
		expect(decide({ ...capable, toolName: "grep", subject: root }).decision).toBe("classify");
		expect(decide({ ...capable, toolName: "grep", subject: join(root, "missing") }).decision).toBe("classify");
	});

	it("keeps the fast path for a grep of one file and for listings", () => {
		expect(decide({ ...capable, toolName: "grep", subject: join(root, "sub", "notes.txt") })).toMatchObject({ decision: "allow", cause: "outside-read" });
		expect(decide({ ...capable, toolName: "ls", subject: root })).toMatchObject({ decision: "allow", cause: "outside-read" });
		expect(decide({ ...capable, toolName: "find", subject: root })).toMatchObject({ decision: "allow", cause: "outside-read" });
	});
});
