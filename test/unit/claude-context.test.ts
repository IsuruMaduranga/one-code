import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AGENTS_DESCRIPTOR,
	buildClaudeMdBlock,
	buildOneCodeBlock,
	discoverContextFilePaths,
	discoverContextFiles,
	discoverOneCodeFiles,
	expandImports,
	ONECODE_DESCRIPTOR,
	ONECODE_GLOBAL_DESCRIPTOR,
	PROJECT_DESCRIPTOR,
} from "../../extensions/lib/claude-context.ts";
import { wrapReminder } from "../../extensions/lib/reminders.ts";

describe("buildClaudeMdBlock", () => {
	it("assembles the block byte-for-byte per Claude Code's join rule", () => {
		const inner = buildClaudeMdBlock({
			contextFiles: [
				{
					path: "/g/CLAUDE.md",
					content: "Global rules.\n",
					descriptor: "user's private global instructions for all projects",
				},
				{
					path: "/p/CLAUDE.md",
					content: "Project rules.\n",
					descriptor: "project instructions, checked into the codebase",
				},
			],
			memoryIndex: { path: "/m/MEMORY.md", content: "# Memory index\n\n- entry\n" },
			email: "a@b.com",
			date: "2026-08-09",
		});

		// Exact bytes: preamble\n\n, sections joined by "\n" (raw content keeps its
		// trailing "\n", so inter-section gaps are "\n\n"), memory's own trailing
		// "\n" is the single "\n" before # userEmail, and a 6-space trailer.
		const expected = [
			"As you answer the user's questions, you can use the following context:",
			"# claudeMd",
			"Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.",
			"",
			"Contents of /g/CLAUDE.md (user's private global instructions for all projects):",
			"",
			"Global rules.",
			"",
			"Contents of /p/CLAUDE.md (project instructions, checked into the codebase):",
			"",
			"Project rules.",
			"",
			"Contents of /m/MEMORY.md (user's auto-memory, persists across conversations):",
			"",
			"# Memory index",
			"",
			"- entry",
			"# userEmail",
			"The user's email address is a@b.com.",
			"# currentDate",
			"Today's date is 2026-08-09.",
			"",
			"      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.",
		].join("\n");

		expect(inner).toBe(expected);
	});

	it("omits the memory section when the index is empty", () => {
		const inner = buildClaudeMdBlock({
			contextFiles: [
				{ path: "/p/CLAUDE.md", content: "Rules.\n", descriptor: "project instructions, checked into the codebase" },
			],
			memoryIndex: { path: "/m/MEMORY.md", content: "   \n" },
			email: "a@b.com",
			date: "2026-08-09",
		});
		expect(inner).not.toContain("MEMORY.md");
		expect(inner).toContain("Contents of /p/CLAUDE.md");
	});

	it("returns null when there is nothing to inject", () => {
		expect(buildClaudeMdBlock({ contextFiles: [], memoryIndex: null, email: null, date: "2026-08-09" })).toBeNull();
	});
});

describe("expandImports (@path expansion)", () => {
	const home = "/home/u";
	// Virtual filesystem so tests never touch disk.
	const vfs = (files: Record<string, string>) => (p: string) => (p in files ? files[p] : null);

	it("inlines a referenced file at the @token's position", () => {
		const read = vfs({ "/p/AGENTS.md": "AGENT RULES\n" });
		expect(expandImports("before @AGENTS.md after", "/p", { home, read })).toBe("before AGENT RULES\n after");
	});

	it("leaves the literal @token when nothing resolves", () => {
		expect(expandImports("see @missing.md here", "/p", { home, read: vfs({}) })).toBe("see @missing.md here");
	});

	it("does not treat a non-whitespace-anchored @ (an email) as an import", () => {
		const read = vfs({ "/p/b.com": "OOPS" });
		expect(expandImports("mail a@b.com now", "/p", { home, read })).toBe("mail a@b.com now");
	});

	it("expands recursively, resolving relative to each importing file's dir", () => {
		const read = vfs({ "/p/a.md": "A @b.md", "/p/b.md": "B" });
		expect(expandImports("@a.md", "/p", { home, read })).toBe("A B");
	});

	it("stops after the max import depth without inlining deeper hops", () => {
		const read = vfs({
			"/p/f1.md": "@f2.md",
			"/p/f2.md": "@f3.md",
			"/p/f3.md": "@f4.md",
			"/p/f4.md": "@f5.md",
			"/p/f5.md": "@f6.md",
			"/p/f6.md": "DEEP",
		});
		// Six hops deep; the cutoff leaves the deepest reference literal, never DEEP.
		expect(expandImports("@f1.md", "/p", { home, read })).toBe("@f6.md");
	});

	it("does not loop on a self-referential import", () => {
		const read = vfs({ "/p/a.md": "A @a.md Z" });
		expect(expandImports("@a.md", "/p", { home, read })).toBe("A @a.md Z");
	});

	it("ignores @tokens inside inline-code spans and fenced code blocks", () => {
		const read = vfs({ "/p/x.md": "X" });
		expect(expandImports("use `@x.md` inline", "/p", { home, read })).toBe("use `@x.md` inline");
		const fenced = "```\n@x.md\n```";
		expect(expandImports(fenced, "/p", { home, read })).toBe(fenced);
	});

	it("re-appends trailing sentence punctuation after the inlined content", () => {
		const read = vfs({ "/p/x.md": "X" });
		expect(expandImports("see @x.md.", "/p", { home, read })).toBe("see X.");
	});

	it("resolves ~ to home and absolute paths as-is", () => {
		const read = vfs({ "/home/u/g.md": "G", "/abs/x.md": "X" });
		expect(expandImports("@~/g.md and @/abs/x.md", "/p", { home, read })).toBe("G and X");
	});
});

describe("ONECODE.md discovery", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "onecode-ctx-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const write = (rel: string, content: string) => {
		const abs = join(root, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
		return abs;
	};

	it("places global then per-directory ONECODE.md after the matching CLAUDE.md", () => {
		const homeClaude = join(root, "home-claude");
		const homeOneCode = join(root, "home-onecode");
		const gClaude = write("home-claude/CLAUDE.md", "g\n");
		const gOneCode = write("home-onecode/ONECODE.md", "go\n");
		const pClaude = write("proj/CLAUDE.md", "p\n");
		const pOneCode = write("proj/ONECODE.md", "po\n");
		mkdirSync(join(root, "proj", "sub"), { recursive: true });

		const paths = discoverContextFilePaths({
			cwd: join(root, "proj", "sub"),
			homeClaudeDir: homeClaude,
			homeOneCodeDir: homeOneCode,
		});

		expect(paths).toEqual([
			expect.objectContaining({ path: gClaude }),
			{ path: gOneCode, descriptor: ONECODE_GLOBAL_DESCRIPTOR },
			expect.objectContaining({ path: pClaude }),
			{ path: pOneCode, descriptor: ONECODE_DESCRIPTOR },
		]);
	});

	it("omits ONECODE.md entirely when homeOneCodeDir is not passed (the memory picker path)", () => {
		write("home-claude/CLAUDE.md", "g\n");
		write("proj/ONECODE.md", "po\n");
		const paths = discoverContextFilePaths({
			cwd: join(root, "proj"),
			homeClaudeDir: join(root, "home-claude"),
		});
		expect(paths.some((p) => p.path.includes("ONECODE"))).toBe(false);
	});

	it("falls back to AGENTS.md only when a directory has no CLAUDE.md (agentsFallback)", () => {
		mkdirSync(join(root, "proj", "sub"), { recursive: true });
		// Ancestor has CLAUDE.md (its AGENTS.md must be ignored); cwd has only AGENTS.md.
		const ancestorClaude = write("proj/CLAUDE.md", "c\n");
		write("proj/AGENTS.md", "ignored\n");
		const cwdAgents = write("proj/sub/AGENTS.md", "used\n");
		const paths = discoverContextFilePaths({
			cwd: join(root, "proj", "sub"),
			homeClaudeDir: join(root, "home-claude"),
			agentsFallback: true,
		});
		const projectPaths = paths.filter((p) => p.path.startsWith(join(root, "proj")));
		expect(projectPaths).toEqual([
			{ path: ancestorClaude, descriptor: PROJECT_DESCRIPTOR },
			{ path: cwdAgents, descriptor: AGENTS_DESCRIPTOR },
		]);
	});

	it("never lists AGENTS.md without agentsFallback set", () => {
		mkdirSync(join(root, "proj"), { recursive: true });
		write("proj/AGENTS.md", "a\n");
		const paths = discoverContextFilePaths({ cwd: join(root, "proj"), homeClaudeDir: join(root, "home-claude") });
		expect(paths.some((p) => p.path.endsWith("AGENTS.md"))).toBe(false);
	});

	it("accepts lowercase onecode.md as a filename variant", () => {
		const p = write("proj/onecode.md", "po\n");
		const paths = discoverContextFilePaths({
			cwd: join(root, "proj"),
			homeClaudeDir: join(root, "home-claude"),
			homeOneCodeDir: join(root, "home-onecode"),
		});
		expect(paths).toContainEqual({ path: p, descriptor: ONECODE_DESCRIPTOR });
	});

	it("expands @imports in a discovered file's content (the @AGENTS.md reuse case)", () => {
		write("proj/CLAUDE.md", "@AGENTS.md\n");
		write("proj/AGENTS.md", "AGENT RULES\n");
		const files = discoverContextFiles({
			cwd: join(root, "proj"),
			homeClaudeDir: join(root, "home-claude"),
			homeOneCodeDir: join(root, "home-onecode"),
			home: root,
		});
		const claudeMd = files.find((f) => f.path.endsWith("CLAUDE.md"));
		expect(claudeMd?.content).toBe("AGENT RULES\n\n");
	});
});

describe("the # oneCodeMd block", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "onecode-block-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});
	const write = (rel: string, content: string) => {
		const abs = join(root, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
		return abs;
	};

	it("is null when there are no ONECODE.md files (nothing extra rides)", () => {
		mkdirSync(join(root, "proj"), { recursive: true });
		const files = discoverOneCodeFiles({ cwd: join(root, "proj"), homeOneCodeDir: join(root, ".one-code"), home: root });
		expect(buildOneCodeBlock(files)).toBeNull();
	});

	it("carries the ONECODE files under a precedence-over-CLAUDE.md preamble, nearer last", () => {
		const globalOne = write(".one-code/ONECODE.md", "global one-code\n");
		mkdirSync(join(root, "proj", "sub"), { recursive: true });
		const projOne = write("proj/ONECODE.md", "project one-code\n");
		const files = discoverOneCodeFiles({
			cwd: join(root, "proj", "sub"),
			homeOneCodeDir: join(root, ".one-code"),
			home: root,
		});
		const block = buildOneCodeBlock(files);
		expect(block).toBeTruthy();
		const text = block as string;
		expect(text).toContain("# oneCodeMd");
		expect(text).toContain("take precedence over the CLAUDE.md instructions");
		// Global first, project (nearer) after it.
		expect(text.indexOf(globalOne)).toBeLessThan(text.indexOf(projOne));
		expect(text).toContain("global one-code");
		expect(text).toContain("project one-code");
		expect(text).toContain(ONECODE_GLOBAL_DESCRIPTOR);
		expect(text).toContain(ONECODE_DESCRIPTOR);
	});

	it("expands @imports inside an ONECODE.md file", () => {
		write(".one-code/ignore", "x");
		mkdirSync(join(root, "proj"), { recursive: true });
		write("proj/ONECODE.md", "@snippet.md\n");
		write("proj/snippet.md", "SNIPPET BODY\n");
		const files = discoverOneCodeFiles({ cwd: join(root, "proj"), homeOneCodeDir: join(root, ".one-code"), home: root });
		expect(buildOneCodeBlock(files)).toContain("SNIPPET BODY");
	});
});

// Real-capture validation: our preamble/trailer constants and email/date framing
// must match the wire bytes. Skips gracefully where the capture isn't present
// (it is an internal-only file, absent from the public repo / CI).
describe("against opus-4-8.json capture", () => {
	const capturePath = fileURLToPath(new URL("../../opus-4-8.json", import.meta.url));
	const run = existsSync(capturePath) ? it : it.skip;

	run("the claudeMd block starts/ends exactly as we assemble it", () => {
		const payload = JSON.parse(readFileSync(capturePath, "utf8"));
		const block: string = payload.messages[0].content
			.map((b: { text?: string }) => b.text ?? "")
			.find((t: string) => t.startsWith("<system-reminder>") && t.includes("# claudeMd"));
		expect(block).toBeTruthy();

		// Same wrapper the injector adds, plus Claude Code's `\n\n` suffix on this block.
		expect(block.startsWith("<system-reminder>\n")).toBe(true);
		expect(block.endsWith("\n</system-reminder>\n\n")).toBe(true);

		const inner = block.slice("<system-reminder>\n".length, block.length - "\n</system-reminder>\n\n".length);
		expect(
			inner.startsWith(
				"As you answer the user's questions, you can use the following context:\n# claudeMd\nCodebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n",
			),
		).toBe(true);
		expect(inner).toMatch(
			/\n\n {6}IMPORTANT: this context may or may not be relevant to your tasks\. You should not respond to this context unless it is highly relevant to your task\.$/,
		);
		expect(inner).toMatch(/\n# userEmail\nThe user's email address is .+\.\n# currentDate\nToday's date is \d{4}-\d{2}-\d{2}\.\n/);

		// A round-trip: our wrapper + suffix reproduces the exact wire block.
		expect(wrapReminder(inner) + "\n\n").toBe(block);
	});
});
