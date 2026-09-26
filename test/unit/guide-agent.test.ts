/**
 * The `one-code-guide` agent (subagents/guide-agent.ts) and the read-only docs
 * roots it depends on (permissions/matcher.ts `readOnlyDirs`).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { guideDocsDirs, ONE_CODE_GUIDE_DIR } from "../../extensions/lib/guide-docs.ts";
import { forwardSlashes } from "../../extensions/lib/paths.ts";
import { decide } from "../../extensions/permissions/matcher.ts";
import { discoverAgents } from "../../extensions/subagents/agents.ts";
import { GUIDE_AGENT, guideAgentDefinition, guideSystemPrompt, type GuideInput, settingsSetup } from "../../extensions/subagents/guide-agent.ts";

const emptySetup = { skills: [], agents: [], plugins: [], mcpServers: [], packages: [], extensions: [], settingsKeys: [] };
const input = (over: Partial<GuideInput> = {}): GuideInput => ({
	docs: { guide: "/pkg/docs/guide", piDocs: "/pi/docs", piExamples: "/pi/examples" },
	install: { shape: "app", method: "npm", agentDir: "/home/u/.onecode/agent", version: "0.4.1" },
	setup: emptySetup,
	...over,
});

describe("guideAgentDefinition", () => {
	it("is a read-only agent on the session's subagent model", () => {
		const agent = guideAgentDefinition(() => input());
		expect(agent.name).toBe(GUIDE_AGENT);
		expect(agent.model).toBeUndefined();
		expect(agent.tools).toEqual(["bash", "read", "web_fetch", "web_search"]);
		expect(agent.description).toContain("continue via SendMessage");
	});
});

describe("guideAgentDefinition's prompt", () => {
	it("is built on first read only, and once", () => {
		let built = 0;
		const agent = guideAgentDefinition(() => {
			built++;
			return input();
		});
		expect(built).toBe(0);
		expect(agent.systemPrompt).toContain("Never answer from memory");
		expect(agent.systemPrompt).toContain("Never answer from memory");
		expect(built).toBe(1);
	});
});

describe("discoverAgents with a code-defined agent", () => {
	it("ranks it below agent files, without reading its prompt", () => {
		const root = mkdtempSync(join(tmpdir(), "guide-agents-"));
		try {
			let built = 0;
			const guide = guideAgentDefinition(() => {
				built++;
				return input();
			});
			expect(discoverAgents([{ agents: [guide] }, root]).map((agent) => agent.source)).toEqual(["built-in"]);
			writeFileSync(join(root, "one-code-guide.md"), "---\nname: one-code-guide\ndescription: mine\n---\nMy own guide.\n");
			const [mine] = discoverAgents([{ agents: [guide] }, root]);
			expect(mine?.systemPrompt).toBe("My own guide.");
			expect(built).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("guideSystemPrompt", () => {
	it("points at the docs on this machine and forbids answering from memory", () => {
		const prompt = guideSystemPrompt(input());
		expect(prompt).toContain("`/pkg/docs/guide`");
		expect(prompt).toContain("`/pi/docs`");
		expect(prompt).toContain("`/pi/examples`");
		expect(prompt).toContain("Never answer from memory");
	});

	it("names the install routes for the bundled app", () => {
		const prompt = guideSystemPrompt(input());
		expect(prompt).toContain("bundled One Code app (`onecode` 0.4.1, installed with npm)");
		expect(prompt).toContain("`onecode install <source>`");
		expect(prompt).toContain("`/home/u/.onecode/agent/extensions/`");
	});

	it("names pi's own commands when One Code runs on the user's pi", () => {
		const prompt = guideSystemPrompt(input({ install: { shape: "extension", agentDir: "/home/u/.pi/agent" } }));
		expect(prompt).toContain("extension on the user's own pi installation");
		expect(prompt).toContain("`pi install <source>`");
		expect(prompt).not.toContain("onecode install");
		expect(prompt).toContain("`/home/u/.pi/agent/extensions/`");
	});

	it("falls back to the published pi docs when the local copy is missing", () => {
		expect(guideSystemPrompt(input({ docs: { guide: "/g" } }))).toContain("https://pi.dev/docs/latest");
	});

	it("lists the user's setup only when there is one", () => {
		expect(guideSystemPrompt(input())).not.toContain("User's Current Configuration");
		const prompt = guideSystemPrompt(input({ setup: { ...emptySetup, skills: ["deploy"], mcpServers: ["github"], packages: ["npm:pi-foo"] } }));
		expect(prompt).toContain("# User's Current Configuration");
		expect(prompt).toContain("**Custom skills:** deploy");
		expect(prompt).toContain("**Configured MCP servers:** github");
		expect(prompt).toContain("**Installed pi packages:** npm:pi-foo");
		expect(prompt).not.toContain("Custom agents");
	});
});

describe("settingsSetup", () => {
	it("lists the user's packages without One Code's own entry, and every key", () => {
		const raw = JSON.stringify({
			theme: "onecode",
			packages: ["/lib/node_modules/@one-ai/one-code/node_modules/one-code-extension", "npm:one-code-extension@0.4.1", "/self", { source: "git:github.com/x/pi-tools" }, "../my-ext"],
		});
		expect(settingsSetup(raw, "/self")).toEqual({ packages: ["git:github.com/x/pi-tools", "../my-ext"], settingsKeys: ["packages", "theme"] });
	});

	it("gives nothing for a missing or unreadable file", () => {
		expect(settingsSetup(undefined, "/self")).toEqual({ packages: [], settingsKeys: [] });
		expect(settingsSetup("{not json", "/self")).toEqual({ packages: [], settingsKeys: [] });
		expect(settingsSetup("[1]", "/self")).toEqual({ packages: [], settingsKeys: [] });
	});
});

describe("guideDocsDirs", () => {
	it("includes the user guide shipped in this package", () => {
		expect(guideDocsDirs()).toContain(ONE_CODE_GUIDE_DIR);
	});
});

describe("decide() with read-only docs dirs", () => {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "guide-docs-")));
	const cwd = join(root, "project");
	const docs = join(root, "docs");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(docs, { recursive: true });
	writeFileSync(join(docs, "page.md"), "page");
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const at = (toolName: string, mode: "default" | "acceptEdits" | "auto", resolvedSubject = join(docs, "page.md")) =>
		decide({ toolName, subject: join(docs, "page.md"), cwd, mode, deny: [], ask: [], allow: [], resolvedSubject, readOnlyDirs: [docs] });

	it("allows reads there in every mode", () => {
		for (const mode of ["default", "acceptEdits", "auto"] as const) {
			expect(at("read", mode).decision).toBe("allow");
			expect(at("grep", mode).decision).toBe("allow");
		}
	});

	it("never allows writes there", () => {
		expect(at("write", "acceptEdits").decision).toBe("ask");
		expect(at("edit", "default").decision).toBe("ask");
		expect(at("write", "auto").decision).toBe("classify");
	});

	it("lets plan mode's read-only shell search there", () => {
		const grep = `grep -r page ${forwardSlashes(docs)}`;
		expect(decide({ toolName: "bash", subject: grep, cwd, mode: "plan", deny: [], ask: [], allow: [], readOnlyDirs: [docs] }).decision).toBe("allow");
		expect(decide({ toolName: "bash", subject: grep, cwd, mode: "plan", deny: [], ask: [], allow: [] }).decision).not.toBe("allow");
	});

	it("stays readable with blockReadsOutsideWorkingDirectories on", () => {
		const read = (readOnlyDirs: string[]) =>
			decide({ toolName: "read", subject: join(docs, "page.md"), cwd, mode: "default", deny: [], ask: [], allow: [], resolvedSubject: join(docs, "page.md"), readOnlyDirs, blockReadsOutsideWorkingDirectories: true }).decision;
		expect(read([docs])).toBe("allow");
		expect(read([])).toBe("deny");
	});

	it("lets a read-only shell search there in manual mode", () => {
		const grep = `grep -r page ${forwardSlashes(docs)}`;
		expect(decide({ toolName: "bash", subject: grep, cwd, mode: "default", deny: [], ask: [], allow: [], readOnlyDirs: [docs] }).decision).toBe("allow");
		expect(decide({ toolName: "bash", subject: `echo x > ${forwardSlashes(join(docs, "page.md"))}`, cwd, mode: "default", deny: [], ask: [], allow: [], readOnlyDirs: [docs] }).decision).not.toBe("allow");
	});

	it("judges a symlink by where it resolves", () => {
		expect(at("read", "default", join(root, "elsewhere", "secret")).decision).toBe("ask");
	});
});
