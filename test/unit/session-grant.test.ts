/**
 * What "Yes, and don't ask again this session" mints (PERMISSIONS-REVIEW-2026-09-05
 * M2): a scoped rule whose label names the scope — never a bare tool grant that
 * turns one approved write into every write on disk.
 */
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { toPosixPath } from "../../extensions/lib/paths.ts";
import { decide } from "../../extensions/permissions/matcher.ts";
import { sessionGrant } from "../../extensions/permissions/session-grant.ts";

const CWD = "/home/user/project";
const HOME = "/home/user";
const base = { cwd: CWD, mode: "default" as const, cause: "tier", home: HOME };

describe("sessionGrant", () => {
	it("mints an exact-literal command rule for bash and monitor, never a glob", () => {
		const bash = sessionGrant({ ...base, toolName: "bash", subject: "ls *.ts" })!;
		expect(bash.rule.raw).toBe("bash(ls \\*.ts)");
		expect(bash.label).toBe("Yes, and don't ask again for this exact command this session");
		expect(decide({ ...base, toolName: "bash", subject: "ls *.ts", deny: [], ask: [], allow: [bash.rule] }).decision).toBe("allow");
		expect(decide({ ...base, toolName: "bash", subject: "ls ; rm -rf ~ #.ts", deny: [], ask: [], allow: [bash.rule] }).decision).toBe("ask");

		const monitor = sessionGrant({ ...base, toolName: "monitor", subject: "tail -f app.log" })!;
		expect(monitor.rule.raw).toBe("monitor(tail -f app.log)");
	});

	it("scopes an in-project write to the working directory (Claude Code's 'allow all edits this session')", () => {
		const grant = sessionGrant({ ...base, toolName: "write", subject: "src/a.ts" })!;
		// Claude Code's `//absolute` form — on Windows in its POSIX spelling (`//d/home/…`).
		expect(grant.rule.raw).toBe(`write(/${toPosixPath(resolve(CWD))}/**)`);
		expect(grant.label).toBe("Yes, and allow write anywhere in the working directory this session");
		const allow = [grant.rule];
		expect(decide({ ...base, toolName: "write", subject: "docs/b.md", deny: [], ask: [], allow }).decision).toBe("allow");
		// The grant stops at the project: an outside write still asks.
		const outside = decide({ ...base, toolName: "write", subject: "/home/user/other/c.txt", deny: [], ask: [], allow, cause: undefined } as never);
		expect(outside.decision).toBe("ask");
		// And never a different writing tool.
		expect(decide({ ...base, toolName: "edit", subject: "docs/b.md", deny: [], ask: [], allow }).decision).toBe("ask");
	});

	it("scopes an outside-cwd path to that file's directory and names it with ~", () => {
		const grant = sessionGrant({ ...base, toolName: "read", subject: "~/notes/private.txt", cause: "working-dir" })!;
		expect(grant.rule.raw).toBe(`read(/${toPosixPath(dirname(resolve(HOME, "notes/private.txt")))}/**)`);
		expect(grant.label).toBe("Yes, and allow read under ~/notes this session");
		const allow = [grant.rule];
		expect(decide({ ...base, toolName: "read", subject: "/home/user/notes/other.txt", deny: [], ask: [], allow }).decision).toBe("allow");
		expect(decide({ ...base, toolName: "read", subject: "/home/user/.ssh/id_rsa", deny: [], ask: [], allow }).decision).toBe("ask");
	});

	it("scopes web_fetch to the URL's host, as Claude Code's WebFetch(domain:…) does", () => {
		const grant = sessionGrant({ ...base, toolName: "web_fetch", subject: "https://Example.com/docs/a?x=1" })!;
		expect(grant.rule.raw).toBe("web_fetch(domain:example.com)");
		expect(grant.label).toBe("Yes, and don't ask again for example.com this session");
		const allow = [grant.rule];
		expect(decide({ ...base, toolName: "web_fetch", subject: "https://example.com/other", deny: [], ask: [], allow }).decision).toBe("allow");
		expect(decide({ ...base, toolName: "web_fetch", subject: "https://evil.example.net/", deny: [], ask: [], allow }).decision).toBe("ask");
		expect(sessionGrant({ ...base, toolName: "web_fetch", subject: "" })).toBeUndefined();
	});

	it("mints a bare tool rule for text-subject tools (MCP, web_search) and says so", () => {
		const grant = sessionGrant({ ...base, toolName: "mcp__github__get_issue", subject: '{"issue":1}' })!;
		expect(grant.rule.raw).toBe("mcp__github__get_issue");
		expect(grant.label).toBe("Yes, and don't ask again for mcp__github__get_issue this session");
	});

	it("offers no grant where a rule could not or must not apply", () => {
		// Protected paths and the safety floor are judged before allow rules.
		expect(sessionGrant({ ...base, toolName: "write", subject: ".git/hooks/pre-commit", cause: "protected-path" })).toBeUndefined();
		expect(sessionGrant({ ...base, toolName: "write", subject: "a.ts", floor: true })).toBeUndefined();
		// Auto mode never applies session allows — its prompts are resume/floor prompts.
		expect(sessionGrant({ ...base, toolName: "write", subject: "a.ts", mode: "auto" })).toBeUndefined();
		// A command tool with nothing to approve.
		expect(sessionGrant({ ...base, toolName: "bash", subject: "" })).toBeUndefined();
	});
});
