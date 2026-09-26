import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import bashExtension from "../../extensions/bash/index.ts";
import {
	APP_AGENT_DIR_VAR,
	appAgentDir,
	applyLauncherEnv,
	childProcessEnv,
	installMethodFor,
	LAUNCHER_ENV_VAR,
	LAUNCHER_VARS,
} from "../../extensions/lib/app-launch.mjs";
import { piShellEnv, spawnShellCommand, withChildProcessEnv } from "../../extensions/lib/shell-spawn.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const home = resolve("/home/alice");

describe("installMethodFor (where the app's bin lives)", () => {
	// The real layouts: `npm root -g` under Homebrew's Node is <prefix>/lib/node_modules,
	// a formula install lives in <prefix>/Cellar/onecode/<version>/libexec.
	const layouts: Array<[string, string, "brew" | "npm"]> = [
		["Homebrew formula (Apple silicon)", "/opt/homebrew/Cellar/onecode/0.4.1/libexec/lib/node_modules/@one-ai/one-code/bin.mjs", "brew"],
		["Homebrew formula (Intel)", "/usr/local/Cellar/onecode/0.4.1/libexec/lib/node_modules/@one-ai/one-code/bin.mjs", "brew"],
		["Linuxbrew formula", "/home/linuxbrew/.linuxbrew/Cellar/onecode/0.4.1/libexec/lib/node_modules/@one-ai/one-code/bin.mjs", "brew"],
		["npm -g under Homebrew's node (Apple silicon)", "/opt/homebrew/lib/node_modules/@one-ai/one-code/bin.mjs", "npm"],
		["npm -g under Homebrew's node (Intel)", "/usr/local/lib/node_modules/@one-ai/one-code/bin.mjs", "npm"],
		["npm -g under Linuxbrew's node", "/home/linuxbrew/.linuxbrew/lib/node_modules/@one-ai/one-code/bin.mjs", "npm"],
		["npm -g under nvm", "/Users/alice/.nvm/versions/node/v24.1.0/lib/node_modules/@one-ai/one-code/bin.mjs", "npm"],
		["npm -g on Windows", "C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\@one-ai\\one-code\\bin.mjs", "npm"],
	];
	for (const [label, path, method] of layouts) {
		it(`${label} is ${method}`, () => expect(installMethodFor(path)).toBe(method));
	}
	it("an unresolvable bin counts as npm", () => expect(installMethodFor(undefined)).toBe("npm"));
});

describe("the app's agent directory", () => {
	it("never adopts a user-exported PI_CODING_AGENT_DIR", () => {
		expect(appAgentDir({ PI_CODING_AGENT_DIR: "/home/alice/.config/pi/agent" }, home)).toBe(join(home, ".onecode", "agent"));
	});

	it("moves only with the app's own knob", () => {
		expect(appAgentDir({ [APP_AGENT_DIR_VAR]: "/scratch/agent", PI_CODING_AGENT_DIR: "/elsewhere" }, home)).toBe("/scratch/agent");
	});

	it("sets PI_CODING_AGENT_DIR over a user value and records the user's values", () => {
		const env: Record<string, string | undefined> = { PI_CODING_AGENT_DIR: "/home/alice/.config/pi/agent", HOME: home };
		const agentDir = applyLauncherEnv(env, { home, appVersion: "0.4.2", installMethod: "npm" });
		expect(agentDir).toBe(join(home, ".onecode", "agent"));
		expect(env.PI_CODING_AGENT_DIR).toBe(agentDir);
		expect(env.PI_SKIP_VERSION_CHECK).toBe("1");
		expect(env.CC_VERSION).toBe("0.4.2");
		expect(env.ONECODE_INSTALL_METHOD).toBe("npm");
		expect(JSON.parse(env[LAUNCHER_ENV_VAR] ?? "")).toEqual({
			PI_CODING_AGENT_DIR: "/home/alice/.config/pi/agent",
			PI_SKIP_VERSION_CHECK: null,
			CC_VERSION: null,
			ONECODE_INSTALL_METHOD: null,
		});
	});

	it("keeps the first record when applied twice", () => {
		const env: Record<string, string | undefined> = { PI_CODING_AGENT_DIR: "/user/pi" };
		applyLauncherEnv(env, { home, appVersion: "1", installMethod: "npm" });
		applyLauncherEnv(env, { home, appVersion: "1", installMethod: "npm" });
		expect(JSON.parse(env[LAUNCHER_ENV_VAR] ?? "").PI_CODING_AGENT_DIR).toBe("/user/pi");
	});
});

describe("childProcessEnv", () => {
	const launched = () => {
		const env: Record<string, string | undefined> = { PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/user/pi", KEEP: "yes" };
		applyLauncherEnv(env, { home, appVersion: "0.4.2", installMethod: "brew" });
		return env;
	};

	it("puts the user's values back and drops what the app added", () => {
		const child = childProcessEnv(launched(), "linux");
		expect(child.PI_CODING_AGENT_DIR).toBe("/user/pi");
		for (const name of ["PI_SKIP_VERSION_CHECK", "CC_VERSION", "ONECODE_INSTALL_METHOD", LAUNCHER_ENV_VAR]) expect(child).not.toHaveProperty(name);
		expect(child.KEEP).toBe("yes");
		expect(child.PATH).toBe("/usr/bin");
	});

	it("leaves the environment untouched outside the app", () => {
		const env = { PI_CODING_AGENT_DIR: "/user/pi", CC_VERSION: "x" };
		expect(childProcessEnv(env, "linux")).toBe(env);
	});

	it("drops every launcher variable when the record does not parse", () => {
		const child = childProcessEnv({ [LAUNCHER_ENV_VAR]: "{", PI_CODING_AGENT_DIR: "/app/agent", CC_VERSION: "1", OTHER: "1" }, "linux");
		expect(Object.keys(child)).toEqual(["OTHER"]);
	});

	it("matches names in any case on Windows only", () => {
		const env = { [LAUNCHER_ENV_VAR]: JSON.stringify({ PI_CODING_AGENT_DIR: null }), pi_coding_agent_dir: "/app/agent" };
		expect(childProcessEnv(env, "win32")).toEqual({});
		expect(childProcessEnv(env, "linux")).toEqual({ pi_coding_agent_dir: "/app/agent" });
	});

	it("covers exactly the variables the launcher sets", () => {
		expect([...LAUNCHER_VARS].sort()).toEqual(["CC_VERSION", "ONECODE_INSTALL_METHOD", "PI_CODING_AGENT_DIR", "PI_SKIP_VERSION_CHECK"]);
	});
});

describe("spawned commands under the app get the user's environment", { timeout: 20_000 }, () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	/** Stub the launcher's environment on process.env, with the user's own pi dir exported before launch. */
	const launchApp = () => {
		for (const name of [...LAUNCHER_VARS, LAUNCHER_ENV_VAR]) vi.stubEnv(name, undefined);
		vi.stubEnv("PI_CODING_AGENT_DIR", "/user/pi");
		const agentDir = applyLauncherEnv(process.env, { home, appVersion: "0.4.2", installMethod: "npm" });
		expect(process.env.PI_CODING_AGENT_DIR).toBe(agentDir);
	};
	const script = `process.stdout.write(JSON.stringify({ dir: process.env.PI_CODING_AGENT_DIR ?? null, cc: process.env.CC_VERSION ?? null, record: process.env.${LAUNCHER_ENV_VAR} ?? null }))`;
	const expected = { dir: "/user/pi", cc: null, record: null };

	it("spawnShellCommand (hooks, background shells, monitor, PowerShell)", async () => {
		launchApp();
		const child = spawnShellCommand({ shell: process.execPath, args: ["-e"] }, script, { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, EXTRA: "1" } });
		let out = "";
		child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
		await new Promise((done) => child.on("close", done));
		expect(JSON.parse(out)).toEqual(expected);
	});

	it("operations wrapped for the user's ! commands", async () => {
		launchApp();
		let seen: NodeJS.ProcessEnv | undefined;
		const ops = withChildProcessEnv(
			{
				exec: async (_command, _cwd, options) => {
					seen = options.env;
					return { exitCode: 0 };
				},
			},
			() => piShellEnv("/app/agent/bin"),
		);
		await ops.exec("pi list", "/tmp", { onData: () => {} });
		expect(seen?.PI_CODING_AGENT_DIR).toBe("/user/pi");
		expect(seen?.CC_VERSION).toBeUndefined();
		expect(seen?.PATH?.split(process.platform === "win32" ? ";" : ":")[0]).toBe("/app/agent/bin");
	});

	it("the bash tool's foreground command", async () => {
		launchApp();
		const fake = createFakePi();
		bashExtension(fake.pi as never);
		const bash = fake.tools.get("bash");
		if (!bash) throw new Error("bash tool not registered");
		const result = (await bash.execute(
			"call-1",
			{ command: 'printf "%s|%s|%s" "${PI_CODING_AGENT_DIR-unset}" "${CC_VERSION-unset}" "${ONECODE_LAUNCHER_ENV-unset}"' },
			undefined,
			undefined,
			createFakeCtx({ mode: "print", cwd: process.cwd() }),
		)) as { content: Array<{ text: string }> };
		expect(result.content[0]?.text).toContain("/user/pi|unset|unset");
	});

	it("registers the ! command operations only under the app", async () => {
		const fake = createFakePi();
		bashExtension(fake.pi as never);
		vi.stubEnv(LAUNCHER_ENV_VAR, undefined);
		expect(await fake.fireOne("user_bash", { type: "user_bash", command: "ls", excludeFromContext: false, cwd: "/" })).toBeUndefined();
		launchApp();
		const result = await fake.fireOne<{ operations?: unknown }>("user_bash", { type: "user_bash", command: "ls", excludeFromContext: false, cwd: "/" });
		expect(result?.operations).toBeDefined();
	});
});

describe("app/bin.mjs applies the launcher environment", () => {
	const source = readFileSync(join(repoRoot, "app", "bin.mjs"), "utf8");

	it("sets it through app-launch.mjs, never inheriting PI_CODING_AGENT_DIR", () => {
		expect(source).toContain("applyLauncherEnv(process.env,");
		expect(source).not.toMatch(/PI_CODING_AGENT_DIR\s*\|\|=/);
		expect(source).not.toMatch(/process\.env\.(CC_VERSION|ONECODE_INSTALL_METHOD|PI_SKIP_VERSION_CHECK)\s*\|?\|?=/);
	});

	it("before the doctor fast path exits and before pi is imported", () => {
		const applyAt = source.indexOf("applyLauncherEnv(process.env,");
		expect(applyAt).toBeGreaterThan(0);
		expect(source.indexOf("if (runDoctor) {")).toBeGreaterThan(applyAt);
		expect(source.indexOf('await import("@earendil-works/pi-coding-agent")')).toBeGreaterThan(applyAt);
	});
});
