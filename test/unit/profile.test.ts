/**
 * The profile in force (lib/profile/profile.ts), the feature() wrapper's view of pi
 * (lib/profile/feature.ts), and the permission gate's use of the tool switches.
 */
import { afterEach, describe, expect, it } from "vitest";
import { childExtensionPaths } from "../../extensions/lib/agents/child-extensions.ts";
import { feature, profiledPi } from "../../extensions/lib/profile/feature.ts";
import { activeProfile, resolveProfile, setActiveProfileForTest, TEXT_GROUP_READERS } from "../../extensions/lib/profile/profile.ts";
import { isFeatureId } from "../../extensions/lib/profile/features.ts";
import type { Profile } from "../../extensions/lib/profile/profile-contract.ts";
import { profile as shippedProfile } from "../../profile/index.ts";
import { discoverPlugins, invalidatePluginsCache } from "../../extensions/lib/plugins/plugins.ts";
import { autoMemoryEnabled, resetAutoMemoryForTest } from "../../extensions/lib/context/auto-memory.ts";
import { DEFER_CHANNEL } from "../../extensions/lib/request/deferred.ts";
import { watchMcpTools } from "../../extensions/lib/plugins/mcp-share.ts";
import { scanSkills } from "../../extensions/lib/plugins/skill-scan.ts";
import { decide } from "../../extensions/lib/rules/matcher.ts";
import { ALLOWLIST_ESSENTIALS, agentToolOptions } from "../../extensions/lib/agents/agent-catalog.ts";
import { PINNED_TOOLS } from "../../extensions/lib/profile/profile.ts";
import { WITHHOLD_CHANNEL } from "../../extensions/lib/request/deferred.ts";
import toolSearchExtension from "../../extensions/request/tool-search/index.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { makeToolSearchFakePi } from "./helpers/tool-search-fake-pi.ts";
import { envName } from "../../extensions/lib/profile/brand.mjs";

const empty: Profile = { features: {}, tools: {}, childExtensions: [], text: shippedProfile.text };
const use = (profile: Partial<Profile>, env: NodeJS.ProcessEnv = {}) =>
	setActiveProfileForTest(resolveProfile({ ...empty, ...profile }, env, "/profile"));

afterEach(() => setActiveProfileForTest(undefined));

const endsWith = (paths: string[], entry: string) => paths.some((p) => p.replaceAll("\\", "/").endsWith(entry));
const tool = (name: string) => ({ name, label: name, description: name, parameters: {}, execute: async () => ({ content: [], details: {} }) });

describe("resolveProfile", () => {
	it("One Code's shipped profile turns nothing off and sets no tool switch", () => {
		const shipped = activeProfile();
		expect(shipped.tools.size).toBe(0);
		expect(shipped.childExtensionPaths).toEqual([]);
	});

	it("ONECODE_TOOLS_OFF only turns tools off", () => {
		const resolved = resolveProfile({ ...empty, tools: { web_fetch: { deferred: false } } }, { [envName("TOOLS_OFF")]: "web_fetch, notebook_edit" }, "/p");
		expect(resolved.tools.get("web_fetch")).toEqual({ deferred: false, enabled: false });
		expect(resolved.tools.get("notebook_edit")).toEqual({ enabled: false });
	});

	it("pins every tool a child cannot work without", () => {
		for (const name of ALLOWLIST_ESSENTIALS) expect(PINNED_TOOLS.has(name), name).toBe(true);
		expect(() => resolveProfile({ ...empty, tools: { SubagentHandback: { enabled: false } } }, {}, "/p")).toThrow(/"SubagentHandback" cannot be turned off/);
		expect(() => resolveProfile(empty, { [envName("TOOLS_OFF")]: "structured_output" }, "/p")).toThrow(/"structured_output" cannot be turned off/);
	});

	it("lets only a profile, never the environment, turn off a guard feature", () => {
		expect(resolveProfile({ ...empty, features: { hooks: false } }, {}, "/p").features.has("hooks")).toBe(false);
		expect(() => resolveProfile(empty, { [envName("FEATURES_OFF")]: "hooks" }, "/p")).toThrow(/cannot turn off "hooks": it guards tool calls/);
		expect(() => resolveProfile(empty, { [envName("FEATURES_OFF")]: "file-tracker" }, "/p")).toThrow(/cannot turn off "file-tracker"/);
		// Turning plugins off drops the hooks installed plugins bring.
		expect(() => resolveProfile(empty, { [envName("FEATURES_OFF")]: "plugins" }, "/p")).toThrow(/cannot turn off "plugins"/);
	});

	it("refuses a switch that misses a base tool by spelling, and passes a product's own tool", () => {
		expect(() => resolveProfile(empty, { [envName("TOOLS_OFF")]: "Bash,WebFetch" }, "/p")).toThrow(/no tool is named "Bash": the switch for "bash" is spelled "bash"; no tool is named "WebFetch".*"web_fetch"/);
		expect(() => resolveProfile({ ...empty, tools: { Write: { enabled: false } } }, {}, "/p")).toThrow(/no tool is named "Write"/);
		expect(() => resolveProfile({ ...empty, tools: { toolsearch: { deferred: false } } }, {}, "/p")).toThrow(/spelled "tool_search"/);
		const resolved = resolveProfile({ ...empty, tools: { product_tool: { autoAllow: true }, mcp__srv__Read: { enabled: false }, Agent: { deferred: true } } }, {}, "/p");
		expect(resolved.disabledTools.has("mcp__srv__Read")).toBe(true);
	});

	it("refuses a profile that leaves out a text group a feature that is on reads", () => {
		const without = (...groups: string[]): Profile["text"] => (env) => Object.fromEntries(Object.entries(shippedProfile.text(env)).filter(([group]) => !groups.includes(group))) as ReturnType<Profile["text"]>;
		// The owner off is not enough while another reader is on: an isolated child of subagents is refused through worktreeGuard.
		expect(() => resolveProfile({ ...empty, features: { worktree: false }, text: without("worktreeGuard") }, {}, "/p")).toThrow(/no text for "worktreeGuard", which "subagents", "workflow" read/);
		expect(() => resolveProfile({ ...empty, features: { subagents: false, workflow: false }, text: without("subagentModels") }, {}, "/p")).toThrow(/no text for "subagentModels", which "doctor" reads/);
		expect(() => resolveProfile({ ...empty, text: without("notebook", "shell") }, {}, "/p")).toThrow(/no text for "notebook", which "notebook" reads; it has no text for "shell", which "bash", "powershell" read/);
		const off = { worktree: false, subagents: false, workflow: false, doctor: false, notebook: false } as const;
		expect(resolveProfile({ ...empty, features: off, text: without("worktreeGuard", "subagentModels", "handback", "notebook", "worktree", "subagents", "workflow", "doctor") }, {}, "/p").text.notebook).toBeUndefined();
	});

	it("names a reader for every optional text group, and only features", () => {
		for (const [group, readers] of Object.entries(TEXT_GROUP_READERS)) {
			expect(readers.length, group).toBeGreaterThan(0);
			for (const id of readers) expect(isFeatureId(id), `${group}: ${id}`).toBe(true);
		}
	});

	it("refuses turning off or deferring tool_search", () => {
		expect(() => resolveProfile({ ...empty, tools: { tool_search: { enabled: false } } }, {}, "/p")).toThrow(/"tool_search" cannot be turned off/);
		expect(() => resolveProfile({ ...empty, tools: { tool_search: { deferred: true } } }, {}, "/p")).toThrow(/"tool_search" cannot be deferred/);
		expect(() => resolveProfile(empty, { [envName("TOOLS_OFF")]: "tool_search" }, "/p")).toThrow(/cannot be turned off/);
	});

	it("merges ONECODE_FEATURES_OFF and reports every problem at once", () => {
		expect(resolveProfile(empty, { [envName("FEATURES_OFF")]: "mcp" }, "/p").features.has("mcp")).toBe(false);
		expect(() => resolveProfile({ ...empty, tools: { tool_search: { enabled: false } } }, { [envName("FEATURES_OFF")]: "ledger,nope" }, "/p")).toThrow(
			/unknown feature "nope".*"ledger" is part of the safety core.*"tool_search" cannot be turned off/,
		);
	});

	it("resolves child extensions against the profile folder, after the base's", () => {
		use({ childExtensions: ["ballerina/index.ts"] });
		const paths = childExtensionPaths();
		expect(paths.at(-1)).toBe("/profile/ballerina/index.ts");
		expect(endsWith(paths, "tools/notebook/index.ts")).toBe(true);
	});

	it("leaves a turned-off feature's entries out of the child list", () => {
		use({ features: { notebook: false } });
		expect(endsWith(childExtensionPaths(), "tools/notebook/index.ts")).toBe(false);
	});
});

describe("feature()", () => {
	it("skips the factory of a feature the profile turns off", () => {
		use({ features: { notebook: false } });
		let ran = false;
		feature("notebook", () => {
			ran = true;
		})(createFakePi().pi as never);
		expect(ran).toBe(false);
	});

	it("passes pi through untouched when no tool switch is set", () => {
		use({});
		const fake = createFakePi();
		expect(profiledPi(fake.pi as never)).toBe(fake.pi);
	});

	it("never registers a disabled tool and drops it from setActiveTools", () => {
		use({ tools: { notebook_edit: { enabled: false } } });
		const fake = createFakePi();
		const pi = profiledPi(fake.pi as never);
		pi.registerTool(tool("notebook_edit") as never);
		pi.registerTool(tool("web_fetch") as never);
		pi.setActiveTools(["read", "notebook_edit", "web_fetch"]);
		expect([...fake.tools.keys()]).toEqual(["web_fetch"]);
		expect(fake.getActiveTools()).toEqual(["read", "web_fetch"]);
	});

});

describe("tool-search and the tool switches", () => {
	it("keeps a disabled built-in out of the active set and ignores overridden deferral requests", () => {
		use({ tools: { edit: { enabled: false }, notebook_edit: { deferred: false } } });
		const fake = makeToolSearchFakePi(["read", "edit"]);
		toolSearchExtension(fake.pi as never);
		fake.addDeferred("notebook_edit");
		fake.addDeferred("web_fetch");
		fake.pi.fire("session_start", {});
		expect(fake.activeTools()).not.toContain("edit");
		expect(fake.activeTools()).toContain("notebook_edit");
		const listing = fake.reminders.filter((r) => r.key === "deferred-tools").at(-1)?.text ?? "";
		expect(listing).toContain("web_fetch");
		expect(listing).not.toContain("notebook_edit");
	});

	it("defers a tool the profile defers however it was registered, a built-in included", () => {
		use({ tools: { grep: { deferred: true } } });
		const fake = makeToolSearchFakePi(["read", "grep"]);
		toolSearchExtension(fake.pi as never);
		fake.allTools.push({ name: "read", description: "read tool" }, { name: "grep", description: "grep tool" });
		fake.addDeferred("web_fetch");
		fake.pi.fire("session_start", {});
		const listing = fake.reminders.filter((r) => r.key === "deferred-tools").at(-1)?.text ?? "";
		expect(listing).toContain("grep");
		expect(fake.activeTools()).not.toContain("grep");
	});

	it("still withholds a tool the profile keeps up front", () => {
		use({ tools: { task_create: { deferred: false } } });
		const fake = makeToolSearchFakePi(["read"]);
		toolSearchExtension(fake.pi as never);
		fake.addDeferred("task_create");
		fake.pi.fire("session_start", {});
		expect(fake.activeTools()).toContain("task_create");
		fake.pi.events.emit(WITHHOLD_CHANNEL, { name: "task_create" });
		expect(fake.activeTools()).not.toContain("task_create");
		fake.pi.events.emit(DEFER_CHANNEL, { name: "task_create" });
		expect(fake.activeTools()).toContain("task_create");
	});
});

describe("child sessions and the tool switches", () => {
	it("adds the disabled tools to pi's excludeTools", () => {
		use({ tools: { web_fetch: { enabled: false } } });
		expect(agentToolOptions({ excludeTools: ["edit"] } as never).excludeTools).toEqual(["edit", "web_fetch"]);
		setActiveProfileForTest(undefined);
		expect(agentToolOptions({ excludeTools: ["edit"] } as never).excludeTools).toEqual(["edit"]);
	});
});

describe("permission gate and tool switches", () => {
	const base = { subject: "", cwd: process.cwd(), deny: [], ask: [], allow: [] };

	it("denies a disabled tool in every mode, bypass included", () => {
		use({ tools: { notebook_edit: { enabled: false } } });
		for (const mode of ["default", "auto", "bypassPermissions", "acceptEdits"] as const) {
			expect(decide({ ...base, mode, toolName: "notebook_edit" })).toEqual({ decision: "deny", cause: "profile-disabled" });
		}
	});

	it("matches a switch by the tool's registered name, whatever its case", () => {
		use({ tools: { BallerinaReference: { autoAllow: true }, NotebookTool: { enabled: false } } });
		expect(decide({ ...base, mode: "default", toolName: "BallerinaReference" }).decision).toBe("allow");
		expect(decide({ ...base, mode: "default", toolName: "NotebookTool" })).toEqual({ decision: "deny", cause: "profile-disabled" });
	});

	it("keeps plan mode's rules for a profile's auto-allowed tool", () => {
		use({ tools: { ballerina_build: { autoAllow: true } } });
		expect(decide({ ...base, mode: "plan", toolName: "ballerina_build" }).decision).not.toBe("allow");
		expect(decide({ ...base, mode: "plan", toolName: "tool_search" }).decision).toBe("allow");
	});

	it("allows a tool the profile marks autoAllow without a prompt", () => {
		use({ tools: { ballerina_reference: { autoAllow: true } } });
		expect(decide({ ...base, mode: "default", toolName: "ballerina_reference" }).decision).toBe("allow");
		setActiveProfileForTest(undefined);
		expect(decide({ ...base, mode: "default", toolName: "ballerina_reference" }).decision).not.toBe("allow");
	});
});

describe("the plugins feature switch", () => {
	it("hides every plugin from discovery, so no plugin resource reaches another feature", () => {
		use({ features: { plugins: false } });
		invalidatePluginsCache();
		const found = discoverPlugins({ claudePluginsDir: "/nonexistent/claude", oneCodeRoot: "/nonexistent/onecode", cwd: "/", home: "/nonexistent" } as never);
		expect(found.plugins).toEqual([]);
		expect(found.agentDirs).toEqual([]);
		expect(found.skills).toEqual([]);
		expect(found.mcpConfigs).toEqual([]);
	});
});

describe("resources a feature owns, read by other features", () => {
	it("reports no auto-memory, no shared MCP tools and no skills when those features are off", async () => {
		use({ features: { memory: false, mcp: false, skill: false } });
		resetAutoMemoryForTest();
		expect(autoMemoryEnabled("/")).toBe(false);
		const started = Date.now();
		expect(await watchMcpTools(createFakePi().events, 10_000)()).toEqual([]);
		expect(Date.now() - started).toBeLessThan(1000);
		expect(scanSkills("/", "/nonexistent", "/nonexistent", [])).toEqual([]);
		resetAutoMemoryForTest();
	});
});
