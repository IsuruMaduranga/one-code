/**
 * pi 0.99's built-in tool search and MCP, which One Code replaces: the
 * enablement rule (a copy of pi's), the app's settings edit, the startup
 * notice, the `/doctor` fix, and the pi facts all of it rests on.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { replacedBuiltinsView } from "../../extensions/doctor/builtins.ts";
import { piHasBuiltinExtensions } from "../../extensions/lib/pi-version.ts";
import {
	BUILTIN_EXTENSIONS_PI,
	builtinEnabled,
	builtinsLeftOn,
	REPLACED_BUILTINS,
	replacedBuiltinsFix,
	replacedBuiltinsNotice,
	turnOffPrompt,
	withBuiltinsTurnedOff,
	withReplacedBuiltinsOff,
} from "../../extensions/lib/replaced-builtins.mjs";
import { piDist, piRoot } from "./helpers/pi-install.ts";

/** pi's own glob matcher, the one its `!` override entries go through. */
const { minimatch } = createRequire(join(piRoot, "package.json"))("minimatch") as { minimatch: (path: string, pattern: string) => boolean };

describe("builtinEnabled (pi's rule)", () => {
	it("is on by default and off with a user -builtin entry", () => {
		expect(builtinEnabled("mcp", undefined, undefined)).toBe(true);
		expect(builtinEnabled("mcp", ["-builtin:mcp"], [])).toBe(false);
		expect(builtinEnabled("mcp", ["-builtin:tool-search"], [])).toBe(true);
	});

	it("lets a - entry win over a + entry, and a !glob turn it off", () => {
		expect(builtinEnabled("mcp", ["+builtin:mcp", "-builtin:mcp"], [])).toBe(false);
		expect(builtinEnabled("mcp", ["!builtin:*"], [])).toBe(false);
		expect(builtinEnabled("mcp", ["!builtin:*", "+builtin:mcp"], [])).toBe(true);
	});

	it("lets a matching project entry override the user setting", () => {
		expect(builtinEnabled("mcp", ["-builtin:mcp"], ["+builtin:mcp"])).toBe(true);
		expect(builtinEnabled("mcp", [], ["-builtin:mcp"])).toBe(false);
		expect(builtinEnabled("mcp", ["-builtin:mcp"], ["+builtin:tool-search"])).toBe(false);
	});

	it("reads !globs as pi's minimatch does: braces, classes, wildcards", () => {
		const patterns = ["builtin:*", "builtin:{tool-search,mcp}", "builtin:{mcp,{a,tool-*}}", "builtin:m?p", "builtin:[mt]*", "builtin:[!m]*", "builtin:mc", "*:mcp", "builtin:{mcp", "builtin:mcp.*"];
		for (const pattern of patterns) {
			for (const name of ["mcp", "tool-search"]) {
				expect(builtinEnabled(name, [`!${pattern}`], []), `${pattern} on ${name}`).toBe(!minimatch(`builtin:${name}`, pattern));
			}
		}
	});

	it("ignores entries that are not strings", () => {
		expect(builtinEnabled("mcp", [{ source: "x" }, "-builtin:mcp"], null)).toBe(false);
	});
});

describe("builtinsLeftOn", () => {
	it("names each built-in still on, with the scope that keeps it on", () => {
		expect(builtinsLeftOn([], [])).toEqual([
			{ name: "tool-search", ours: "tool search", scope: "user" },
			{ name: "mcp", ours: "MCP", scope: "user" },
		]);
		expect(builtinsLeftOn(["-builtin:tool-search", "-builtin:mcp"], ["+builtin:mcp"])).toEqual([{ name: "mcp", ours: "MCP", scope: "project" }]);
		expect(builtinsLeftOn(["-builtin:tool-search", "-builtin:mcp"], [])).toEqual([]);
	});
});

describe("withReplacedBuiltinsOff (the app's settings edit)", () => {
	it("adds a - entry for each built-in, keeping the user's other entries", () => {
		expect(withReplacedBuiltinsOff(undefined)).toEqual({ extensions: ["-builtin:tool-search", "-builtin:mcp"], changed: true });
		expect(withReplacedBuiltinsOff(["./mine.ts"])).toEqual({ extensions: ["./mine.ts", "-builtin:tool-search", "-builtin:mcp"], changed: true });
	});

	it("leaves a built-in the user already has an entry for", () => {
		expect(withReplacedBuiltinsOff(["+builtin:mcp"])).toEqual({ extensions: ["+builtin:mcp", "-builtin:tool-search"], changed: true });
		expect(withReplacedBuiltinsOff(["-builtin:tool-search", "-builtin:mcp"])).toEqual({ extensions: ["-builtin:tool-search", "-builtin:mcp"], changed: false });
	});
});

describe("the notice and the fix", () => {
	const both = builtinsLeftOn([], []);

	it("names both routes, and says to keep One Code", () => {
		expect(replacedBuiltinsNotice(both)).toBe(
			"One Code provides its own tool search and MCP, so pi skips its built-in tool-search and mcp extensions and warns about them at startup. " +
				"Keep One Code installed. To hide the warnings, run `pi config` and turn off tool-search and mcp under Built-in, or run /doctor to have it done for you.",
		);
		expect(replacedBuiltinsNotice([both[1]], "onecode config")).toBe(
			"One Code provides its own MCP, so pi skips its built-in mcp extension and warns about it at startup. " +
				"Keep One Code installed. To hide the warning, run `onecode config` and turn off mcp under Built-in, or run /doctor to have it done for you.",
		);
		expect(replacedBuiltinsNotice([])).toBeUndefined();
	});

	it("spells out the settings edit for each scope", () => {
		const paths = { user: "/h/.pi/agent/settings.json", project: "/p/.pi/settings.json" };
		expect(replacedBuiltinsFix(both, paths)).toBe(
			'Add "-builtin:tool-search" and "-builtin:mcp" to the "extensions" array in /h/.pi/agent/settings.json (or run `pi config` and turn tool-search and mcp off under Built-in). It takes effect at the next start.',
		);
		expect(replacedBuiltinsFix(builtinsLeftOn(["-builtin:tool-search"], ["+builtin:mcp"]), paths)).toBe(
			'Remove "+builtin:mcp" from the "extensions" array in /p/.pi/settings.json. It takes effect at the next start.',
		);
	});
});

describe("replacedBuiltinsView", () => {
	const root = mkdtempSync(join(tmpdir(), "replaced-builtins-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });

	it("reads the user and project settings through pi's SettingsManager", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-builtin:tool-search", "-builtin:mcp"] }));
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: ["+builtin:mcp"] }));
		const view = replacedBuiltinsView("0.99.2", () => SettingsManager.create(cwd, agentDir), { agentDir, cwd });
		expect(view).toEqual({
			left: [{ name: "mcp", ours: "MCP", scope: "project" }],
			paths: { user: join(agentDir, "settings.json"), project: join(cwd, ".pi", "settings.json") },
		});
	});

	it("is undefined before pi 0.99 and when the settings cannot be read", () => {
		expect(replacedBuiltinsView("0.87.1", () => SettingsManager.create(cwd, agentDir), { agentDir, cwd })).toBeUndefined();
		const broken = () => {
			throw new Error("bad settings");
		};
		expect(replacedBuiltinsView("0.99.2", broken, { agentDir, cwd })).toBeUndefined();
	});
});

describe("the pi facts this rests on", () => {
	it("pi ships the built-ins from the version we gate on", () => {
		expect(piHasBuiltinExtensions("0.99.0", BUILTIN_EXTENSIONS_PI)).toBe(true);
		expect(piHasBuiltinExtensions("0.87.1", BUILTIN_EXTENSIONS_PI)).toBe(false);
		expect(piHasBuiltinExtensions(undefined, BUILTIN_EXTENSIONS_PI)).toBe(false);
	});

	it("each built-in we replace is still a replaceable pi built-in", () => {
		const source = readFileSync(join(piDist, "extensions", "index.js"), "utf8");
		for (const { name } of REPLACED_BUILTINS) {
			expect(source, name).toContain(`{ name: "${name}", factory: `);
		}
		expect(source).toMatch(/name: "tool-search", factory: toolSearchExtension, replaceable: true/);
		expect(source).toMatch(/name: "mcp", factory: mcpExtension, replaceable: true/);
	});

	it("pi still enables built-ins by the rule we copy", () => {
		const source = readFileSync(join(piDist, "core", "package-manager.js"), "utf8");
		expect(source).toContain("const projectEnabled = applyAutoloadDisabledPatterns([path], getOverridePatterns(projectSettings.extensions ?? []), projectBaseDir).get(path);");
		expect(source).toContain("projectEnabled ?? isEnabledByOverrides(path, globalSettings.extensions ?? [], globalBaseDir)");
	});
});

describe("the one-time question", () => {
	const both = builtinsLeftOn([], []);

	it("turns the built-ins off, replacing the user's own + entries", () => {
		expect(withBuiltinsTurnedOff(["./mine.ts", "+builtin:mcp"], ["tool-search", "mcp"])).toEqual(["./mine.ts", "-builtin:tool-search", "-builtin:mcp"]);
		expect(withBuiltinsTurnedOff(undefined, ["mcp"])).toEqual(["-builtin:mcp"]);
		expect(withBuiltinsTurnedOff(["-builtin:mcp"], ["mcp"])).toEqual(["-builtin:mcp"]);
	});

	it("says why, what changes, where, and how to undo it", () => {
		const text = turnOffPrompt(both, "/h/.pi/agent/settings.json");
		expect(text.split("\n")[0]).toBe("Turn off pi's built-in tool-search and mcp?");
		expect(text).toContain("warns about each at every start, telling you to remove One Code");
		expect(text).toContain("changes nothing while One Code is installed");
		expect(text).toContain('"-builtin:tool-search" and "-builtin:mcp" to "extensions" in /h/.pi/agent/settings.json');
		expect(text).toContain("turn them back on with `pi config`");
	});
});
