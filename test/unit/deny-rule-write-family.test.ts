/**
 * A deny or ask rule with a path on one file-writing tool binds the other two
 * for that path, and a shell line that writes the path takes no fast path.
 * Allow rules stay exact.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decide, parseRules, writeTargetMeetsPathPattern } from "../../extensions/lib/rules/matcher.ts";
import { analyzeShellCommand } from "../../extensions/lib/shell/shell-analysis.ts";
import { useShippedProfileWithAllTools } from "./helpers/profile.ts";

useShippedProfileWithAllTools();
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "write-family-")));
mkdirSync(join(cwd, "config"));
writeFileSync(join(cwd, "config", "prod.yaml"), "x: 1\n");
writeFileSync(join(cwd, "config", "dev.yaml"), "x: 1\n");
writeFileSync(join(cwd, "nb.ipynb"), "{}");
mkdirSync(join(cwd, "build", "out"), { recursive: true });
writeFileSync(join(cwd, "build", "out", "a.js"), "");
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

type Mode = "auto" | "acceptEdits" | "default" | "bypassPermissions" | "dontAsk";
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

	it("leaves another path, a reading tool and a pathless rule alone", () => {
		expect(run(deny, "write", dev, "auto")).toBe("allow");
		expect(run(deny, "read", prod, "default")).toBe("allow");
		// A bare `Edit` rule names the tool, not a path: it binds edit only.
		expect(run({ deny: ["Edit"] }, "write", dev, "auto")).toBe("allow");
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

describe("an allow rule stays exact", () => {
	it("does not let an Edit allow cover a write", () => {
		const allow = { allow: ["Edit(config/**)"] };
		expect(run(allow, "edit", prod, "default")).toBe("allow");
		expect(run(allow, "write", prod, "default")).toBe("ask");
	});
});

describe("a shell line that writes a path such a rule names", () => {
	const deny = { deny: ["Edit(config/prod.yaml)"] };

	it.each(["printf '' > config/prod.yaml", "rm config/prod.yaml", "cp /dev/null config/prod.yaml"])("%s takes no fast path", (command) => {
		expect(run(deny, "bash", command, "auto")).toBe("classify");
		expect(run(deny, "bash", command, "acceptEdits")).toBe("ask");
		expect(run(deny, "bash", command, "dontAsk")).toBe("deny");
	});

	it("counts a move's source as a write, since the move removes it", () => {
		expect(analyzeShellCommand({ command: "mv config/prod.yaml config/old.yaml", cwd, home: homedir() }).writes.map((write) => write.token)).toEqual(["config/prod.yaml", "config/old.yaml"]);
		for (const command of ["mv config/prod.yaml config/old.yaml", "mv config/prod.yaml config/dev.yaml .", "mv -f config/prod.yaml config/old/"]) {
			expect(run(deny, "bash", command, "auto")).toBe("classify");
			expect(run(deny, "bash", command, "acceptEdits")).toBe("ask");
			expect(run(deny, "bash", command, "dontAsk")).toBe("deny");
		}
		expect(run(deny, "bash", "mv config/dev.yaml config/old.yaml", "auto")).toBe("allow");
	});

	it("counts every operand of a move with options it does not model, for the sandbox auto-allow", () => {
		expect(run(deny, "bash", "mv --backup config/prod.yaml config/old.yaml", "default", true, { sandboxed: true })).toBe("ask");
		expect(run(deny, "bash", "mv -t config/old config/prod.yaml", "default", true, { sandboxed: true })).toBe("ask");
		expect(run(deny, "bash", "mv --backup config/dev.yaml config/old.yaml", "default", true, { sandboxed: true })).toBe("allow");
	});

	it("keeps the fast path for a line that writes elsewhere", () => {
		expect(run(deny, "bash", "rm config/dev.yaml", "auto")).toBe("allow");
		expect(run(deny, "bash", "printf '' > config/dev.yaml", "acceptEdits")).toBe("allow");
	});

	it("is not cleared by the sandbox auto-allow, and an ask rule withholds the fast path too", () => {
		expect(run(deny, "bash", "rm config/prod.yaml", "default", true, { sandboxed: true })).toBe("ask");
		expect(run(deny, "bash", "rm config/dev.yaml", "default", true, { sandboxed: true })).toBe("allow");
		expect(run({ ask: ["Write(config/prod.yaml)"] }, "bash", "rm config/prod.yaml", "acceptEdits")).toBe("ask");
	});
});
