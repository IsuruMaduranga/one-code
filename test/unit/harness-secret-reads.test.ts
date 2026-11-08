/**
 * The read tools' outside-read fast path (auto mode, frontier and workhorse
 * models) must not read the harness's own secret stores unclassified, nor
 * search a directory tree whose credentials no check of the named path sees.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { runtimeSecretPaths } from "../../extensions/lib/permission-gate.ts";
import { decide } from "../../extensions/permissions/matcher.ts";
import { envName, productStateDir } from "../../extensions/lib/brand.mjs";
import { productSettingsPath } from "../../extensions/lib/product-settings.ts";
import { stubHome } from "./helpers/home.ts";

const cwd = join(tmpdir(), "harness-secret-reads-project");
const home = mkdtempSync(join(tmpdir(), "harness-secret-home-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => stubHome(home));
afterEach(() => vi.unstubAllEnvs());

/** A frontier model's auto-mode request, with the secret paths of the environment in force. */
const capable = () => ({
	cwd,
	mode: "auto" as const,
	deny: [],
	ask: [],
	allow: [],
	claudeCodeFastPaths: true,
	secretPaths: runtimeSecretPaths(home),
});

describe("the harness's own secret stores", () => {
	const stores: [string, () => string][] = [
		["the product's settings", () => productSettingsPath(home)],
		["an MCP server's stored token", () => join(productStateDir(), "mcp-auth", "github-0badc0de.json")],
		["pi's models.json", () => join(getAgentDir(), "models.json")],
		["pi's auth.json", () => join(getAgentDir(), "auth.json")],
		["~/.claude/settings.json", () => join(home, ".claude", "settings.json")],
		["~/.claude.json", () => join(home, ".claude.json")],
	];

	it.each(stores)("classifies an outside read of %s", (_name, path) => {
		expect(decide({ ...capable(), toolName: "read", subject: path() }).decision).toBe("classify");
	});

	it("keeps the fast path for an ordinary outside read", () => {
		expect(decide({ ...capable(), toolName: "read", subject: "/etc/hosts" })).toMatchObject({ decision: "allow", cause: "outside-read" });
		expect(decide({ ...capable(), toolName: "read", subject: join(home, ".claude", "CLAUDE.md") })).toMatchObject({ decision: "allow", cause: "outside-read" });
	});

	it("follows a relocated CLAUDE_CONFIG_DIR and product state directory", () => {
		vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/relocated-cc");
		vi.stubEnv(envName("STATE_DIR"), "/tmp/relocated-oc");
		const relocated = runtimeSecretPaths(home);
		for (const path of ["/tmp/relocated-cc/settings.json", "/tmp/relocated-cc/.claude.json", "/tmp/relocated-oc/settings.json", "/tmp/relocated-oc/mcp-auth/x.json"]) {
			expect(decide({ ...capable(), secretPaths: relocated, toolName: "read", subject: path }).decision, path).toBe("classify");
		}
	});

	it("are not working space inside a workspace directory", () => {
		const stateDir = productStateDir();
		expect(decide({ ...capable(), mode: "default", toolName: "read", subject: join(stateDir, "settings.json"), workspaceDirs: [stateDir] }).decision).toBe("ask");
		expect(decide({ ...capable(), mode: "default", toolName: "read", subject: join(stateDir, "plans", "p.md"), workspaceDirs: [stateDir] }).decision).toBe("allow");
	});
});

describe("an outside content search", () => {
	const root = mkdtempSync(join(tmpdir(), "harness-secret-grep-"));
	mkdirSync(join(root, "sub"));
	writeFileSync(join(root, "sub", "notes.txt"), "x");
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("classifies a grep rooted at a directory, the home directory included", () => {
		expect(decide({ ...capable(), toolName: "grep", subject: home }).decision).toBe("classify");
		expect(decide({ ...capable(), toolName: "grep", subject: root }).decision).toBe("classify");
		expect(decide({ ...capable(), toolName: "grep", subject: join(root, "missing") }).decision).toBe("classify");
	});

	it("keeps the fast path for a grep of one file and for listings", () => {
		expect(decide({ ...capable(), toolName: "grep", subject: join(root, "sub", "notes.txt") })).toMatchObject({ decision: "allow", cause: "outside-read" });
		expect(decide({ ...capable(), toolName: "ls", subject: root })).toMatchObject({ decision: "allow", cause: "outside-read" });
		expect(decide({ ...capable(), toolName: "find", subject: root })).toMatchObject({ decision: "allow", cause: "outside-read" });
	});
});
