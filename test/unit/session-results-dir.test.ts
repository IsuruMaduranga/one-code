/**
 * A session-less run (`--no-session`, every workflow agent) persists oversized
 * outputs to its own private temp dir, never to one folder shared by every
 * session, project and user on the machine. The same dir holds the other
 * folders the harness keeps per session (subagent runs, workflow runs, auto
 * mode's decision log), so none of them lands in the project: pi's session
 * dir is "" there, and a path joined onto it is relative to the project.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { brand } from "../../extensions/lib/profile/brand.mjs";
import { persistIfLarge, sessionResultsDir } from "../../extensions/lib/request/persisted-output.ts";
import { toolResultsText } from "../../extensions/lib/request/tool-results-text.ts";

const inMemory = (id: string, cwd = "/some/project") => ({ cwd, sessionManager: { getSessionDir: () => "", getSessionId: () => id } });

describe("sessionResultsDir without a session dir", () => {
	it("is per session and per user, not a shared temp folder", () => {
		const a = sessionResultsDir(inMemory("session-a"));
		const b = sessionResultsDir(inMemory("session-b"));
		expect(a).not.toBe(b);
		expect(basename(a)).toBe("session-a");
		expect(a).not.toBe(join(tmpdir(), "one-code"));
		if (typeof process.getuid === "function") {
			const owner = dirname(dirname(a));
			expect(basename(owner)).toBe(`${brand.bin}-${process.getuid()}`);
			expect(statSync(owner).mode & 0o777).toBe(0o700);
			expect(statSync(a).mode & 0o777).toBe(0o700);
		}
	});

	it("differs between projects for the same session id", () => {
		expect(sessionResultsDir(inMemory("s", "/p/one"))).not.toBe(sessionResultsDir(inMemory("s", "/p/two")));
	});

	it("is the session's own folder inside a real session dir, as Claude Code's per-session folder", () => {
		expect(sessionResultsDir({ sessionManager: { getSessionDir: () => "/home/u/.pi/agent/sessions/x", getSessionId: () => "abc" } })).toBe(join("/home/u/.pi/agent/sessions/x", "abc"));
	});

	it("is where persistIfLarge writes", () => {
		const dir = sessionResultsDir(inMemory("persist-check"));
		const text = persistIfLarge("x".repeat(60 * 1024), { dir, id: "t1" });
		const file = join(dir, "tool-results", "t1.txt");
		expect(text).toContain(toolResultsText.persisted({ size: "60.0KB", file }));
		expect(statSync(file).size).toBe(60 * 1024);
	});
});

describe("the session's harness folders", () => {
	it("sit outside the project in a session-less run", () => {
		const project = resolve(tmpdir(), "session-results-project");
		const dir = sessionResultsDir(inMemory("no-session-run", project));
		expect(isAbsolute(dir)).toBe(true);
		for (const folder of [join(dir, "subagents", "task-1"), join(dir, "workflows", "run-1"), join(dir, "auto-mode-decisions.jsonl")]) {
			expect(relative(project, folder).startsWith("..")).toBe(true);
		}
	});

	it("are derived only through sessionResultsDir, never from pi's bare session dir", () => {
		// pi's session dir is "" in a session-less run. The reads left are a
		// readable root, a snapshot handed to sessionResultsDir, and /doctor's text.
		const allowed = new Set(["lib/request/persisted-output.ts", "safety/permissions/index.ts", "safety/hooks/index.ts", "commands/doctor/index.ts"]);
		const root = resolve(__dirname, "../../extensions");
		const offenders = (readdirSync(root, { recursive: true }) as string[])
			.filter((file) => file.endsWith(".ts") && !allowed.has(file.split("\\").join("/")))
			.filter((file) => readFileSync(join(root, file), "utf8").includes("getSessionDir()"));
		expect(offenders).toEqual([]);
	});
});
