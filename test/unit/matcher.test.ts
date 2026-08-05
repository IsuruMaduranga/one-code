import { describe, expect, it } from "vitest";
import {
	decide,
	extractSubject,
	matchesBashPattern,
	matchesPathPattern,
	normalizeToolName,
	parseRule,
	parseRules,
	ruleMatches,
} from "../../extensions/permissions/matcher.ts";

const CWD = "/home/user/project";

describe("normalizeToolName", () => {
	it("maps Claude Code PascalCase names to pi names", () => {
		expect(normalizeToolName("Bash")).toBe("bash");
		expect(normalizeToolName("Glob")).toBe("find");
		expect(normalizeToolName("NotebookEdit")).toBe("notebook_edit");
		expect(normalizeToolName("WebFetch")).toBe("web_fetch");
		expect(normalizeToolName("Task")).toBe("agent");
	});

	it("leaves mcp__ names verbatim and lowercases unknowns", () => {
		expect(normalizeToolName("mcp__GitHub__get_issue")).toBe("mcp__GitHub__get_issue");
		expect(normalizeToolName("SomeCustom")).toBe("somecustom");
	});
});

describe("parseRule", () => {
	it("parses bare tool and Tool(pattern) forms", () => {
		expect(parseRule("Bash")).toEqual({ raw: "Bash", tool: "bash", pattern: undefined });
		expect(parseRule("Bash(npm run test:*)")).toEqual({
			raw: "Bash(npm run test:*)",
			tool: "bash",
			pattern: "npm run test:*",
		});
		expect(parseRule("Edit(docs/**)")).toMatchObject({ tool: "edit", pattern: "docs/**" });
	});

	it("rejects malformed rules", () => {
		expect(parseRule("")).toBeUndefined();
		expect(parseRule("Bash(unclosed")).toBeUndefined();
		expect(parseRules(["Bash", "", "Read(~/x)"])).toHaveLength(2);
	});
});

describe("matchesBashPattern", () => {
	it("matches exact commands", () => {
		expect(matchesBashPattern("npm run build", "npm run build")).toBe(true);
		expect(matchesBashPattern("npm run build", "npm run build --watch")).toBe(false);
	});

	it("matches prefix rules with trailing :*", () => {
		expect(matchesBashPattern("npm run test:*", "npm run test")).toBe(true);
		expect(matchesBashPattern("npm run test:*", "npm run test:unit")).toBe(true);
		expect(matchesBashPattern("npm run test:*", "npm run test -- --grep x")).toBe(true);
		expect(matchesBashPattern("git commit:*", "git push")).toBe(false);
	});

	it("supports glob wildcards elsewhere", () => {
		expect(matchesBashPattern("git * --dry-run", "git push --dry-run")).toBe(true);
	});
});

describe("matchesPathPattern", () => {
	it("matches relative and absolute forms", () => {
		expect(matchesPathPattern("docs/**", "docs/api/readme.md", CWD)).toBe(true);
		expect(matchesPathPattern("docs/**", `${CWD}/docs/api/readme.md`, CWD)).toBe(true);
		expect(matchesPathPattern("docs/*", "docs/a/b.md", CWD)).toBe(false);
	});

	it("expands ~ in patterns", () => {
		const home = process.env.HOME ?? "";
		expect(matchesPathPattern("~/secrets/*", `${home}/secrets/key.pem`, CWD)).toBe(true);
	});
});

describe("ruleMatches + extractSubject", () => {
	it("extracts bash command and file paths", () => {
		expect(extractSubject("bash", { command: "ls -la" })).toBe("ls -la");
		expect(extractSubject("edit", { path: "src/a.ts" })).toBe("src/a.ts");
	});

	it("bare rule matches any call of that tool", () => {
		const rule = parseRule("Bash")!;
		expect(ruleMatches(rule, "bash", "anything at all", CWD)).toBe(true);
		expect(ruleMatches(rule, "read", "x", CWD)).toBe(false);
	});
});

describe("decide", () => {
	const rules = (raws: string[]) => parseRules(raws);
	const base = { subject: "", cwd: CWD, mode: "default" as const, deny: [], ask: [], allow: [] };

	it("auto-allows read-only tools by default", () => {
		expect(decide({ ...base, toolName: "read", subject: "x" }).decision).toBe("allow");
		expect(decide({ ...base, toolName: "grep", subject: "y" }).decision).toBe("allow");
	});

	it("asks for bash and edits by default", () => {
		expect(decide({ ...base, toolName: "bash", subject: "ls" }).decision).toBe("ask");
		expect(decide({ ...base, toolName: "write", subject: "a.ts" }).decision).toBe("ask");
	});

	it("deny rules beat everything, even bypass mode", () => {
		const d = decide({
			...base,
			mode: "bypassPermissions",
			toolName: "bash",
			subject: "rm -rf /",
			deny: rules(["Bash(rm -rf:*)"]),
		});
		expect(d.decision).toBe("deny");
		expect(d.cause).toBe("rule");
	});

	it("bypass mode allows everything not denied", () => {
		expect(decide({ ...base, mode: "bypassPermissions", toolName: "bash", subject: "ls" }).decision).toBe("allow");
	});

	it("plan mode denies non-safe tools", () => {
		const d = decide({ ...base, mode: "plan", toolName: "write", subject: "a.ts" });
		expect(d.decision).toBe("deny");
		expect(d.cause).toBe("plan-mode");
		expect(decide({ ...base, mode: "plan", toolName: "read", subject: "a.ts" }).decision).toBe("allow");
	});

	it("acceptEdits allows edit-tier but still asks for bash", () => {
		expect(decide({ ...base, mode: "acceptEdits", toolName: "edit", subject: "a.ts" }).decision).toBe("allow");
		expect(decide({ ...base, mode: "acceptEdits", toolName: "bash", subject: "ls" }).decision).toBe("ask");
	});

	it("allow rules allow, ask rules force prompting even when allowed", () => {
		expect(
			decide({ ...base, toolName: "bash", subject: "npm test", allow: rules(["Bash(npm test:*)"]) }).decision,
		).toBe("allow");
		const d = decide({
			...base,
			toolName: "bash",
			subject: "git push",
			ask: rules(["Bash(git push:*)"]),
			allow: rules(["Bash"]),
		});
		expect(d.decision).toBe("ask");
	});

	it("asks for unknown custom tools by default, allows safe-listed ones", () => {
		expect(decide({ ...base, toolName: "mystery_tool" }).decision).toBe("ask");
		expect(decide({ ...base, toolName: "todo_write" }).decision).toBe("allow");
	});
});
