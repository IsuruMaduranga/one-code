/**
 * A profile's sandbox block (`Profile.sandbox`, lib/profile/product-sandbox.ts):
 * the starting settings the files merge over, and the lock that keeps every
 * widening key out of every settings file (lib/shell-run/sandbox-settings.ts
 * loadSandboxSettings). Also what the user is shown: `/sandbox`'s lines and
 * the panel's outcome.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envName } from "../../extensions/lib/profile/brand.mjs";
import { tildify } from "../../extensions/lib/profile/paths.ts";
import type { UserProfile } from "../../extensions/lib/profile/user-profile.ts";
import { productSettingsPath } from "../../extensions/lib/profile/product-settings.ts";
import { activeProfile, resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import type { ProductSandbox } from "../../extensions/lib/profile/product-sandbox.ts";
import { isRepoFile, settingsSources } from "../../extensions/lib/profile/settings-files.ts";
import { reloadSandboxSettings, sandboxSettings, setSandboxForTest, useSandboxSettingsFor } from "../../extensions/lib/shell-run/sandbox.ts";
import { loadSandboxSettings, mergeSandboxBlock, SANDBOX_OFF, type SandboxSettings } from "../../extensions/lib/shell-run/sandbox-settings.ts";
import { sandboxPickOutcome } from "../../extensions/safety/sandbox/panel.ts";
import { sandboxStatusLines } from "../../extensions/safety/sandbox/section.ts";
import { useProfile } from "./helpers/profile.ts";

let root: string;
let cwd: string;
let home: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sandbox-product-"));
	cwd = join(root, "project");
	home = join(root, "home");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(home, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	// The product's user file is in the test run's state dir (test/setup.ts), not under `home`.
	rmSync(productSettingsPath(home), { force: true });
	setSandboxForTest(undefined);
	setActiveProfileForTest(undefined);
});

const put = (path: string, settings: object) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(settings));
};
/** The user's own settings file: the product's user file, which the repository does not control. */
const userFile = (sandbox: object) => put(productSettingsPath(home), { sandbox });
const userLabel = () => tildify(productSettingsPath(home), home);
const load = (product: ProductSandbox | undefined) => loadSandboxSettings(cwd, home, product);

const LOCKED_ON: ProductSandbox = { enabled: true, locked: true };

describe("a profile's sandbox block", () => {
	it("leaves the settings as they were with no block, with no product field", () => {
		const block = { enabled: true, excludedCommands: ["docker *"], filesystem: { allowWrite: ["~/out"] }, network: { allowedDomains: ["a.example"] } };
		userFile(block);
		const settings = load(undefined);
		expect(settings).toEqual({ ...mergeSandboxBlock(SANDBOX_OFF, block, false), denyRulePaths: { write: [], read: [] } });
		expect("product" in settings).toBe(false);
		// The profile in force (One Code's, or the fixture's) supplies none, so the default reads the same.
		expect(activeProfile().sandbox).toBeUndefined();
		expect(loadSandboxSettings(cwd, home)).toEqual(settings);
	});

	it("turns the sandbox on with no settings file", () => {
		expect(load({ enabled: true })).toEqual({ ...SANDBOX_OFF, enabled: true, product: { locked: false, ignored: [] } });
	});

	it("may loosen relative to off: it is the product's own default", () => {
		const settings = load({ enabled: true, autoAllowBashIfSandboxed: true, failIfUnavailable: true, excludedCommands: ["make *"], filesystem: { allowWrite: ["/build"] }, network: { allowedDomains: ["registry.example"], allowLocalBinding: true } });
		expect(settings).toMatchObject({ enabled: true, autoAllowBashIfSandboxed: true, failIfUnavailable: true, excludedCommands: ["make *"], filesystem: { allowWrite: ["/build"] }, network: { allowedDomains: ["registry.example"], allowLocalBinding: true } });
	});

	it("lets the user's enabled: false win when not locked, and ignores it when locked", () => {
		userFile({ enabled: false });
		expect(load({ enabled: true }).enabled).toBe(false);
		const locked = load(LOCKED_ON);
		expect(locked.enabled).toBe(true);
		expect(locked.product).toEqual({ locked: true, ignored: [`sandbox.enabled in ${userLabel()}`] });
	});

	it("lets the user widen on top of the default when not locked", () => {
		userFile({ filesystem: { allowWrite: ["~/out"] }, network: { allowedDomains: ["a.example"] } });
		const settings = load({ enabled: true, network: { allowedDomains: ["registry.example"] } });
		expect(settings.filesystem.allowWrite).toEqual(["~/out"]);
		expect(settings.network.allowedDomains).toEqual(["registry.example", "a.example"]);
		expect(settings.product).toEqual({ locked: false, ignored: [] });
	});

	it("lets a repository's file tighten, locked or not", () => {
		const tighten = { enabled: true, allowUnsandboxedCommands: false, filesystem: { denyWrite: ["*.pem"], denyRead: ["~/.aws"] }, network: { deniedDomains: ["bad.example"] } };
		for (const locked of [false, true]) {
			const start = mergeSandboxBlock(SANDBOX_OFF, { autoAllowBashIfSandboxed: true }, false);
			const next = mergeSandboxBlock(start, { ...tighten, autoAllowBashIfSandboxed: false }, true, locked);
			expect(next).toMatchObject({ enabled: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, filesystem: { denyWrite: ["*.pem"], denyRead: ["~/.aws"] }, network: { deniedDomains: ["bad.example"] } });
		}
		// Through the loader too, where the profile reads a repository's file.
		const repo = settingsSources(cwd, home).find(isRepoFile);
		if (repo) {
			put(repo.path, { sandbox: { ...tighten, enabled: false, filesystem: { ...tighten.filesystem, allowWrite: ["/"] } } });
			for (const product of [{ enabled: true }, LOCKED_ON] satisfies ProductSandbox[]) {
				const settings = load(product);
				expect(settings).toMatchObject({ enabled: true, allowUnsandboxedCommands: false, filesystem: { allowWrite: [], denyWrite: ["*.pem"], denyRead: ["~/.aws"] }, network: { deniedDomains: ["bad.example"] } });
				// A repository's file never widened, so the lock kept nothing out of it to report.
				expect(settings.product?.ignored).toEqual([]);
			}
		}
	});

	describe("ignores every widening key from the user's file when locked", () => {
		const cases: Array<[string, object, (s: SandboxSettings) => unknown, unknown]> = [
			["enabled", { enabled: false }, (s) => s.enabled, true],
			["autoAllowBashIfSandboxed", { autoAllowBashIfSandboxed: true }, (s) => s.autoAllowBashIfSandboxed, false],
			["excludedCommands", { excludedCommands: ["docker *"] }, (s) => s.excludedCommands, []],
			["filesystem.allowWrite", { filesystem: { allowWrite: ["~/out"] } }, (s) => s.filesystem.allowWrite, []],
			["filesystem.allowRead", { filesystem: { allowRead: ["~/notes"] } }, (s) => s.filesystem.allowRead, []],
			["network.allowedDomains", { network: { allowedDomains: ["a.example"] } }, (s) => s.network.allowedDomains, []],
			["network.allowLocalBinding", { network: { allowLocalBinding: true } }, (s) => s.network.allowLocalBinding, false],
			["network.allowUnixSockets", { network: { allowUnixSockets: ["/var/run/docker.sock"] } }, (s) => s.network.allowUnixSockets, []],
		];
		for (const [key, block, read, kept] of cases) {
			it(key, () => {
				userFile(block);
				const settings = load(LOCKED_ON);
				expect(read(settings)).toEqual(kept);
				expect(settings.product?.ignored).toEqual([`sandbox.${key} in ${userLabel()}`]);
			});
		}
	});

	it("reports only what the lock changed: a value the default already has is not listed", () => {
		userFile({ enabled: true, autoAllowBashIfSandboxed: false });
		expect(load(LOCKED_ON).product?.ignored).toEqual([]);
	});

	it("still applies every tightening key from the user's file when locked", () => {
		userFile({ allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, failIfUnavailable: true, filesystem: { denyWrite: ["*.pem"], denyRead: ["~/.aws"] }, network: { deniedDomains: ["bad.example"] } });
		const settings = load({ enabled: true, autoAllowBashIfSandboxed: true, locked: true });
		expect(settings).toMatchObject({ allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, failIfUnavailable: true, filesystem: { denyWrite: ["*.pem"], denyRead: ["~/.aws"] }, network: { deniedDomains: ["bad.example"] } });
		expect(settings.product?.ignored).toEqual([]);
	});

	it("lets the user turn on a sandbox the locked profile leaves off", () => {
		userFile({ enabled: true });
		expect(load({ locked: true }).enabled).toBe(true);
	});

	it("lists a key the lock newly ignores as soon as the settings are read again", () => {
		useProfile({ sandbox: LOCKED_ON });
		setSandboxForTest({ ...SANDBOX_OFF, enabled: true, product: { locked: true, ignored: [] } });
		// A /sandbox pick writes a widening key into the user's file.
		userFile({ filesystem: { allowWrite: ["~/out"] } });
		reloadSandboxSettings();
		expect(sandboxSettings().product?.ignored).toEqual([expect.stringMatching(/^sandbox\.filesystem\.allowWrite in /)]);
		// What a reload may change still holds the start's other settings.
		expect(sandboxSettings().filesystem.allowWrite).toEqual([]);
	});

	it("applies the same block and lock when the settings are read again or for another directory", () => {
		useProfile({ sandbox: { enabled: true, allowUnsandboxedCommands: false, locked: true } });
		setSandboxForTest({ ...SANDBOX_OFF, enabled: true, allowUnsandboxedCommands: true, autoAllowBashIfSandboxed: true });
		const loaded = reloadSandboxSettings();
		expect(loaded).toMatchObject({ enabled: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, product: { locked: true } });
		expect(sandboxSettings()).toMatchObject({ allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false });
		useSandboxSettingsFor(cwd);
		expect(sandboxSettings()).toMatchObject({ enabled: true, allowUnsandboxedCommands: false, product: { locked: true } });
	});
});

describe("a profile's sandbox block at load", () => {
	const text = activeProfile().textFor;
	const resolve = (fields: object) => resolveProfile({ features: {}, tools: {}, childExtensions: [], text: ({ live }) => text(live), ...fields }, {}, "/p", "/p");

	it("is carried to the resolved profile, and absent when the profile has none", () => {
		expect(resolve({ sandbox: LOCKED_ON }).sandbox).toEqual(LOCKED_ON);
		expect("sandbox" in resolve({})).toBe(false);
	});

	it("refuses a block the merge would skip in silence", () => {
		expect(() => resolve({ sandbox: { enabled: "yes", lockd: true, excludedCommands: "make", filesystem: { allowWrite: [""], writable: [] }, network: { allowLocalBinding: 1 } } })).toThrow(
			/unknown field "lockd".*"sandbox.enabled" must be true or false.*"sandbox.excludedCommands" must be a list.*"sandbox.filesystem.allowWrite" must be a list.*"sandbox.filesystem" has an unknown field "writable".*"sandbox.network.allowLocalBinding" must be true or false/,
		);
	});

	it("refuses a block while the profile turns the sandbox feature off", () => {
		expect(() => resolve({ features: { sandbox: false }, sandbox: { enabled: true } })).toThrow(/declares a sandbox block but turns off "sandbox"/);
	});

	describe("the user's off-switches for the sandbox feature", () => {
		const env = { [envName("FEATURES_OFF")]: "sandbox" };
		const lean: UserProfile = { name: "lean", dir: "/u/lean", toolsOff: [], toolsDeferred: [], toolsEager: [], featuresOff: ["sandbox"], toolWording: new Map(), hash: "h" };
		const resolveWith = (sandbox: ProductSandbox, over: { env?: NodeJS.ProcessEnv; user?: UserProfile }) =>
			resolveProfile({ features: {}, tools: {}, childExtensions: [], text: ({ live }) => text(live), sandbox }, over.env ?? {}, "/p", "/p", over.user);

		it("are ignored under a locked block, and named where the lock's ignored settings are", () => {
			const byEnv = resolveWith(LOCKED_ON, { env });
			expect(byEnv.features.has("sandbox")).toBe(true);
			expect(byEnv.sandboxOffIgnored).toEqual([`sandbox in ${envName("FEATURES_OFF")}`]);
			const byUser = resolveWith(LOCKED_ON, { user: lean });
			expect(byUser.features.has("sandbox")).toBe(true);
			expect(byUser.sandboxOffIgnored).toEqual([`sandbox in the featuresOff of the profile "lean"`]);
			expect(loadSandboxSettings(cwd, home, LOCKED_ON, byUser.sandboxOffIgnored).product?.ignored).toEqual([`sandbox in the featuresOff of the profile "lean"`]);
		});

		it("still turn an unlocked block's feature off", () => {
			for (const over of [{ env }, { user: lean }]) {
				const resolved = resolveWith({ enabled: true }, over);
				expect(resolved.features.has("sandbox")).toBe(false);
				expect("sandboxOffIgnored" in resolved).toBe(false);
			}
		});
	});
});

describe("what the user is shown", () => {
	const facts = { platform: "darwin" as const, active: undefined, unavailable: "it has not started", cwd: "/work" };

	it("adds no line for a profile with no block", () => {
		expect(sandboxStatusLines({ ...facts, settings: SANDBOX_OFF })).toEqual(["Command sandbox: off.", 'Turn it on with "sandbox": { "enabled": true } in your user settings; it applies from the next start.']);
	});

	it("says when the product sets the settings, when it locks them, and what the lock ignored", () => {
		const unlocked = sandboxStatusLines({ ...facts, settings: { ...SANDBOX_OFF, enabled: true, product: { locked: false, ignored: [] } } });
		expect(unlocked[1]).toBe("The product sets the sandbox's starting settings; your settings apply over them.");
		const locked = sandboxStatusLines({ ...facts, settings: { ...SANDBOX_OFF, enabled: true, product: { locked: true, ignored: ["sandbox.enabled in ~/.onecode/settings.json"] } } });
		expect(locked[0]).toMatch(/^Command sandbox: on in settings/);
		expect(locked[1]).toBe("The product sets the sandbox's settings and locks them: your settings and a repository's can tighten the sandbox but cannot turn it off or widen it. Ignored because of the lock: sandbox.enabled in ~/.onecode/settings.json.");
	});

	it("names the lock when a pick in /sandbox cannot take effect", () => {
		const locked: SandboxSettings = { ...SANDBOX_OFF, enabled: true, allowUnsandboxedCommands: false, product: { locked: true, ignored: [] } };
		expect(sandboxPickOutcome({ tab: "mode", value: "off" }, true, locked)).toBe("Saved, but the product locks the sandbox's settings, so it stays on.");
		expect(sandboxPickOutcome({ tab: "overrides", value: "fallback" }, true, locked)).toBe("Saved, but the product locks the sandbox's settings, so strict sandbox mode stays.");
		expect(sandboxPickOutcome({ tab: "mode", value: "auto-allow" }, true, locked)).toBe("Saved, but the product locks the sandbox's settings, so sandboxed commands keep their prompts.");
	});
});
