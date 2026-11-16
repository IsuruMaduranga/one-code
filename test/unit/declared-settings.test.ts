/**
 * The settings a profile declares for its own extensions (`Profile.settings`,
 * lib/profile/declared-settings.ts): read leniently from the product's user
 * file and, when declared with `project`, its per-project file; refused at
 * load when the base reads the key itself; listed by /doctor.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectCompat } from "../../extensions/commands/doctor/compat.ts";
import { brand } from "../../extensions/lib/profile/brand.mjs";
import { productSetting } from "../../extensions/lib/profile/declared-settings.ts";
import { productProjectSettingsPath, productSettingsPath } from "../../extensions/lib/profile/product-settings.ts";
import { activeProfile, profileModuleKey, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import { shareModuleForTest } from "../../extensions/lib/profile/shared-module.ts";
import { BASE_PRODUCT_KEYS, type ProductSetting } from "../../extensions/lib/profile/settings-keys.ts";
import { useProfile } from "./helpers/profile.ts";
import { tempHome } from "./helpers/temp-home.ts";

afterEach(() => setActiveProfileForTest(undefined));

const SETTINGS: Record<string, ProductSetting> = {
	quiet: { type: "boolean", project: true, description: "Silences the notice" },
	greeting: { type: "string", description: "What the extension says first" },
	retries: { type: "number", project: true, description: "How often to retry" },
};

function write(path: string, content: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}

describe("a declared product setting", () => {
	it("reads the user file, then the per-project file for a project setting, the project's value winning", () => {
		useProfile({ settings: SETTINGS });
		const { home, cwd } = tempHome("declared-settings-");
		expect(productSetting("quiet", cwd, home)).toBeUndefined();
		write(productSettingsPath(home), { quiet: false, greeting: "hello", retries: 2 });
		expect([productSetting("quiet", cwd, home), productSetting("greeting", cwd, home), productSetting("retries", cwd, home)]).toEqual([false, "hello", 2]);
		write(productProjectSettingsPath(cwd, home), { quiet: true, greeting: "from the project", retries: 5 });
		// `greeting` is not a project setting: the per-project file is never read for it.
		expect([productSetting("quiet", cwd, home), productSetting("greeting", cwd, home), productSetting("retries", cwd, home)]).toEqual([true, "hello", 5]);
	});

	it("reads a missing or malformed file, or a value of another type, as that file not setting it", () => {
		useProfile({ settings: SETTINGS });
		const { home, cwd } = tempHome("declared-settings-lenient-");
		write(productSettingsPath(home), { quiet: "yes", greeting: 3, retries: 1 });
		write(productProjectSettingsPath(cwd, home), "{ not json");
		expect([productSetting("quiet", cwd, home), productSetting("greeting", cwd, home), productSetting("retries", cwd, home)]).toEqual([undefined, undefined, 1]);
		// A wrong type in the project file leaves the user file's value standing.
		write(productProjectSettingsPath(cwd, home), { retries: "many" });
		expect(productSetting("retries", cwd, home)).toBe(1);
		write(productSettingsPath(home), ["quiet"]);
		expect(productSetting("quiet", cwd, home)).toBeUndefined();
	});

	it("is never read from a repository's settings file", () => {
		useProfile({ settings: SETTINGS });
		const { home, cwd } = tempHome("declared-settings-repo-");
		write(join(cwd, ".claude", "settings.json"), { quiet: true });
		write(join(cwd, ".claude", "settings.local.json"), { quiet: true });
		write(join(cwd, brand.stateDir, "settings.json"), { quiet: true });
		expect(productSetting("quiet", cwd, home)).toBeUndefined();
	});

	it("throws on a key the profile does not declare, naming the declared ones", () => {
		useProfile({ settings: SETTINGS });
		const { home, cwd } = tempHome("declared-settings-undeclared-");
		expect(() => productSetting("quite", cwd, home)).toThrow(/"quite" is not a setting the profile declares \(declared: quiet, greeting, retries\)/);
		useProfile({});
		expect(() => productSetting("quiet", cwd, home)).toThrow(/declared: none/);
	});

	it("reads only a key the file holds itself, never one from Object.prototype", () => {
		const proto = Object.fromEntries<ProductSetting>([
			["constructor", { type: "boolean", description: "d" }],
			["toString", { type: "string", description: "d" }],
		]);
		useProfile({ settings: proto });
		const { home, cwd } = tempHome("declared-settings-proto-");
		write(productSettingsPath(home), {});
		expect([productSetting("constructor", cwd, home), productSetting("toString", cwd, home)]).toEqual([undefined, undefined]);
		write(productSettingsPath(home), '{"constructor": true, "__proto__": {"toString": "x"}}');
		expect([productSetting("constructor", cwd, home), productSetting("toString", cwd, home)]).toEqual([true, undefined]);
	});

	it("refuses the source provider's switch key, which the base reads from the product's user file", () => {
		useProfile({ settings: { savedMode: { type: "string", description: "d" } } });
		const provider = join(import.meta.dirname, "declared-settings-switch-provider");
		shareModuleForTest(profileModuleKey(provider), { sources: { switch: { key: "savedMode" } } });
		setActiveProfileForTest({ ...activeProfile(), sourcesModule: provider });
		const { home, cwd } = tempHome("declared-settings-switch-");
		write(productSettingsPath(home), { savedMode: "independent" });
		expect(() => productSetting("savedMode", cwd, home)).toThrow(/"savedMode" is the source provider's switch/);
	});

	it("is refused at load when the base reads the key, or when it lacks a type or a description", () => {
		for (const key of ["permissions", "autoMode", "env", "subagentModel", "hooks", "disableAllHooks", "enableAllProjectMcpServers", "hasSeenAutoModeOutsideReadPrompt", "preferredNotifChannel"]) {
			expect(BASE_PRODUCT_KEYS.has(key), key).toBe(true);
			expect(() => useProfile({ settings: { [key]: { type: "boolean", description: "d" } } }), key).toThrow(new RegExp(`the setting "${key}" is one the base reads`));
		}
		expect(() => useProfile({ settings: { odd: { type: "object" as never, description: "d" } } })).toThrow(/the setting "odd" has type "object"/);
		expect(() => useProfile({ settings: { bare: { type: "boolean", description: " " } } })).toThrow(/the setting "bare" needs a description/);
	});
});

describe("/doctor's settings files", () => {
	it("list a declared setting as read, with its description, from the files it is read from", () => {
		useProfile({ settings: SETTINGS });
		const { home, cwd } = tempHome("declared-settings-doctor-");
		write(productSettingsPath(home), { quiet: false, greeting: 7, unknownKey: 1 });
		write(productProjectSettingsPath(cwd, home), { quiet: true, greeting: "no" });
		const compat = collectCompat({ cwd, home, agentDir: join(home, brand.stateDir, "agent"), env: { HOME: home, PATH: "" } as NodeJS.ProcessEnv });
		const user = compat.files.find((file) => file.scope === "product-user");
		const local = compat.files.find((file) => file.scope === "product-local");
		expect(user?.used).toContain("quiet: false (Silences the notice)");
		expect(user?.ignored).toEqual(expect.arrayContaining(["greeting (not a string)", "unknownKey"]));
		expect(local?.used).toContain("quiet: true (Silences the notice)");
		// `greeting` is not a project setting.
		expect(local?.ignored).toContain("greeting");
	});

	it("list a number the reader refuses (not finite) as ignored, not as read", () => {
		useProfile({ settings: SETTINGS });
		const { home, cwd } = tempHome("declared-settings-doctor-infinite-");
		write(productSettingsPath(home), '{"retries": 1e400}');
		expect(productSetting("retries", cwd, home)).toBeUndefined();
		const compat = collectCompat({ cwd, home, agentDir: join(home, brand.stateDir, "agent"), env: { HOME: home, PATH: "" } as NodeJS.ProcessEnv });
		const user = compat.files.find((file) => file.scope === "product-user");
		expect(user?.used.some((line) => line.startsWith("retries"))).toBe(false);
		expect(user?.ignored).toContain("retries (not a number)");
	});
});
