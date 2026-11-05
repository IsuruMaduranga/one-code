/**
 * The profile in force (lib/profile.ts), the feature() wrapper's view of pi
 * (lib/feature.ts), and the permission gate's use of the tool switches.
 */
import { afterEach, describe, expect, it } from "vitest";
import { childExtensionPaths } from "../../extensions/lib/child-extensions.ts";
import { feature, profiledPi } from "../../extensions/lib/feature.ts";
import { activeProfile, resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile.ts";
import type { Profile } from "../../extensions/lib/profile-contract.ts";
import { decide } from "../../extensions/permissions/matcher.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

const DEFER = "one-code:defer-tool";
const empty: Profile = { features: {}, tools: {}, childExtensions: [] };
const use = (profile: Partial<Profile>, env: NodeJS.ProcessEnv = {}) =>
	setActiveProfileForTest(resolveProfile({ ...empty, ...profile }, env, "/profile"));

afterEach(() => setActiveProfileForTest(undefined));

const tool = (name: string) => ({ name, label: name, description: name, parameters: {}, execute: async () => ({ content: [], details: {} }) });

describe("resolveProfile", () => {
	it("One Code's shipped profile turns nothing off and sets no tool switch", () => {
		const shipped = activeProfile();
		expect(shipped.tools.size).toBe(0);
		expect(shipped.childExtensionPaths).toEqual([]);
	});

	it("ONECODE_TOOLS_OFF only turns tools off", () => {
		const resolved = resolveProfile({ ...empty, tools: { web_fetch: { deferred: false } } }, { ONECODE_TOOLS_OFF: "web_fetch, notebook_edit" }, "/p");
		expect(resolved.tools.get("web_fetch")).toEqual({ deferred: false, enabled: false });
		expect(resolved.tools.get("notebook_edit")).toEqual({ enabled: false });
	});

	it("refuses turning off or deferring tool_search", () => {
		expect(() => resolveProfile({ ...empty, tools: { tool_search: { enabled: false } } }, {}, "/p")).toThrow(/"tool_search" cannot be turned off/);
		expect(() => resolveProfile({ ...empty, tools: { tool_search: { deferred: true } } }, {}, "/p")).toThrow(/"tool_search" cannot be deferred/);
		expect(() => resolveProfile(empty, { ONECODE_TOOLS_OFF: "tool_search" }, "/p")).toThrow(/cannot be turned off/);
	});

	it("resolves child extensions against the profile folder, after the base's", () => {
		use({ childExtensions: ["ballerina/index.ts"] });
		const paths = childExtensionPaths();
		expect(paths.at(-1)).toBe("/profile/ballerina/index.ts");
		expect(paths.some((p) => p.replaceAll("\\", "/").endsWith("notebook/index.ts"))).toBe(true);
	});

	it("leaves a turned-off feature's entries out of the child list", () => {
		use({ features: { notebook: false } });
		expect(childExtensionPaths().some((p) => p.replaceAll("\\", "/").endsWith("notebook/index.ts"))).toBe(false);
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

	it("applies the profile's deferral choice", () => {
		use({ tools: { notebook_edit: { deferred: false }, web_fetch: { deferred: true } } });
		const fake = createFakePi();
		const deferred: string[] = [];
		fake.events.on(DEFER, (data) => deferred.push((data as { name: string }).name));
		const pi = profiledPi(fake.pi as never);
		pi.registerTool(tool("notebook_edit") as never);
		pi.events.emit(DEFER, { name: "notebook_edit", keywords: ["notebook"] });
		pi.registerTool(tool("web_fetch") as never);
		pi.events.emit("other-channel", { name: "notebook_edit" });
		expect(deferred).toEqual(["web_fetch"]);
	});

	it("removes a disabled built-in from the active set when a session starts", async () => {
		use({ tools: { edit: { enabled: false } } });
		const fake = createFakePi();
		fake.setActiveTools(["read", "edit", "bash"]);
		feature("tool-search", () => {})(fake.pi as never);
		await fake.fire("session_start", {});
		expect(fake.getActiveTools()).toEqual(["read", "bash"]);
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

	it("allows a tool the profile marks autoAllow without a prompt", () => {
		use({ tools: { ballerina_reference: { autoAllow: true } } });
		expect(decide({ ...base, mode: "default", toolName: "ballerina_reference" }).decision).toBe("allow");
		setActiveProfileForTest(undefined);
		expect(decide({ ...base, mode: "default", toolName: "ballerina_reference" }).decision).not.toBe("allow");
	});
});
