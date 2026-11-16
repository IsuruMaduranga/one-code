/**
 * pi's `--tools`, `--exclude-tools` and `--no-tools` reach the live tool set
 * (lib/profile/pi-tool-flags.ts, lib/profile/profile.ts launchToolFilter):
 * the copy of pi's rules agrees with the registry real pi sessions build
 * under each flag form, and the text built for the live set follows it.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, parseArgs, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseToolFlags, piRegisters, piToolFilter, piToolFilterKey } from "../../extensions/lib/profile/pi-tool-flags.ts";
import { withoutOff } from "../../extensions/lib/profile/live-tools.ts";
import { activeProfile, launchToolFilter, PRODUCT_DIR, PROFILE_DIR, profileKey, resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import type { Profile } from "../../extensions/lib/profile/profile-contract.ts";
import { childLive } from "../../extensions/lib/agents/child-extensions.ts";
import { buildClaudeCodeSystemPrompt } from "../../extensions/request/system-prompt/template.ts";
import { PROMPT_TIERS } from "../../extensions/lib/models/model-tier.ts";
import { profile as shipped } from "../../profile/index.ts";
import { mentions } from "./helpers/tool-mentions.ts";

/** The flag forms pi's help and parser accept, short ones and patterns included. */
const FLAG_FORMS: string[][] = [
	[],
	["--exclude-tools", "Agent"],
	["-xt", "Agent,web_fetch"],
	["--tools", "read,bash"],
	["--tools", "read,bash", "--exclude-tools", "bash"],
	["--tools", "read,Agent", "--exclude-tools", "Agent"],
	["--exclude-tools", "web_*"],
	["-t", "read,*_search"],
	["--tools", "read,mcp__srv__*"],
	["--tools", "read"],
	["--no-tools"],
	["-nt", "--tools", "+read,+Agent,-read"],
	["--tools", "+web_fetch,-read"],
	["--no-builtin-tools"],
	["--exclude-tools", "mcp__*,tool_search"],
	["--exclude-tools", "a,b", "--exclude-tools", "Agent"],
];

/** Tools registered beside pi's built-ins in the sessions below: base tools, an MCP server tool and an MCP resource tool. */
const CUSTOM = ["Agent", "SendMessage", "workflow", "web_fetch", "web_search", "tool_search", "skill", "mcp__srv__query", "list_mcp_resources"];
const BUILT_IN = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"];
const NAMES = [...BUILT_IN, ...CUSTOM];

/** Every flag pi's parser names, read from its source: a flag pi adds is checked without a change here. */
function piFlags(): string[] {
	const source = readFileSync(join(import.meta.dirname, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli", "args.js"), "utf8");
	const body = source.slice(source.indexOf("export function parseArgs"), source.indexOf("export function printHelp"));
	return [...new Set([...body.matchAll(/arg === "(-[A-Za-z-]+)"/g)].map((match) => match[1]))];
}

/** The tool flags pi's own parser finds in `args`. */
const piParsed = (args: string[]) => {
	const { tools, noTools, excludeTools } = parseArgs(args);
	return { ...(tools ? { tools } : {}), ...(noTools ? { noTools } : {}), ...(excludeTools ? { excludeTools } : {}) };
};

describe("pi's tool flags, as the arguments carry them", () => {
	it("are read as pi's parser reads them, after every flag it knows", () => {
		const flags = piFlags();
		expect(flags.length).toBeGreaterThan(40);
		for (const flag of [...flags, "--unknown", "--unknown=x", "-u", "@file", "word"]) {
			for (const rest of [["-t", "read"], ["--exclude-tools", "Agent", "--no-tools"], ["-nt"], ["---x", "-xt", "a"], ["--", "--tools", "read"]]) {
				const args = [flag, ...rest];
				expect(parseToolFlags(args), args.join(" ")).toEqual(piParsed(args));
			}
		}
	});

	it.each([
		[["--tools", "read,+bash"]],
		[["--tools", "+web_*"]],
		[["--tools", "read", "--tools", "+a,-b"]],
		[["--tools", " read , ,bash "]],
		[["--exclude-tools", ""]],
		[["--exclude-tools", "a", "-xt", "b"]],
		[["-p", "--tools", "read"]],
		[["--mode", "--tools", "read"]],
		[["--tools"]],
	])("are read as pi's parser reads %j", (args) => {
		expect(parseToolFlags(args)).toEqual(piParsed(args));
	});
});

describe("pi's tool flags, as the live tool set reads them", () => {
	let home: string;
	beforeAll(() => {
		home = mkdtempSync(join(tmpdir(), "pi-tool-flags-"));
	});
	afterAll(() => rmSync(home, { recursive: true, force: true }));

	/** The tools a real pi session registers under `args`, mapped to session options as pi's main.js does. */
	async function piRegistry(args: string[]): Promise<Set<string>> {
		const parsed = parseArgs(args);
		const agentDir = join(home, "agent");
		const settingsManager = SettingsManager.create(home, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: home, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({
			credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} },
			modelsPath: null,
			refreshOnCreate: false,
		});
		const customTools = CUSTOM.map((name) => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [], details: undefined }) }));
		const { session } = await createAgentSession({
			cwd: home,
			agentDir,
			resourceLoader,
			settingsManager,
			modelRuntime,
			sessionManager: SessionManager.inMemory(home),
			customTools: customTools as never,
			...(parsed.noTools ? { noTools: "all" as const } : parsed.noBuiltinTools ? { noTools: "builtin" as const } : {}),
			...(parsed.tools ? { tools: parsed.tools } : {}),
			...(parsed.excludeTools ? { excludeTools: parsed.excludeTools } : {}),
		});
		try {
			return new Set(session.getAllTools().map((tool) => tool.name));
		} finally {
			session.dispose();
		}
	}

	it.each(FLAG_FORMS.map((args) => [args.join(" ") || "(no flags)", args]))("agree with pi's registry under %s", async (_label, args) => {
		const registry = await piRegistry(args as string[]);
		const filter = launchToolFilter(args as string[]);
		expect(Object.fromEntries(NAMES.map((name) => [name, piRegisters(filter, name)]))).toEqual(Object.fromEntries(NAMES.map((name) => [name, registry.has(name)])));
	});

	it("compare against a registry the flags really narrow", async () => {
		expect([...(await piRegistry([]))].sort()).toEqual([...NAMES].sort());
		// An allowlist keeps the MCP tools it does not name; one naming an mcp__ entry filters them.
		expect([...(await piRegistry(["--tools", "read,bash"]))].sort()).toEqual(["bash", "list_mcp_resources", "mcp__srv__query", "read"]);
		expect([...(await piRegistry(["--tools", "read,mcp__x*"]))].sort()).toEqual(["read"]);
	});

	it("filter nothing without a registry flag, so the key and the request stay as they were", () => {
		for (const args of [[], ["--tools", "+web_fetch,-read"], ["--no-builtin-tools"], ["-p", "hi"], ["--exclude-tools", ""]]) {
			expect(launchToolFilter(args), args.join(" ")).toBeUndefined();
			expect(piToolFilterKey(launchToolFilter(args))).toBeUndefined();
		}
		// A test runner's own arguments are not pi's (test/setup.ts).
		expect(activeProfile().launchTools).toBeUndefined();
	});

	it("key the filter by what it registers, whatever the order", () => {
		expect(piToolFilterKey(piToolFilter({ excludeTools: ["b", "a"] }))).toBe(piToolFilterKey(piToolFilter({ excludeTools: ["a", "b"] })));
		expect(piToolFilterKey(piToolFilter({ tools: ["read"] }))).not.toBe(piToolFilterKey(piToolFilter({ excludeTools: ["read"] })));
		expect(piToolFilterKey(piToolFilter({ noTools: true }))).not.toBe(piToolFilterKey(piToolFilter({ tools: ["*"] })));
	});
});

describe("the live tool set under pi's tool flags", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		setActiveProfileForTest(undefined);
	});

	const resolved = (args: string[]) => resolveProfile(shipped, {}, PROFILE_DIR, PRODUCT_DIR, undefined, launchToolFilter(args));
	const liveSet = (args: string[]) => Object.fromEntries(["read", "bash", "Agent", "workflow", "web_fetch", "tool_search"].map((name) => [name, resolved(args).live.has(name)]));

	it("follows each flag on top of the profile's switches", () => {
		const plain = liveSet([]);
		expect(liveSet(["--exclude-tools", "Agent"])).toEqual({ ...plain, Agent: false });
		expect(liveSet(["--tools", "read,bash"])).toEqual({ read: plain.read, bash: plain.bash, Agent: false, workflow: false, web_fetch: false, tool_search: false });
		expect(liveSet(["--tools", "read,bash,Agent", "--exclude-tools", "bash"])).toEqual({ read: plain.read, bash: false, Agent: plain.Agent, workflow: false, web_fetch: false, tool_search: false });
		expect(liveSet(["--exclude-tools", "web_*,work*"])).toEqual({ ...plain, web_fetch: false, workflow: false });
		expect(liveSet(["--no-tools"])).toEqual({ read: false, bash: false, Agent: false, workflow: false, web_fetch: false, tool_search: false });
	});

	it("never turns on what the profile turned off", () => {
		const off = resolveProfile({ ...shipped, tools: { ...shipped.tools, web_fetch: { enabled: false } } }, {}, PROFILE_DIR, PRODUCT_DIR, undefined, launchToolFilter(["--tools", "web_fetch,read"]));
		expect(off.live.has("web_fetch")).toBe(false);
		expect(off.live.has("read")).toBe(true);
	});

	it("restricts an in-process child's view as it restricts the session", () => {
		setActiveProfileForTest(resolved(["--exclude-tools", "web_fetch"]));
		expect(activeProfile().live.has("web_fetch")).toBe(false);
		expect(childLive().has("web_fetch")).toBe(false);
		setActiveProfileForTest(resolved([]));
		expect(childLive().has("web_fetch")).toBe(true);
	});

	it("builds the profile's text for the flags", () => {
		const marker: Profile = {
			features: {},
			tools: {},
			childExtensions: [],
			text: (options) => ({ ...shipped.text(options), systemPrompt: { ...shipped.text(options).systemPrompt, tail: () => [withoutOff("Use read. Ask Agent.", options.live, { Agent: [" Ask Agent."] })] } }),
		};
		const tail = (args: string[]) => resolveProfile(marker, {}, "/p", "/p", undefined, launchToolFilter(args)).text.systemPrompt.tail({} as never);
		expect(tail([])).toEqual(["Use read. Ask Agent."]);
		expect(tail(["--exclude-tools", "Agent"])).toEqual(["Use read."]);
	});

	it("opens a new epoch when a session resumes under other flags, and only then", () => {
		const before = profileKey();
		setActiveProfileForTest(resolved(["--exclude-tools", "Agent"]));
		const flagged = profileKey();
		expect(flagged).not.toBe(before);
		expect(flagged).toContain("pi-tools:");
		setActiveProfileForTest(resolved([]));
		expect(profileKey()).toBe(before);
	});

	it.each(PROMPT_TIERS)("leaves every Agent passage out of the %s system prompt under --exclude-tools Agent", (tier) => {
		setActiveProfileForTest(resolved(["--exclude-tools", "Agent"]));
		const prompt = buildClaudeCodeSystemPrompt({ cwd: "/r" } as never, { cwd: "/r", memoryDir: "/m" } as never, tier);
		expect(mentions(prompt, "Agent", {})).toEqual([]);
	});
});
