/**
 * A product's own extensions (working-docs/decisions/bi-fork.md): the main
 * session loads `profile/extensions/<name>/index.ts` through the manifest's
 * last entry, and each reaches the request only through the channels
 * `extensions/sdk/extension.ts` re-exports. One Code ships none, so the
 * loading cases run in the base suite, on the fixture profile's `probe`.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { productProjectSettingsPath, productSettingsPath } from "../../extensions/lib/profile/product-settings.ts";
import { productSetting as baseProductSetting } from "../../extensions/lib/profile/declared-settings.ts";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHILD_EXTENSIONS, LAST_CHILD_EXTENSION } from "../../extensions/lib/agents/child-extensions.ts";
import { envName, productBrand } from "../../extensions/lib/profile/brand.mjs";
import { isProductExtensionFolder, PRODUCT_EXTENSIONS_DIR, PRODUCT_EXTENSIONS_ENTRY } from "../../extensions/lib/profile/features.ts";
import { activeProfile, PRODUCT_DIR, resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import { PRODUCT_EXTENSION_NAME } from "../../extensions/lib/profile/feature.ts";
import type { Profile } from "../../extensions/lib/profile/profile-contract.ts";
import { useProfile } from "./helpers/profile.ts";
import { redactSecretValues } from "../../extensions/lib/profile/secrets.ts";
import * as sdk from "../../extensions/sdk/extension.ts";
import { DEFER_CHANNEL, REMINDER_CHANNEL, SYSTEM_PROMPT_SECTION_CHANNEL, type SystemPromptSection } from "../../extensions/sdk/extension.ts";
import { CONTEXT_ORDER } from "../../extensions/lib/request/reminders.ts";
import { sessionModelTier } from "../../extensions/lib/models/session-model-tier.ts";
import { modelCapability, resolveModelTier as sessionTier, tiersBelow } from "../../extensions/lib/models/model-tier.ts";
import { type FixtureModel, pinCatalog } from "./catalog-fixture.ts";
import { queueNotice } from "../../extensions/lib/notify/notices.ts";
import { notifyOrPrint } from "../../extensions/lib/notify/headless-output.ts";
import { LSP_FILES_CHANGED_CHANNEL, type LspFilesChangedEvent } from "../../extensions/tools/lsp/request-channel.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { deferralChanges } from "./helpers/tool-mentions.ts";

/** The models the probe's tier notice is judged on: the tier code reads only id, provider and price. */
const OPUS = { provider: "anthropic", id: "claude-opus-5-5", cost: { input: 4 } };
const HAIKU_5 = { provider: "anthropic", id: "claude-haiku-5-5", cost: { input: 1 } };
const UNKNOWN_MODEL = { provider: "fixture-gateway", id: "mystery-model", cost: { input: 1 } };
const LINEUP: FixtureModel[] = [
	{ id: "anthropic/claude-opus-5-5", released: "2026-09-22", price: [4, 20] },
	{ id: "anthropic/claude-sonnet-5-5", released: "2026-09-28", price: [2, 10] },
	{ id: "anthropic/claude-haiku-5-5", released: "2026-10-20", price: [1, 5] },
];

// The product's folder, which every profile of the product shares: not the chosen profile's.
const root = join(PRODUCT_DIR, PRODUCT_EXTENSIONS_DIR);
const folders = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
const probe = join(root, "probe", "index.ts");

describe("a product's own extensions", () => {
	// A stubbed tier or state folder never outlives its test, a failing one included.
	afterEach(() => vi.unstubAllEnvs());

	it("sit where the manifest's product entry looks", () => {
		expect(PRODUCT_EXTENSIONS_ENTRY).toBe("profile/extensions/*/index.ts");
		// pi's glob skips dot folders; any other folder without an index.ts
		// would hold an extension the main session silently never loads.
		for (const name of folders.filter(isProductExtensionFolder)) expect(existsSync(join(root, name, "index.ts")), name).toBe(true);
	});

	it("each export their factory through productExtension() with their own folder's name, child entries too", async () => {
		// pi loads every folder whatever the profile: an unwrapped one would run under a profile that leaves it out,
		// and with plain pi, registering the tools the profile turns off.
		const entries = [...[...activeProfile().productExtensions.keys()].map((name) => join(root, name, "index.ts")), ...activeProfile().childExtensionPaths];
		for (const entry of entries) {
			const name = relative(root, entry).split(/[\\/]/)[0];
			const module = (await import(pathToFileURL(entry).href)) as { default?: { [PRODUCT_EXTENSION_NAME]?: string } };
			expect(module.default?.[PRODUCT_EXTENSION_NAME], `${relative(root, entry)}: export default productExtension("${name}", …)`).toBe(name);
		}
	});

	it("announce a prompt section only to the main session: a child has no listener", () => {
		// A child sends its agent's own prompt, or as a fork the parent's (which
		// already carries the section), so the system-prompt extension never
		// loads there and an announcement in a child is ignored.
		expect([...CHILD_EXTENSIONS, LAST_CHILD_EXTENSION].some((entry) => entry.startsWith("request/system-prompt/"))).toBe(false);
	});

	it.skipIf(!existsSync(probe))("the fixture's probe reaches the request through the SDK's channels", async () => {
		const module = (await import(pathToFileURL(probe).href)) as { default: (pi: never) => void; PROBE_TOOL: string; PROBE_SECTION: string; PROBE_SECTION_TOOL: string; PROBE_SECTION_DIAGNOSTICS: string; PROBE_REMINDER: string; PROBE_SECRET: string; PROBE_CONTEXT: string; PROBE_CONTEXT_KEY: string };
		const fake = createFakePi();
		const seen = { deferred: [] as unknown[], sections: [] as SystemPromptSection[], reminders: [] as unknown[] };
		fake.events.on(DEFER_CHANNEL, (data) => seen.deferred.push(data));
		fake.events.on(SYSTEM_PROMPT_SECTION_CHANNEL, (data) => seen.sections.push(data as SystemPromptSection));
		fake.events.on(REMINDER_CHANNEL, (data) => seen.reminders.push(data));
		module.default(fake.pi as never);
		expect(fake.tools.has(module.PROBE_TOOL)).toBe(true);
		// The base's rows in the terminal, through the SDK.
		expect(fake.tools.get(module.PROBE_TOOL)?.renderShell).toBe("self");
		expect(seen.deferred).toEqual([{ name: module.PROBE_TOOL }]);
		// The section cuts the passage naming its tool when the session cannot have it, whatever the active list says.
		const rendered = (has: boolean, lsp = true) =>
			seen.sections.map((section) => [section.place, section.render({ tier: "cheap", taskTools: false, tools: [], live: { has: () => has }, features: { has: (id) => id !== "lsp" || lsp } })]);
		expect(rendered(true)).toEqual([["tail", `${module.PROBE_SECTION}${module.PROBE_SECTION_TOOL}${module.PROBE_SECTION_DIAGNOSTICS}`]]);
		expect(rendered(false)).toEqual([["tail", `${module.PROBE_SECTION}${module.PROBE_SECTION_DIAGNOSTICS}`]]);
		// The diagnostics passage follows the lsp feature, not its tool.
		expect(rendered(false, false)).toEqual([["tail", module.PROBE_SECTION]]);
		for (const lsp of [true, false]) {
			expect(deferralChanges((session) => seen.sections[0].render(session), { deferred: [module.PROBE_TOOL], features: { has: (id) => id !== "lsp" || lsp } })).toEqual([]);
		}
		expect(redactSecretValues(`out: ${module.PROBE_SECRET}`)).toBe("out: [secret:fixture]");
		// The reminder waits for the session: nothing is queued while extensions load.
		expect(seen.reminders).toEqual([]);
		// A model at the probe's capability floor: no notice joins the session_start handlers' work.
		for (const handler of fake.handlers.get("session_start") ?? []) await handler({}, createFakeCtx({ model: OPUS }));
		expect(seen.reminders).toEqual([
			expect.objectContaining({ text: module.PROBE_CONTEXT, key: `product:${module.PROBE_CONTEXT_KEY}`, placement: "first-prepend", order: CONTEXT_ORDER.productContext }),
			expect.objectContaining({ text: module.PROBE_REMINDER, placement: "last-append" }),
		]);
	});

	it("offer the session's tier, the notice helpers and the settings reader the base itself uses", () => {
		// The same functions, so a product's tier is the one the request was built for and its notices join the base's.
		expect([sdk.sessionModelTier, sdk.modelCapability, sdk.tiersBelow, sdk.queueNotice, sdk.notifyOrPrint, sdk.productSetting]).toEqual([sessionModelTier, modelCapability, tiersBelow, queueNotice, notifyOrPrint, baseProductSetting]);
		expect(sdk.tiersBelow("cheap", "workhorse")).toBe(1);
	});

	it.skipIf(!existsSync(probe))("the fixture's probe judges the model by its capability, in the TUI and in print mode", async () => {
		const module = (await import(pathToFileURL(probe).href)) as { default: (pi: never) => void; PROBE_TIER_NOTICE: string; PROBE_UNKNOWN_MODEL_NOTICE: string };
		pinCatalog(LINEUP);
		const state = mkdtempSync(join(tmpdir(), "probe-tier-"));
		const cwd = mkdtempSync(join(tmpdir(), "probe-tier-cwd-"));
		vi.stubEnv(envName("STATE_DIR"), state);
		const start = async (model: unknown, hasUI = true) => {
			const fake = createFakePi();
			module.default(fake.pi as never);
			const notices: Array<[string, string]> = [];
			await fake.fire("session_start", {}, createFakeCtx({ cwd, model, hasUI, ui: { notify: (text: string, level: string) => notices.push([text, level]) } }));
			// The lifecycle notices close their batch on the next macrotask.
			await new Promise((resolve) => setTimeout(resolve, 0));
			return notices.map(([text]) => text);
		};
		const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			expect(await start(OPUS)).toEqual([]);
			// Haiku 5 gets the frontier prompt register, and is still judged below frontier.
			expect(sessionTier(HAIKU_5 as never)).toBe("frontier");
			expect(await start(HAIKU_5)).toEqual([module.PROBE_TIER_NOTICE]);
			// The prompt-tier knob moves the register, never the capability.
			vi.stubEnv(envName("PROMPT_TIER"), "frontier");
			expect(await start(HAIKU_5)).toEqual([module.PROBE_TIER_NOTICE]);
			vi.stubEnv(envName("PROMPT_TIER"), "");
			// A model no catalog knows: its tier is a guess.
			expect(await start(UNKNOWN_MODEL)).toEqual([module.PROBE_UNKNOWN_MODEL_NOTICE]);
			expect(await start(HAIKU_5, false)).toEqual([]);
			expect(stderr).toHaveBeenCalledWith(module.PROBE_TIER_NOTICE);
		} finally {
			stderr.mockRestore();
			vi.unstubAllEnvs();
			rmSync(state, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it.skipIf(!existsSync(probe))("the fixture's probe stays quiet while its declared setting is off, the project's value winning", async () => {
		const module = (await import(pathToFileURL(probe).href)) as { default: (pi: never) => void; PROBE_TIER_NOTICE: string; PROBE_TIER_SETTING: string };
		pinCatalog(LINEUP);
		const state = mkdtempSync(join(tmpdir(), "probe-setting-"));
		const cwd = mkdtempSync(join(tmpdir(), "probe-setting-cwd-"));
		vi.stubEnv(envName("STATE_DIR"), state);
		const write = (path: string, value: boolean) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify({ [module.PROBE_TIER_SETTING]: value }));
		};
		const start = async () => {
			const fake = createFakePi();
			module.default(fake.pi as never);
			const notices: string[] = [];
			await fake.fire("session_start", {}, createFakeCtx({ cwd, model: HAIKU_5, hasUI: true, ui: { notify: (text: string) => notices.push(text) } }));
			await new Promise((resolve) => setTimeout(resolve, 0));
			return notices;
		};
		try {
			write(productSettingsPath(homedir()), false);
			expect(await start()).toEqual([]);
			write(productProjectSettingsPath(cwd, homedir()), true);
			expect(await start()).toEqual([module.PROBE_TIER_NOTICE]);
		} finally {
			vi.unstubAllEnvs();
			rmSync(state, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it.skipIf(!existsSync(probe))("the fixture's probe writes into the product's state folder and opens it, or says why not", async () => {
		const module = (await import(pathToFileURL(probe).href)) as { default: (pi: never) => void; PROBE_COMMAND: string };
		const fake = createFakePi();
		module.default(fake.pi as never);
		const state = mkdtempSync(join(tmpdir(), "probe-state-"));
		// The state-dir variable moves the folder; an SSH session means no browser is started.
		vi.stubEnv(envName("STATE_DIR"), state);
		vi.stubEnv("SSH_CONNECTION", "10.0.0.1 1 10.0.0.2 22");
		try {
			const notices: Array<[string, string]> = [];
			await fake.commands.get(module.PROBE_COMMAND)!.handler("", createFakeCtx({ ui: { notify: (text: string, level: string) => notices.push([text, level]) } }));
			const page = join(state, "fixture-probe", "page.html");
			expect(readFileSync(page, "utf8")).toBe("<p>[fixture:probe-page]</p>\n");
			expect(notices).toEqual([[`[fixture:no-browser:ssh] ${page}`, "warning"]]);
		} finally {
			vi.unstubAllEnvs();
			rmSync(state, { recursive: true, force: true });
		}
	});

	it.skipIf(!existsSync(probe))("the fixture's probe reports the file its tool writes to the language server", async () => {
		const module = (await import(pathToFileURL(probe).href)) as { default: (pi: never) => void; PROBE_TOOL: string; PROBE_FILE: string };
		const fake = createFakePi();
		const reports: LspFilesChangedEvent[] = [];
		fake.events.on(LSP_FILES_CHANGED_CHANNEL, (data) => {
			const report = data as LspFilesChangedEvent;
			reports.push(report);
			report.reply(Promise.resolve());
		});
		module.default(fake.pi as never);
		const cwd = mkdtempSync(join(tmpdir(), "probe-"));
		try {
			await fake.tools.get(module.PROBE_TOOL)!.execute("t", {}, undefined, undefined, createFakeCtx({ cwd }));
			const path = join(cwd, module.PROBE_FILE);
			expect(readFileSync(path, "utf8")).toBe("[fixture:probe-file]\n");
			expect(reports.map(({ server, changes }) => ({ server, changes }))).toEqual([{ server: "fixture", changes: [{ path, type: "created" }] }]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("the product extensions a profile runs", () => {
	const made: string[] = [];
	afterEach(() => {
		setActiveProfileForTest(undefined);
		for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/** A product folder with extension folders `names`, each holding an index.ts (the wrapper never imports them). */
	const productWith = (...names: string[]) => {
		const dir = mkdtempSync(join(tmpdir(), "product-extensions-"));
		made.push(dir);
		for (const name of names) {
			mkdirSync(join(dir, PRODUCT_EXTENSIONS_DIR, name), { recursive: true });
			writeFileSync(join(dir, PRODUCT_EXTENSIONS_DIR, name, "index.ts"), "");
		}
		// A dot folder and a folder with no index.ts are no extension: pi's glob loads neither.
		mkdirSync(join(dir, PRODUCT_EXTENSIONS_DIR, ".cache"), { recursive: true });
		writeFileSync(join(dir, PRODUCT_EXTENSIONS_DIR, ".cache", "index.ts"), "");
		mkdirSync(join(dir, PRODUCT_EXTENSIONS_DIR, "shared"), { recursive: true });
		return dir;
	};
	const tool = (name: string) => ({ name, label: name, description: name, parameters: {}, execute: async () => ({ content: [], details: undefined }) }) as never;

	it("are every folder when the profile lists none, and only the listed ones when it does", () => {
		const dir = productWith("lookup", "deploy");
		// A linked folder is one pi's glob loads, so it is one the wrapper knows.
		const linked = mkdtempSync(join(tmpdir(), "product-extension-linked-"));
		made.push(linked);
		writeFileSync(join(linked, "index.ts"), "");
		symlinkSync(linked, join(dir, PRODUCT_EXTENSIONS_DIR, "linked"), "junction");
		useProfile({}, dir);
		expect([...activeProfile().productExtensions]).toEqual([["deploy", true], ["linked", true], ["lookup", true]]);
		useProfile({ extensions: ["lookup"] }, dir);
		expect([...activeProfile().productExtensions]).toEqual([["deploy", false], ["linked", false], ["lookup", true]]);
		useProfile({ extensions: [] }, dir);
		expect([...activeProfile().productExtensions.values()]).toEqual([false, false, false]);
	});

	it("refuse a listed name with no folder, and a child extension in a folder the list leaves out", () => {
		const dir = productWith("lookup", "deploy");
		writeFileSync(join(dir, PRODUCT_EXTENSIONS_DIR, "deploy", "child.ts"), "");
		expect(() => useProfile({ extensions: ["lookup", "shared", ".cache", "lokup"] }, dir)).toThrow(/"shared", which has no folder extensions\/shared\/ with an index.ts.*"\.cache".*"lokup"/);
		expect(() => useProfile({ extensions: ["lookup"], childExtensions: ["extensions/deploy/child.ts"] }, dir)).toThrow(/child extension "extensions\/deploy\/child.ts" is in the folder "deploy", which the profile's extensions list leaves out/);
		useProfile({ extensions: ["deploy"], childExtensions: ["extensions/deploy/child.ts"] }, dir);
		// A child entry outside an extension folder has no name for its wrapper: refused at load, not when the first subagent starts.
		writeFileSync(join(dir, PRODUCT_EXTENSIONS_DIR, "loose.ts"), "");
		writeFileSync(join(dir, PRODUCT_EXTENSIONS_DIR, "shared", "child.ts"), "");
		for (const entry of ["extensions/loose.ts", "extensions/shared/child.ts"]) expect(() => useProfile({ childExtensions: [entry] }, dir), entry).toThrow(/must sit in a product extension folder, one with an index.ts/);
		expect(() => useProfile({ extensions: "lookup" as never }, dir)).toThrow(/its "extensions" must be an array of folder names/);
	});

	it("run through productExtension(), which skips a folder the profile leaves out and registers no tool it turns off", () => {
		const dir = productWith("lookup", "deploy");
		useProfile({ extensions: ["lookup"], tools: { lookup_off: { enabled: false } } }, dir);
		const ran: string[] = [];
		const register = (name: string) =>
			sdk.productExtension(name, (pi) => {
				ran.push(name);
				pi.registerTool(tool(`${name}_on`));
				pi.registerTool(tool(`${name}_off`));
			});
		const fake = createFakePi();
		expect(register("deploy")(fake.pi as never)).toBeUndefined();
		register("lookup")(fake.pi as never);
		expect(ran).toEqual(["lookup"]);
		// Absent from the model's tool list, not only refused at the gate: as a base feature's tool is.
		expect([...fake.tools.keys()]).toEqual(["lookup_on"]);
	});

	it("stop the process when productExtension() names no folder, as an invalid profile does", () => {
		const dir = productWith("lookup");
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit");
		}) as never);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			useProfile({}, dir);
			expect(() => sdk.productExtension("lokup", () => undefined)(createFakePi().pi as never)).toThrow("exit");
			expect(String(stderr.mock.calls[0]?.[0])).toContain(`productExtension("lokup"): the product has no folder extensions/lokup/`);
		} finally {
			exit.mockRestore();
			stderr.mockRestore();
		}
	});

	it("can tell the product profile in force: the launch's choice, else the brand's default", () => {
		// No launch choice in a test run: the brand's default profile, or none where `profile/` itself is the default.
		expect(sdk.productProfile()).toBe(productBrand.defaultProfile);
		setActiveProfileForTest({ ...activeProfile(), productProfile: "QA" });
		expect(sdk.productProfile()).toBe("QA");
	});

	// The fixture product: its default profile runs both extensions, Alt only `edition`, which words its section by the profile.
	const edition = join(root, "edition", "index.ts");
	const alt = join(PRODUCT_DIR, "profiles", "Alt", "index.ts");
	it.skipIf(!existsSync(edition) || !existsSync(alt) || !existsSync(probe))("the fixture's Alt leaves out the probe, and its edition extension words its section by the profile", async () => {
		const { editionSection, default: editionFactory } = (await import(pathToFileURL(edition).href)) as { editionSection: (id: string | undefined) => string; default: (pi: never) => void };
		const { default: probeFactory, PROBE_TOOL } = (await import(pathToFileURL(probe).href)) as { default: (pi: never) => void; PROBE_TOOL: string };
		const { profile: altProfile } = (await import(pathToFileURL(alt).href)) as { profile: Profile };
		const load = () => {
			const fake = createFakePi();
			const sections: SystemPromptSection[] = [];
			fake.events.on(SYSTEM_PROMPT_SECTION_CHANNEL, (data) => sections.push(data as SystemPromptSection));
			probeFactory(fake.pi as never);
			editionFactory(fake.pi as never);
			const session = { tier: "cheap", taskTools: false, tools: [], live: { has: () => true }, features: { has: () => true } } as const;
			return { probe: fake.tools.has(PROBE_TOOL), sections: sections.filter((section) => section.id === "fixture-edition").map((section) => section.render(session)) };
		};
		expect(load()).toEqual({ probe: true, sections: [editionSection(productBrand.defaultProfile)] });
		setActiveProfileForTest(resolveProfile(altProfile, {}, join(PRODUCT_DIR, "profiles", "Alt"), PRODUCT_DIR, undefined, undefined, "Alt"));
		expect(load()).toEqual({ probe: false, sections: [editionSection("Alt")] });
	});
});
