/**
 * The user's global AGENTS.md files (lib/instructions.ts): pi's
 * `<agent dir>/AGENTS.md` and the profile's `globalAgentsFiles` (One Code:
 * `~/.agents/AGENTS.md`), and how One Code's provider places them under
 * Claude Code's `instructionFiles` rule, with ~/.claude/CLAUDE.md in the role
 * a project's CLAUDE.md has for its AGENTS.md (decisions/bi-fork.md).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigModeForTest } from "../../extensions/lib/config-mode.ts";
import { openInstructions, projectInstructionFiles } from "../../extensions/lib/instructions.ts";
import { resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile.ts";
import { profile } from "../../profile/index.ts";
import { buildMemoryEntries } from "../../extensions/memory/entries.ts";

let root: string;
let home: string;
let agentDir: string;
let cwd: string;
let piGlobal: string;
let userGlobal: string;
let project: string;
const write = (path: string, content: string) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	return path;
};
const rule = (instructionFiles: string) =>
	write(join(home, ".claude", "settings.json"), JSON.stringify({ pluginConfigs: { "cc-plugin-agents-md@builtin": { options: { instructionFiles } } } }));
const loaded = () => openInstructions(home, agentDir).sections({ cwd, includeExternal: false }).contextFiles.map((file) => [file.path, file.descriptor]);

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "global-agents-")));
	home = join(root, "home");
	agentDir = join(home, ".pi", "agent");
	cwd = join(root, "repo");
	piGlobal = write(join(agentDir, "AGENTS.md"), "pi global\n");
	userGlobal = write(join(home, ".agents", "AGENTS.md"), "user global\n");
	project = write(join(cwd, "AGENTS.md"), "project\n");
});
afterEach(() => {
	setActiveProfileForTest(undefined);
	resetConfigModeForTest("claude-compatible");
	rmSync(root, { recursive: true, force: true });
});

describe("the global AGENTS.md files under One Code's provider", () => {
	it("load before the project's under the default rule when there is no ~/.claude/CLAUDE.md", () => {
		expect(loaded()).toEqual([
			[piGlobal, "agentsGlobal"],
			[userGlobal, "agentsGlobal"],
			[project, "agents"],
		]);
	});

	it("give way to ~/.claude/CLAUDE.md under the default rule, as a project's AGENTS.md gives way to its CLAUDE.md", () => {
		const claude = write(join(home, ".claude", "CLAUDE.md"), "claude global\n");
		expect(loaded()).toEqual([
			[claude, "global"],
			[project, "agents"],
		]);
	});

	it("load beside ~/.claude/CLAUDE.md under claude-md-and-agents-md, unless it imports one already", () => {
		rule("claude-md-and-agents-md");
		const claude = write(join(home, ".claude", "CLAUDE.md"), "claude global\n@~/.agents/AGENTS.md\n");
		expect(loaded()).toEqual([
			[claude, "global"],
			[piGlobal, "agentsGlobal"],
			[project, "agents"],
		]);
	});

	it("never load under claude-md or managed-only", () => {
		rule("claude-md");
		expect(loaded()).toEqual([]);
		rule("managed-only");
		expect(loaded()).toEqual([]);
	});

	it("always load in independent mode, which reads no CLAUDE.md", () => {
		resetConfigModeForTest("independent");
		write(join(home, ".claude", "CLAUDE.md"), "claude global\n");
		expect(loaded()).toEqual([
			[piGlobal, "agentsGlobal"],
			[userGlobal, "agentsGlobal"],
			[project, "agents"],
		]);
	});

	it("reach the classifier beside CLAUDE.md, and stay out of the banner's project list", () => {
		write(join(home, ".claude", "CLAUDE.md"), "claude global\n");
		const paths = openInstructions(home, agentDir).classifier({ cwd }).map((file) => file.path);
		expect(paths).toContain(piGlobal);
		expect(paths).toContain(userGlobal);
		expect(projectInstructionFiles({ cwd, home })).toEqual([project]);
	});

	it("leave pi's out when the caller has no agent dir", () => {
		expect(openInstructions(home, undefined).sections({ cwd, includeExternal: false }).contextFiles.map((file) => file.path)).toEqual([userGlobal, project]);
	});
});

describe("the global AGENTS.md files without a provider", () => {
	it("load first, with their imports read anywhere (the user wrote them)", () => {
		setActiveProfileForTest(resolveProfile({ ...profile, sources: undefined }, {}, "/profile"));
		write(join(root, "elsewhere.md"), "ELSEWHERE\n");
		write(userGlobal, "user global\n@../../elsewhere.md\n");
		const files = openInstructions(home, agentDir).sections({ cwd, includeExternal: false }).contextFiles;
		expect(files.map((file) => file.path)).toEqual([piGlobal, userGlobal, project]);
		expect(files[1].content).toContain("ELSEWHERE");
	});
});

describe("a global AGENTS.md that is also a project's", () => {
	it("stays the project's own file, listed once", () => {
		const checkout = join(root, "dotfiles");
		const own = write(join(checkout, "AGENTS.md"), "dotfiles\n");
		rmSync(userGlobal);
		symlinkSync(own, userGlobal);
		write(join(home, ".claude", "CLAUDE.md"), "claude global\n");
		const files = openInstructions(home, undefined).sections({ cwd: checkout, includeExternal: false }).contextFiles;
		expect(files.map((file) => [file.path, file.descriptor])).toEqual([
			[join(home, ".claude", "CLAUDE.md"), "global"],
			[own, "agents"],
		]);
	});
});

describe("/memory's rows", () => {
	it("offer each global AGENTS.md the agent reads", () => {
		const rows = buildMemoryEntries({ cwd, home, homeOneCodeDir: join(home, ".onecode"), agentDir, memoryDir: undefined });
		expect(rows.filter((row) => row.title === "Global AGENTS.md").map((row) => row.path)).toEqual([piGlobal, userGlobal]);
	});
});

