/**
 * A session-less run (`--no-session`, every workflow agent) persists oversized
 * outputs to its own private temp dir, never to one folder shared by every
 * session, project and user on the machine.
 */
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { persistIfLarge, sessionResultsDir } from "../../extensions/lib/persisted-output.ts";

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
			expect(basename(owner)).toBe(`onecode-${process.getuid()}`);
			expect(statSync(owner).mode & 0o777).toBe(0o700);
			expect(statSync(a).mode & 0o777).toBe(0o700);
		}
	});

	it("differs between projects for the same session id", () => {
		expect(sessionResultsDir(inMemory("s", "/p/one"))).not.toBe(sessionResultsDir(inMemory("s", "/p/two")));
	});

	it("keeps a real session dir when there is one", () => {
		expect(sessionResultsDir({ sessionManager: { getSessionDir: () => "/home/u/.pi/agent/sessions/x" } })).toBe("/home/u/.pi/agent/sessions/x");
	});

	it("is where persistIfLarge writes", () => {
		const dir = sessionResultsDir(inMemory("persist-check"));
		const text = persistIfLarge("x".repeat(60 * 1024), { dir, id: "t1" });
		expect(text).toContain(`Full output saved to: ${join(dir, "tool-results", "t1.txt")}`);
	});
});
