/**
 * Profiles chosen at launch (working-docs/decisions/bi-fork.md): which profile
 * a command line names, the brand a product profile runs under, a user's own
 * profile read from its folder, and what the resolved profile takes from it.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import data from "../../profile/brand.json" with { type: "json" };
import { productBrand, resolveBrand, selectedProfileName, withoutProfileFlags } from "../../extensions/lib/profile/brand.mjs";
import { profiledPi } from "../../extensions/lib/profile/feature.ts";
import { activeProfile, profileKey, profileSummary, resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import type { Profile } from "../../extensions/lib/profile/profile-contract.ts";
import { loadUserProfile, type UserProfile, wordedByUser } from "../../extensions/lib/profile/user-profile.ts";
import { requestIdentity } from "../../extensions/lib/request/anthropic-auth.ts";
import systemPromptExtension from "../../extensions/request/system-prompt/index.ts";
import { profile as shippedProfile } from "../../profile/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { tempHome } from "./helpers/temp-home.ts";

const product = { envPrefix: "X", profiles: ["BI", "mi"] };
const argv = (...args: string[]) => ["node", "bin", ...args];

afterEach(() => setActiveProfileForTest(undefined));

describe("the profile a launch names", () => {
	it("reads --profile, its = form, and a product profile's id as a flag in any case", () => {
		expect(selectedProfileName(product, argv("--profile", "lean"), {})).toBe("lean");
		expect(selectedProfileName(product, argv("-p", "hi", "--profile=lean"), {})).toBe("lean");
		expect(selectedProfileName(product, argv("--bi"), {})).toBe("bi");
		expect(selectedProfileName(product, argv("--MI", "-p", "hi"), {})).toBe("MI");
		expect(selectedProfileName(product, argv("-p", "hi"), {})).toBeUndefined();
	});

	it("prefers the command line to the environment, and reads nothing after a bare --", () => {
		expect(selectedProfileName(product, argv("--bi"), { X_PROFILE: "lean" })).toBe("bi");
		expect(selectedProfileName(product, argv("-p", "hi"), { X_PROFILE: "lean" })).toBe("lean");
		expect(selectedProfileName(product, argv("--", "--bi"), {})).toBeUndefined();
	});

	it("names the empty profile when --profile has no name, so the launch stops instead of running the default", () => {
		expect(selectedProfileName(product, argv("--profile"), {})).toBe("");
		expect(selectedProfileName(product, argv("--profile", "-p", "hi"), {})).toBe("");
		expect(selectedProfileName(product, argv("--profile="), {})).toBe("");
		// The flag after it is still pi's to read.
		expect(withoutProfileFlags(["--profile", "-p", "hi"], product)).toEqual(["-p", "hi"]);
		const resolved = resolveBrand(data, { name: "", profileRoot: "/p", sharedStateDir: "/s", read: () => ({}) });
		expect(resolved.selection).toEqual({ userProfile: "" });
		expect(loadUserProfile("", "/s/profiles").problems).toEqual(["--profile needs a name: the profile's folder name, or one of the product's profiles"]);
	});

	it("never takes a flag that only starts like an id, or a prompt that mentions one", () => {
		expect(selectedProfileName(product, argv("--bisect", "-p", "use --bi here"), {})).toBeUndefined();
	});

	it("is taken out of the arguments the app hands to pi, so a prompt after --BI is not read as its value", () => {
		expect(withoutProfileFlags(["--BI", "fix it", "--profile", "lean", "--profile=x", "-p", "--", "--bi"], product)).toEqual(["fix it", "-p", "--", "--bi"]);
	});
});

describe("a product profile's brand", () => {
	const brand = { ...data, profiles: ["BI"] };
	const files: Record<string, unknown> = {
		[join("/pkg/profile", "profiles", "BI", "brand.json")]: { name: "BI Copilot", stateDir: ".bi" },
		[join("/state", "profiles", "lean", "profile.json")]: { base: "bi" },
		[join("/state", "profiles", "plain", "profile.json")]: {},
	};
	const read = (path: string) => {
		if (!(path in files)) throw new Error("ENOENT");
		return files[path];
	};
	const resolve = (name: string | undefined) => resolveBrand(brand, { name, profileRoot: "/pkg/profile", sharedStateDir: "/state", read });

	it("is the product's own with no choice", () => {
		const resolved = resolve(undefined);
		expect(resolved.brand).toEqual(resolved.product);
		expect(resolved.selection).toEqual({});
		expect(resolved.profileDir).toBe("profile");
	});

	it("takes the profile's names over the product's, and keeps the product's for what the profiles share", () => {
		const resolved = resolve("bi");
		expect(resolved.brand.name).toBe("BI Copilot");
		expect(resolved.brand.stateDir).toBe(".bi");
		expect(resolved.brand.envPrefix).toBe(data.envPrefix);
		expect(resolved.product.stateDir).toBe(data.stateDir);
		expect(resolved.selection).toEqual({ productProfile: "BI" });
		expect(resolved.profileDir).toBe("profile/profiles/BI");
	});

	it("refuses a name only the product may set", () => {
		files[join("/pkg/profile", "profiles", "BI", "brand.json")] = { name: "BI", envPrefix: "BI" };
		expect(() => resolve("BI")).toThrow(/may set only .*found envPrefix/);
		files[join("/pkg/profile", "profiles", "BI", "brand.json")] = { name: "BI Copilot", stateDir: ".bi" };
	});

	it("treats any other name as a user's profile, on the product profile it names", () => {
		expect(resolve("lean").selection).toEqual({ productProfile: "BI", userProfile: "lean" });
		expect(resolve("lean").brand.stateDir).toBe(".bi");
		expect(resolve("plain").selection).toEqual({ userProfile: "plain" });
		expect(resolve("missing").selection).toEqual({ userProfile: "missing" });
		expect(resolve("missing").profileDir).toBe("profile");
	});

	it("refuses a profiles list with a repeated id or the id \"profile\"", () => {
		expect(() => resolveBrand({ ...data, profiles: ["bi", "BI"] }, { name: undefined, profileRoot: "/p", sharedStateDir: "/s", read })).toThrow(/twice/);
		expect(() => resolveBrand({ ...data, profiles: ["profile"] }, { name: undefined, profileRoot: "/p", sharedStateDir: "/s", read })).toThrow(/--profile/);
		expect(() => resolveBrand({ ...data, profiles: ["BI", "Resume"] }, { name: undefined, profileRoot: "/p", sharedStateDir: "/s", read })).toThrow(/must not use "Resume": `--Resume` is already a launch flag/);
	});

	// The product in this checkout: One Code ships one profile, the fixture product two.
	it.skipIf((productBrand.profiles ?? []).length === 0)("is in force in a process launched with the profile's flag", () => {
		const id = productBrand.profiles![0];
		const module = fileURLToPath(new URL("../../extensions/lib/profile/brand.mjs", import.meta.url));
		const launch = fileURLToPath(new URL("../../extensions/lib/app/app-launch.mjs", import.meta.url)).replaceAll("\\", "/");
		const script = `const m = await import(${JSON.stringify(`file://${module.replaceAll("\\", "/")}`)}); const l = await import(${JSON.stringify(`file://${launch}`)}); const env = {}; const agent = l.applyLauncherEnv(env, { home: "/h", appVersion: "1", installMethod: "npm" }); console.log(JSON.stringify([m.brand.stateDir, m.productBrand.stateDir, m.profileDirName, m.profileSelection, agent, env[l.SESSION_DIR_VAR]]));`;
		const env: NodeJS.ProcessEnv = { ...process.env, [`${productBrand.envPrefix}_PROFILE`]: id.toLowerCase() };
		// The test run's own state folder override would name both folders alike.
		delete env[`${productBrand.envPrefix}_STATE_DIR`];
		delete env[`${productBrand.envPrefix}_AGENT_DIR`];
		const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
		const [stateDir, shared, dir, selection, agentDir, sessionDir] = JSON.parse(run.stdout) as [string, string, string, unknown, string, string];
		// One sign-in for the product, and the profile's own transcripts.
		expect(agentDir).toBe(join("/h", shared, "agent"));
		expect(sessionDir).toBe(join("/h", stateDir, "sessions"));
		expect(shared).toBe(productBrand.stateDir);
		expect(stateDir).not.toBe(shared);
		expect(dir).toBe(`profile/profiles/${id}`);
		expect(selection).toEqual({ productProfile: id });
	});
});

describe("a user's own profile", () => {
	const folder = (files: Record<string, string>) => {
		const { home } = tempHome("user-profile-");
		const dir = join(home, "profiles", "lean");
		for (const [name, text] of Object.entries(files)) {
			mkdirSync(join(dir, name, ".."), { recursive: true });
			writeFileSync(join(dir, name), text);
		}
		mkdirSync(dir, { recursive: true });
		return dir;
	};

	it("reads the switches and the text files", () => {
		const dir = folder({
			"profile.json": JSON.stringify({ description: "small", tools: { off: ["web_fetch"], deferred: ["notebook_edit"], eager: ["lsp_diagnostics"] }, features: { off: ["artifacts"] } }),
			"system-prompt.md": "You are small.\n",
			"append-system-prompt.md": "Be brief.\n",
			"tools/bash.md": "Runs a command.\n",
			"tools/bash.append.md": "Prefer rg.\n",
			"tools/read.append.md": "Read whole files.\n",
		});
		const { profile, problems } = loadUserProfile("lean", dir);
		expect(problems).toEqual([]);
		expect(profile).toMatchObject({ name: "lean", dir, description: "small", toolsOff: ["web_fetch"], toolsDeferred: ["notebook_edit"], toolsEager: ["lsp_diagnostics"], featuresOff: ["artifacts"], systemPrompt: "You are small.", appendSystemPrompt: "Be brief." });
		expect(wordedByUser(profile, "bash", "base")).toBe("Runs a command.\n\nPrefer rg.");
		expect(wordedByUser(profile, "read", "base")).toBe("base\n\nRead whole files.");
		expect(wordedByUser(profile, "write", "base")).toBe("base");
	});

	it("changes its hash when any of it changes", () => {
		const first = loadUserProfile("lean", folder({ "tools/bash.md": "one" })).profile!;
		const second = loadUserProfile("lean", folder({ "tools/bash.md": "two" })).profile!;
		expect(first.hash).not.toBe(second.hash);
		expect(loadUserProfile("lean", folder({ "tools/bash.md": "one" })).profile!.hash).toBe(first.hash);
	});

	it("names every problem with its file, and returns no profile", () => {
		const dir = folder({
			"profile.json": JSON.stringify({ tools: { off: "bash", on: ["x"] }, features: { on: ["hooks"] }, base: "bi", extra: 1 }),
			"system-prompt.md": "  \n",
			"tools/bash.txt": "x",
		});
		const { profile, problems } = loadUserProfile("lean", dir);
		expect(profile).toBeUndefined();
		const all = problems.join("\n");
		for (const part of [`"tools.off" must be a list`, `unknown field "tools.on"`, `unknown field "features.on"`, `"base" must name one of the product's profiles`, `unknown field "extra"`, "system-prompt.md is empty", "bash.txt"]) expect(all).toContain(part);
	});

	it("says how to create a profile that does not exist, and refuses a name that is no folder name", () => {
		const { home } = tempHome("user-profile-");
		expect(loadUserProfile("nope", join(home, "profiles", "nope"), ["BI"]).problems[0]).toMatch(/no profile is named "nope": create the folder .*the product's own profiles: BI\)$/);
		expect(loadUserProfile("../x", join(home, "x")).problems[0]).toContain("is not a profile name");
	});

	it("accepts the product profile it sits on in any case", () => {
		expect(loadUserProfile("lean", folder({ "profile.json": JSON.stringify({ base: "bi" }) }), ["BI"]).profile?.base).toBe("BI");
	});
});

describe("the profile resolved with a user's own over it", () => {
	const empty: Profile = { features: {}, tools: {}, childExtensions: [], text: shippedProfile.text };
	const user = (over: Partial<UserProfile>): UserProfile => ({ name: "lean", dir: "/u/lean", toolsOff: [], toolsDeferred: [], toolsEager: [], featuresOff: [], toolWording: new Map(), hash: "h", ...over });

	it("turns tools and features off and sets deferral", () => {
		const resolved = resolveProfile({ ...empty, tools: { lsp_diagnostics: { deferred: true } } }, {}, "/p", "/p", user({ toolsOff: ["web_fetch"], toolsDeferred: ["notebook_edit"], toolsEager: ["lsp_diagnostics"], featuresOff: ["artifacts"] }));
		expect(resolved.live.has("web_fetch")).toBe(false);
		expect(resolved.features.has("artifacts")).toBe(false);
		expect(resolved.tools.get("notebook_edit")?.deferred).toBe(true);
		expect(resolved.tools.get("lsp_diagnostics")?.deferred).toBe(false);
		expect(resolved.user?.name).toBe("lean");
	});

	it("refuses a guard feature, a pinned tool and a misspelled tool, naming the profile", () => {
		expect(() => resolveProfile(empty, {}, "/p", "/p", user({ featuresOff: ["hooks"] }))).toThrow(/the profile "lean" \(.*lean\) cannot turn off "hooks"/);
		expect(() => resolveProfile(empty, {}, "/p", "/p", user({ toolsOff: ["tool_search"] }))).toThrow(/"tool_search" cannot be turned off/);
		expect(() => resolveProfile(empty, {}, "/p", "/p", user({ toolWording: new Map([["Bash", { append: "x" }]]) }))).toThrow(/the profile "lean".*spelled "bash"/);
	});

	it("refuses wording for one of pi's own tools while no extension registers it again", () => {
		const worded = user({ toolWording: new Map([["read", { append: "x" }]]) });
		expect(() => resolveProfile({ ...empty, features: { "tool-style": false } }, {}, "/p", "/p", worded)).toThrow(/words "read", whose description can change only while the "tool-style" feature is on/);
		expect(resolveProfile(empty, {}, "/p", "/p", worded).user).toBe(worded);
	});

	it("registers a tool with the user's wording, and leaves the others as they are", () => {
		setActiveProfileForTest({ ...activeProfile(), user: user({ toolWording: new Map([["demo", { append: "Mine." }]]) }) });
		const fake = createFakePi();
		const pi = profiledPi(fake.pi as never);
		const other = { name: "other", label: "o", description: "Other.", parameters: {}, execute: async () => ({ content: [], details: {} }) };
		pi.registerTool({ ...other, name: "demo", description: "Demo." } as never);
		pi.registerTool(other as never);
		expect(fake.tools.get("demo")?.description).toBe("Demo.\n\nMine.");
		expect(fake.tools.get("other")?.description).toBe("Other.");
		// /doctor says which wording reached no tool.
		setActiveProfileForTest({ ...activeProfile(), user: user({ toolWording: new Map([["demo", { append: "Mine." }], ["raed", { append: "x" }]]) }) });
		expect(profileSummary("/home/u")).toContain("no tool named raed is registered, so that wording is unused");
	});

	it("puts the user's text after the system prompt, or in its place", async () => {
		const prompt = async (over: Partial<UserProfile>) => {
			setActiveProfileForTest({ ...activeProfile(), user: user(over) });
			const fake = createFakePi();
			systemPromptExtension(fake.pi as never);
			const { cwd } = tempHome("user-prompt-");
			const ctx = createFakeCtx({ cwd, model: { id: "claude-sonnet-5", provider: "anthropic" }, sessionManager: { getSessionId: () => "s" } });
			await fake.fire("session_start", { type: "session_start" }, ctx);
			const result = await fake.fireOne<{ systemPrompt: string }>("before_agent_start", { type: "before_agent_start", systemPromptOptions: { cwd, selectedTools: ["read"], appendSystemPrompt: "FROM-FLAG" } }, ctx);
			return result!.systemPrompt;
		};
		const added = await prompt({ appendSystemPrompt: "FROM-PROFILE" });
		expect(added).toContain("FROM-FLAG\n\nFROM-PROFILE");
		expect(added.length).toBeGreaterThan(200);
		expect(await prompt({ systemPrompt: "ONLY THIS", appendSystemPrompt: "FROM-PROFILE" })).toBe("ONLY THIS\n\nFROM-FLAG\n\nFROM-PROFILE");
	});

	it("is part of a request's identity, so a session resumed under another profile renders again", () => {
		const model = { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-5" };
		expect(requestIdentity(model as never)).not.toHaveProperty("profile");
		setActiveProfileForTest({ ...activeProfile(), user: user({ hash: "abc" }) });
		expect(requestIdentity(model as never)?.profile).toBe(":lean:abc");
		// The environment's off-switches shape the head too, in any order they are written.
		setActiveProfileForTest(undefined);
		const off = (tools: string) => profileKey({ [`${productBrand.envPrefix}_TOOLS_OFF`]: tools });
		expect(off("web_fetch, notebook_edit")).toBe(off("notebook_edit,web_fetch"));
		expect(off("web_fetch")).not.toBe(off("notebook_edit"));
		expect(profileKey({})).toBeUndefined();
	});
});
