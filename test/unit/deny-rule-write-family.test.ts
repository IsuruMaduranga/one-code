/**
 * A deny or ask rule with a path on one file-writing tool binds the other two
 * for that path, and a shell line that writes the path takes no fast path.
 * Allow rules stay exact.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decide, parseRules } from "../../extensions/lib/rules/matcher.ts";
import { useShippedProfileWithAllTools } from "./helpers/profile.ts";

useShippedProfileWithAllTools();
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "write-family-")));
mkdirSync(join(cwd, "config"));
writeFileSync(join(cwd, "config", "prod.yaml"), "x: 1\n");
writeFileSync(join(cwd, "config", "dev.yaml"), "x: 1\n");
writeFileSync(join(cwd, "nb.ipynb"), "{}");
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
