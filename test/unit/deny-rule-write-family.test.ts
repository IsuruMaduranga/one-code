/**
 * A deny or ask rule with a path on one file-writing tool binds the other two
 * for that path, and a shell line that writes the path takes no fast path.
 * Allow rules stay exact.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decide, matchesPathPattern, parseRules, writeTargetMeetsPathPattern } from "../../extensions/lib/rules/matcher.ts";
import { analyzeShellCommand } from "../../extensions/lib/shell/shell-analysis.ts";
import { useShippedProfileWithAllTools } from "./helpers/profile.ts";

useShippedProfileWithAllTools();
// The native form: on Windows the temp folder is spelled with a short name, which the redirect containment check expands.
const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "write-family-")));
mkdirSync(join(cwd, "config"));
writeFileSync(join(cwd, "config", "prod.yaml"), "x: 1\n");
writeFileSync(join(cwd, "config", "dev.yaml"), "x: 1\n");
writeFileSync(join(cwd, "nb.ipynb"), "{}");
mkdirSync(join(cwd, "build", "out"), { recursive: true });
writeFileSync(join(cwd, "build", "out", "a.js"), "");
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

type Mode = "auto" | "acceptEdits" | "default" | "bypassPermissions" | "dontAsk" | "plan";
const run = (rules: { deny?: string[]; ask?: string[]; allow?: string[] }, toolName: string, subject: string, mode: Mode, fast = true, extra: Record<string, unknown> = {}) =>
	decide({
		toolName,
		subject,
		cwd,
		mode,
		deny: parseRules(rules.deny ?? []),
		ask: parseRules(rules.ask ?? []),
		allow: parseRules(rules.allow ?? []),
		claudeCodeFastPaths: fast,
		resolvedSubject: subject.startsWith("/") ? subject : undefined,
		...extra,
	}).decision;
const prod = join(cwd, "config", "prod.yaml");
const dev = join(cwd, "config", "dev.yaml");
const nb = join(cwd, "nb.ipynb");
const MODES: Mode[] = ["auto", "acceptEdits", "default", "bypassPermissions", "dontAsk"];

describe("a path deny rule on one writing tool", () => {
	const deny = { deny: ["Edit(config/prod.yaml)", "Edit(nb.ipynb)"] };

	it.each(MODES)("refuses write and notebook_edit on that path in %s mode, on every tier", (mode) => {
		for (const fast of [true, false]) {
			expect(run(deny, "edit", prod, mode, fast)).toBe("deny");
			expect(run(deny, "write", prod, mode, fast)).toBe("deny");
			expect(run(deny, "notebook_edit", nb, mode, fast)).toBe("deny");
		}
	});

	it("covers edit from a Write rule and from a NotebookEdit rule", () => {
		expect(run({ deny: ["Write(config/**)"] }, "edit", prod, "auto")).toBe("deny");
		expect(run({ deny: ["NotebookEdit(nb.ipynb)"] }, "write", nb, "acceptEdits")).toBe("deny");
	});

	it("leaves another path and a reading tool alone", () => {
		expect(run(deny, "write", dev, "auto")).toBe("allow");
		expect(run(deny, "read", prod, "default")).toBe("allow");
	});
});

describe("a bare rule on one writing tool", () => {
	it.each(MODES)("refuses all three writing tools anywhere in %s mode, and leaves the read tools alone", (mode) => {
		for (const rule of ["Edit", "Write", "NotebookEdit"]) {
			expect(run({ deny: [rule] }, "edit", dev, mode)).toBe("deny");
			expect(run({ deny: [rule] }, "write", dev, mode)).toBe("deny");
			expect(run({ deny: [rule] }, "notebook_edit", nb, mode)).toBe("deny");
			expect(run({ deny: [rule] }, "read", dev, mode)).not.toBe("deny");
		}
	});

	it("asks for all three as an ask rule, and refuses with no one to ask", () => {
		expect(run({ ask: ["Edit"] }, "write", dev, "auto")).toBe("ask");
		expect(run({ ask: ["Edit"] }, "notebook_edit", nb, "acceptEdits")).toBe("ask");
		expect(run({ ask: ["Edit"] }, "write", dev, "dontAsk")).toBe("deny");
	});

	it("withholds the shell fast path from a line that writes anything, not from a read", () => {
		expect(run({ deny: ["Edit"] }, "bash", "rm config/dev.yaml", "auto")).toBe("classify");
		expect(run({ ask: ["Write"] }, "bash", "printf '' > config/dev.yaml", "acceptEdits")).toBe("ask");
		expect(run({ deny: ["Edit"] }, "bash", "rm config/dev.yaml", "default", true, { sandboxed: true })).toBe("ask");
		expect(run({ deny: ["Edit"] }, "bash", "cat config/dev.yaml", "auto")).toBe("allow");
	});

	it("leaves a bare allow rule exact", () => {
		expect(run({ allow: ["Edit"] }, "edit", join(cwd, "..", "elsewhere.txt"), "default")).toBe("allow");
		expect(run({ allow: ["Edit"] }, "write", join(cwd, "..", "elsewhere.txt"), "default")).toBe("ask");
	});
});

describe("a path ask rule on one writing tool", () => {
	it("asks for the other writing tools, and refuses with no one to ask", () => {
		const ask = { ask: ["Edit(config/prod.yaml)"] };
		expect(run(ask, "write", prod, "auto")).toBe("ask");
		expect(run(ask, "write", prod, "acceptEdits")).toBe("ask");
		expect(run(ask, "write", prod, "dontAsk")).toBe("deny");
		expect(run(ask, "write", dev, "auto")).toBe("allow");
	});
});

describe("a shell line that writes a directory holding a path such a rule names", () => {
	const deny = { deny: ["Edit(config/prod.yaml)"] };

	it.each(["rm -r config", "rm -rf config", "rm -rf ./config/", "rm -r build config"])("%s takes no fast path", (command) => {
		expect(run(deny, "bash", command, "auto")).toBe("classify");
		expect(run(deny, "bash", command, "acceptEdits")).toBe("ask");
		expect(run(deny, "bash", command, "dontAsk")).toBe("deny");
		expect(run(deny, "bash", command, "default", true, { sandboxed: true })).toBe("ask");
	});

	it("reads the rule as a glob: a wildcard rule may lie under any directory its literal start allows", () => {
		expect(run({ deny: ["Edit(config/**)"] }, "bash", "rm -r config", "acceptEdits")).toBe("ask");
		expect(run({ ask: ["Write(**/prod.yaml)"] }, "bash", "rm -r config", "acceptEdits")).toBe("ask");
		expect(run({ deny: ["Edit(conf*/prod.yaml)"] }, "bash", "rm -r config", "acceptEdits")).toBe("ask");
		// Only the rule's literal start can rule a directory out, so a wildcard
		// rule that starts with one withholds the fast path from every directory.
		expect(run({ deny: ["Edit(**/*.pem)"] }, "bash", "rm -r build", "acceptEdits")).toBe("ask");
	});

	it("keeps the fast path for a directory no rule's path can lie under", () => {
		expect(run(deny, "bash", "rm -r build", "auto")).toBe("allow");
		expect(run(deny, "bash", "rm -rf build/out", "acceptEdits")).toBe("allow");
		expect(run({ deny: ["Edit(config/**)"] }, "bash", "rm -r build", "acceptEdits")).toBe("allow");
	});

	// `cp -r build staging` creates `staging/secret.yaml`; nothing exists at `staging` to ask.
	it("counts a target that does not exist yet as a directory that may hold the path", () => {
		const rule = { deny: ["Edit(staging/secret.yaml)"] };
		expect(run(rule, "bash", "cp -r build staging", "acceptEdits")).toBe("ask");
		expect(run(rule, "bash", "cp -r build staging", "auto")).toBe("classify");
		expect(run(rule, "bash", "cp -r build other", "acceptEdits")).toBe("allow");
		expect(writeTargetMeetsPathPattern("staging/secret.yaml", join(cwd, "staging"), cwd)).toBe(true);
		expect(writeTargetMeetsPathPattern("config/prod.yaml/x", join(cwd, "config", "prod.yaml"), cwd)).toBe(false);
		// A file holds nothing beneath it.
		expect(run({ deny: ["Edit(config/dev.yaml/**)"] }, "bash", "rm config/dev.yaml", "acceptEdits")).toBe("allow");
	});

	it("counts the working directory itself as holding every relative rule path", () => {
		expect(writeTargetMeetsPathPattern("config/prod.yaml", cwd, cwd)).toBe(true);
		expect(writeTargetMeetsPathPattern("config/prod.yaml", join(cwd, "config"), cwd)).toBe(true);
		expect(writeTargetMeetsPathPattern("config/prod.yaml", join(cwd, "build"), cwd)).toBe(false);
		// An exact rule path that only starts with the directory's name is not beneath it.
		expect(writeTargetMeetsPathPattern("configs/prod.yaml", join(cwd, "config"), cwd)).toBe(false);
	});
});

describe("a glob operand of a removing or moving command", () => {
	const ask = { ask: ["Write(config/prod.yaml)"], allow: ["Bash(rm:*)", "Bash(mv:*)", "Bash(shred:*)"] };
	const deny = { deny: ["Write(config/prod.yaml)"], allow: ["Bash(rm:*)", "Bash(mv:*)"] };

	it("is expanded against the disk, so a match an ask rule names is asked, a Bash allow rule and the sandbox notwithstanding", () => {
		for (const command of ["rm config/*.yaml", "rm -f config/prod.*", "rm --one-file-system config/*.yaml", "shred config/*.yaml", "mv config/*.yaml build/", "mv -b config/p* build/"]) {
			for (const mode of ["auto", "acceptEdits", "default"] as Mode[]) expect(run(ask, "bash", command, mode), `${command} ${mode}`).toBe("ask");
			expect(run(ask, "bash", command, "default", true, { sandboxed: true }), command).toBe("ask");
			expect(run(ask, "bash", command, "dontAsk"), command).toBe("deny");
		}
	});

	it("is refused when a match is a path a deny rule names, as the exact spelling is", () => {
		for (const command of ["rm config/*.yaml", "rm --one-file-system config/prod.*", "mv config/*.yaml build/"]) {
			for (const mode of MODES) expect(run(deny, "bash", command, mode), `${command} ${mode}`).toBe("deny");
			expect(run(deny, "bash", command, "default", true, { sandboxed: true }), command).toBe("deny");
		}
	});

	it("keeps today's result when every match is unrelated", () => {
		expect(run(ask, "bash", "rm config/d*.yaml", "default")).toBe("allow");
		expect(run(deny, "bash", "rm config/d*.yaml", "default", true, { sandboxed: true })).toBe("allow");
		expect(run(deny, "bash", "rm build/out/*.js", "default")).toBe("allow");
		// A glob that matches nothing names only itself.
		expect(run(deny, "bash", "rm config/*.toml", "default")).toBe("allow");
	});

	it("is a literal file name when quoted or escaped: it names that one file, not what the pattern would match", () => {
		const shell = (command: string) => analyzeShellCommand({ command, cwd, home: homedir() });
		for (const command of ["rm 'config/*.yaml'", 'rm "config/*.yaml"', "rm config/'*'.yaml", "rm config/\\*.yaml", "rm --one-file-system 'config/*.yaml'", "mv 'config/*.yaml' build/"]) {
			const evidence = shell(command);
			expect(evidence.globWrites, command).toEqual([]);
			expect(
				evidence.writes.map((write) => write.absolute),
				command,
			).toContain(join(cwd, "config", "*.yaml"));
			// Still escalated, as every name with glob characters was.
			expect(evidence.verdict, command).toBe("escalate");
			expect(run(deny, "bash", command, "default"), command).not.toBe("deny");
			expect(run(ask, "bash", command, "default"), command).not.toBe("ask");
		}
		// An unquoted glob character beside a quoted part still globs.
		for (const command of ["rm config/*'.yaml'", 'rm "config/"*.yaml']) {
			expect(shell(command).globWrites.map((glob) => glob.token), command).toEqual(["config/*.yaml"]);
			expect(run(deny, "bash", command, "default"), command).toBe("deny");
		}
	});

	it("withholds the allow, the fast path and the sandbox auto-allow when the matches cannot be enumerated, and refuses nothing", () => {
		for (const command of ["rm */prod.yaml", "rm config/.*", "mv c*/prod.yaml build/"]) {
			expect(run(ask, "bash", command, "default"), command).toBe("ask");
			expect(run(deny, "bash", command, "default"), command).toBe("ask");
			expect(run(deny, "bash", command, "acceptEdits"), command).toBe("ask");
			expect(run(deny, "bash", command, "auto"), command).toBe("classify");
			expect(run(deny, "bash", command, "default", true, { sandboxed: true }), command).toBe("ask");
			expect(run(deny, "bash", command, "dontAsk"), command).toBe("deny");
		}
		// With no edit-family rule nothing changes.
		expect(run({ allow: ["Bash(rm:*)"] }, "bash", "rm */prod.yaml", "default")).toBe("allow");
	});
});

// Claude Code reads `/x` against the project root (`//x` is its absolute form).
describe("a deny or ask rule written with a single leading slash", () => {
	it("names the path under the working directory for the file tools and the read tools", () => {
		for (const mode of MODES) {
			expect(run({ deny: ["Edit(/config/prod.yaml)"] }, "edit", prod, mode)).toBe("deny");
			expect(run({ deny: ["Edit(/config/prod.yaml)"] }, "write", prod, mode)).toBe("deny");
			expect(run({ deny: ["Read(/config/**)"] }, "read", prod, mode)).toBe("deny");
		}
		expect(run({ ask: ["Edit(/config/prod.yaml)"] }, "write", prod, "auto")).toBe("ask");
		expect(run({ ask: ["Read(/config/prod.yaml)"] }, "read", prod, "default")).toBe("ask");
		expect(run({ deny: ["Edit(/config/prod.yaml)"] }, "edit", dev, "auto")).toBe("allow");
	});

	it("names it for a shell line's write targets", () => {
		expect(run({ deny: ["Edit(/config/prod.yaml)"] }, "bash", "rm config/prod.yaml", "auto")).toBe("deny");
		expect(run({ ask: ["Write(/config/prod.yaml)"], allow: ["Bash(rm:*)"] }, "bash", "rm config/prod.yaml", "default")).toBe("ask");
		expect(run({ deny: ["Edit(/config/prod.yaml)"] }, "bash", "rm -r config", "acceptEdits")).toBe("ask");
		expect(run({ deny: ["Edit(/config/prod.yaml)"] }, "bash", "rm -r build", "acceptEdits")).toBe("allow");
		expect(writeTargetMeetsPathPattern("/config/prod.yaml", join(cwd, "config"), cwd)).toBe(true);
		expect(writeTargetMeetsPathPattern("/config/prod.yaml", join(cwd, "build"), cwd)).toBe(false);
	});

	it("keeps its absolute reading", () => {
		expect(matchesPathPattern("/config/prod.yaml", resolve("/config/prod.yaml"), cwd, true)).toBe(process.platform !== "win32");
		expect(matchesPathPattern("/config/prod.yaml", resolve("/config/prod.yaml"), cwd)).toBe(process.platform !== "win32");
	});

	it("leaves an allow rule with the absolute reading only", () => {
		expect(matchesPathPattern("/config/prod.yaml", prod, cwd)).toBe(false);
		expect(run({ allow: ["Edit(/config/prod.yaml)"] }, "edit", prod, "default")).toBe("ask");
		expect(run({ allow: ["Edit(config/prod.yaml)"] }, "edit", prod, "default")).toBe("allow");
	});
});

describe("an allow rule stays exact", () => {
	it("does not let an Edit allow cover a write", () => {
		const allow = { allow: ["Edit(config/**)"] };
		expect(run(allow, "edit", prod, "default")).toBe("allow");
		expect(run(allow, "write", prod, "default")).toBe("ask");
	});
});

describe("a shell line that writes a path such a rule names", () => {
	const deny = { deny: ["Edit(config/prod.yaml)"] };
	const SHELL_MODES: Mode[] = [...MODES, "plan"];

	it.each(["printf '' > config/prod.yaml", "rm config/prod.yaml", "cp /dev/null config/prod.yaml"])("%s is refused in every mode", (command) => {
		for (const mode of SHELL_MODES) expect(run(deny, "bash", command, mode)).toBe("deny");
		expect(run(deny, "bash", command, "default", true, { sandboxed: true })).toBe("deny");
		expect(run(deny, "monitor", command, "auto")).toBe("deny");
	});

	it("is refused even when a Bash allow rule matches the line, deny before allow as in Claude Code", () => {
		for (const mode of ["auto", "acceptEdits", "default", "dontAsk"] as Mode[]) {
			expect(run({ ...deny, allow: ["Bash(printf:*)"] }, "bash", "printf x > config/prod.yaml", mode)).toBe("deny");
			expect(run({ ...deny, allow: ["Bash(rm config/prod.yaml)"] }, "bash", "rm config/prod.yaml", mode)).toBe("deny");
		}
		expect(run({ ...deny, allow: ["Bash(printf:*)"] }, "bash", "printf x > config/dev.yaml", "default")).toBe("allow");
	});

	it("keeps an operand that starts with a dash after -- in a move the check does not model", () => {
		const writes = analyzeShellCommand({ command: "mv --backup=numbered -- -notes.md config/", cwd, home: homedir() }).writes.map((write) => write.token);
		expect(writes).toEqual(expect.arrayContaining(["-notes.md", "config/-notes.md"]));
		expect(run({ deny: ["Edit(config/-notes.md)"] }, "bash", "mv --backup=numbered -- -notes.md config/", "auto")).toBe("deny");
	});

	it("sees a bare-name destination behind options the copy check does not model", () => {
		const rule = { deny: ["Edit(notes.md)"] };
		for (const command of ["cp --sparse=always config/dev.yaml notes.md", "ln --backup=numbered config/dev.yaml notes.md", "install --mode=644 config/dev.yaml notes.md"]) {
			expect(analyzeShellCommand({ command, cwd, home: homedir() }).writes.map((write) => write.token), command).toContain("notes.md");
			expect(run(rule, "bash", command, "auto"), command).toBe("deny");
		}
	});

	it("sees the file an unmodelled move, copy, link or install puts into an existing directory", () => {
		const rule = { deny: ["Edit(build/dev.yaml)"] };
		const writes = (command: string) => analyzeShellCommand({ command, cwd, home: homedir() }).writes.map((write) => write.token);
		for (const command of [
			"mv --backup=numbered config/dev.yaml build/",
			"mv --backup=numbered config/dev.yaml build",
			"cp --sparse=always config/dev.yaml build",
			"ln --backup=numbered config/dev.yaml build/",
			"install --mode=644 config/dev.yaml build",
		]) {
			expect(writes(command), command).toContain("build/dev.yaml");
			expect(run(rule, "bash", command, "auto"), command).toBe("deny");
		}
		// A move still removes its source and names its destination.
		expect(writes("mv --backup=numbered config/dev.yaml build/")).toEqual(expect.arrayContaining(["config/dev.yaml", "build/", "build/dev.yaml"]));
		// A rename to a name that is not a directory writes that name only.
		expect(writes("mv --backup=numbered config/dev.yaml notes.md")).toEqual(["config/dev.yaml", "notes.md"]);
		// One operand: ln makes the link here, under the target's name.
		expect(writes("ln -s ../shared/notes.md")).toContain("notes.md");
		expect(run({ deny: ["Edit(notes.md)"] }, "bash", "ln -s ../shared/notes.md", "auto")).toBe("deny");
	});

	it("counts a move's source as a write, since the move removes it", () => {
		expect(analyzeShellCommand({ command: "mv config/prod.yaml config/old.yaml", cwd, home: homedir() }).writes.map((write) => write.token)).toEqual(["config/prod.yaml", "config/old.yaml"]);
		for (const command of ["mv config/prod.yaml config/old.yaml", "mv config/prod.yaml config/dev.yaml .", "mv -f config/prod.yaml config/old/"]) {
			for (const mode of SHELL_MODES) expect(run(deny, "bash", command, mode)).toBe("deny");
		}
		expect(run(deny, "bash", "mv config/dev.yaml config/old.yaml", "auto")).toBe("allow");
	});

	it("counts every operand of a move with options it does not model", () => {
		expect(run(deny, "bash", "mv --backup config/prod.yaml config/old.yaml", "default", true, { sandboxed: true })).toBe("deny");
		expect(run(deny, "bash", "mv -t config/old config/prod.yaml", "default", true, { sandboxed: true })).toBe("deny");
		expect(run(deny, "bash", "mv --backup config/dev.yaml config/old.yaml", "default", true, { sandboxed: true })).toBe("allow");
	});

	it("counts the file a -t or --target-directory option puts in its directory, in every spelling", () => {
		const ask = { ask: ["Write(config/prod.yaml)"], allow: ["Bash(mv:*)", "Bash(cp:*)", "Bash(install:*)", "Bash(ln:*)"] };
		const writes = (command: string) => analyzeShellCommand({ command, cwd, home: homedir() }).writes.map((write) => write.token);
		for (const command of ["mv -tconfig prod.yaml", "mv -t config prod.yaml", "mv -ft config prod.yaml", "mv -vtconfig/ prod.yaml", "mv --target-directory=config prod.yaml", "mv --target-directory config prod.yaml", "mv --target=config build/prod.yaml", "mv -t config -- prod.yaml"]) {
			expect(writes(command), command).toContain("config/prod.yaml");
			expect(run(ask, "bash", command, "default"), command).toBe("ask");
			expect(run(ask, "bash", command, "default", true, { sandboxed: true }), command).toBe("ask");
		}
		// A move still removes each source.
		expect(writes("mv -tconfig prod.yaml other.yaml")).toEqual(expect.arrayContaining(["prod.yaml", "other.yaml", "config/prod.yaml", "config/other.yaml"]));
		for (const command of ["cp -tconfig prod.yaml", "cp --target-directory=config build/prod.yaml", "install -m 644 -t config prod.yaml", "install -tconfig prod.yaml", "ln -s -t config ../prod.yaml"]) {
			expect(writes(command), command).toContain("config/prod.yaml");
			expect(run(ask, "bash", command, "default"), command).toBe("ask");
		}
		// The value of another option is not the directory: `-S t` is a backup suffix.
		expect(writes("mv -St config/dev.yaml build/")).not.toContain("config/dev.yaml/build");
		expect(run(ask, "bash", "mv -tconfig dev.yaml", "default")).toBe("allow");
		expect(run(ask, "bash", "cp -t config dev.yaml", "default")).toBe("allow");
	});

	it("keeps the fast path for a line that writes elsewhere", () => {
		expect(run(deny, "bash", "rm config/dev.yaml", "auto")).toBe("allow");
		expect(run(deny, "bash", "printf '' > config/dev.yaml", "acceptEdits")).toBe("allow");
		expect(run(deny, "bash", "rm config/dev.yaml", "default", true, { sandboxed: true })).toBe("allow");
	});

	it("is asked under an ask rule, a matching Bash allow rule and the sandbox auto-allow notwithstanding", () => {
		const ask = { ask: ["Write(config/prod.yaml)"] };
		for (const mode of ["auto", "acceptEdits", "default"] as Mode[]) {
			expect(run(ask, "bash", "rm config/prod.yaml", mode)).toBe("ask");
			expect(run({ ...ask, allow: ["Bash(rm:*)"] }, "bash", "rm config/prod.yaml", mode)).toBe("ask");
		}
		expect(run(ask, "bash", "rm config/prod.yaml", "default", true, { sandboxed: true })).toBe("ask");
		expect(run(ask, "bash", "rm config/prod.yaml", "dontAsk")).toBe("deny");
		expect(run({ ...ask, allow: ["Bash(rm:*)"] }, "bash", "rm config/dev.yaml", "default")).toBe("allow");
	});
});
