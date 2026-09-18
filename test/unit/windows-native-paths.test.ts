/**
 * Native Windows inputs — `C:\Users\…`, `C:/…`, `\\server\share`, the
 * `%USERPROFILE%` home, an 8.3-short-named `%TEMP%` — through every path gate
 * that the CI rounds only exercised with POSIX-spelled paths: the permission
 * matcher, containment, session grants, display paths, the state and
 * scratchpad dirs, and a `.cmd` shim on PATH (the shape npm gives an LSP
 * server on Windows). Windows-only: the inputs mean nothing elsewhere. Runs on
 * the windows-latest CI job; assertions carry the paths they compared so the
 * CI log is enough to debug a failure (docs/features/windows/handoff.md).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveForContainment } from "../../extensions/auto-mode/paths.ts";
import { forwardSlashes, oneCodeStateDir, tildify, toPosixPath } from "../../extensions/lib/paths.ts";
import { sessionScratchpadDir } from "../../extensions/lib/scratchpad.ts";
import { whichOnPath } from "../../extensions/lib/which.ts";
import { decide, isInsideDir, matchesPathPattern } from "../../extensions/permissions/matcher.ts";
import { sessionGrant } from "../../extensions/permissions/session-grant.ts";

const win32 = process.platform === "win32";
const home = homedir();
const cwd = process.cwd();

describe.skipIf(!win32)("Windows: home, state dir and display paths", () => {
	it("homedir() is USERPROFILE (HOME is unset for a Node process there) and ~/.onecode sits under it", () => {
		expect(process.env.USERPROFILE, "USERPROFILE").toBeTruthy();
		expect(home).toBe(process.env.USERPROFILE);
		expect(oneCodeStateDir({})).toBe(join(process.env.USERPROFILE as string, ".onecode"));
	});

	it("tildify shows a profile path as ~/… whatever its spelling, and leaves others alone", () => {
		expect(tildify(join(home, ".claude", "settings.json"), home)).toBe("~/.claude/settings.json");
		expect(tildify(`${forwardSlashes(home)}/notes`, home)).toBe("~/notes");
		expect(tildify(join(home.toLowerCase(), "Notes"), home)).toBe("~/Notes");
		expect(tildify(home, home)).toBe("~");
		expect(tildify("C:\\Other\\place", home)).toBe("C:\\Other\\place");
	});
});

describe.skipIf(!win32)("Windows: permission path patterns against native subjects", () => {
	const notes = join(home, "notes");
	const inNotes = join(notes, "a.md");
	/** Claude Code's absolute-rule form of a Windows dir: `//c/Users/x/notes/**`. */
	const ccRule = `/${toPosixPath(notes)}/**`;

	it("a //c/… rule matches the backslash, forward-slash, lower-cased and ~ spellings of a path under it", () => {
		expect(ccRule).toMatch(/^\/\/[a-z]\//);
		for (const subject of [inNotes, forwardSlashes(inNotes), inNotes.toLowerCase(), `~/notes/a.md`]) {
			expect(matchesPathPattern(ccRule, subject, cwd), `${ccRule} vs ${subject}`).toBe(true);
		}
		expect(matchesPathPattern(ccRule, join(home, "other", "a.md"), cwd)).toBe(false);
	});

	it("a rule for another drive never matches this one", () => {
		const otherDrive = ccRule.startsWith("//z/") ? ccRule.replace("//z/", "//y/") : ccRule.replace(/^\/\/[a-z]\//, "//z/");
		expect(matchesPathPattern(otherDrive, inNotes, cwd), `${otherDrive} vs ${inNotes}`).toBe(false);
	});

	it("a backslash-spelled rule and a C:/ rule are read as their / forms", () => {
		expect(matchesPathPattern(`${notes}\\**`, join(notes, "deep", "a.md"), cwd)).toBe(true);
		expect(matchesPathPattern(`${forwardSlashes(notes)}/**`, inNotes, cwd)).toBe(true);
	});

	it("a ~ rule matches a native path under the profile", () => {
		expect(matchesPathPattern("~/notes/**", inNotes, cwd)).toBe(true);
		expect(matchesPathPattern("~/notes/**", "C:\\Other\\notes\\a.md", cwd)).toBe(false);
	});

	it("a relative rule matches backslash-spelled relative and absolute subjects", () => {
		expect(matchesPathPattern("docs/**", "docs\\api\\readme.md", cwd)).toBe(true);
		expect(matchesPathPattern("docs/**", join(cwd, "docs", "readme.md"), cwd)).toBe(true);
		expect(matchesPathPattern("docs/**", join(cwd, "src", "readme.md"), cwd)).toBe(false);
	});

	it("a UNC path resolves and takes Claude Code's // spelling without throwing", () => {
		expect(toPosixPath("\\\\server\\share\\proj\\a.ts")).toBe("//server/share/proj/a.ts");
		expect(matchesPathPattern("docs/**", "\\\\server\\share\\proj\\docs\\a.md", cwd)).toBe(false);
	});
});

describe.skipIf(!win32)("Windows: containment and session grants on native paths", () => {
	it("isInsideDir compares native spellings case-insensitively, whatever the separators", () => {
		const proj = join(home, "proj");
		expect(isInsideDir(join(proj, "src", "a.ts"), forwardSlashes(proj), cwd)).toBe(true);
		expect(isInsideDir(join(proj, "a.ts").toUpperCase(), proj, cwd)).toBe(true);
		expect(isInsideDir(join(home, "proj2", "a.ts"), proj, cwd)).toBe(false);
		expect(isInsideDir(join(proj, "..", "a.ts"), proj, cwd)).toBe(false);
	});

	it("a grant minted for the working directory is a //c/… rule that matches later native-path calls", () => {
		const base = { cwd, home, mode: "default" as const, cause: "tier" };
		const grant = sessionGrant({ ...base, toolName: "write", subject: join(cwd, "src", "a.ts") });
		expect(grant?.rule.raw).toBe(`write(/${toPosixPath(resolve(cwd))}/**)`);
		const allow = [grant!.rule];
		for (const subject of [join(cwd, "docs", "b.md"), `${forwardSlashes(cwd)}/docs/b.md`, "docs\\b.md"]) {
			expect(decide({ ...base, toolName: "write", subject, deny: [], ask: [], allow }).decision, subject).toBe("allow");
		}
		expect(decide({ ...base, toolName: "write", subject: join(home, "elsewhere", "c.txt"), deny: [], ask: [], allow }).decision).toBe("ask");
	});

	it("an outside-cwd grant stops at the file's directory and names it with ~", () => {
		const grant = sessionGrant({ cwd, home, mode: "default", cause: "working-dir", toolName: "read", subject: join(home, "notes", "p.txt") });
		expect(grant?.rule.raw).toBe(`read(/${toPosixPath(join(home, "notes"))}/**)`);
		expect(grant?.label).toBe("Yes, and allow read under ~/notes this session");
	});
});

describe.skipIf(!win32)("Windows: the scratchpad under %TEMP%", () => {
	it("is spelled long-form even when %TEMP% carries an 8.3 short name, so a resolved write inside it clears", () => {
		const dir = sessionScratchpadDir(cwd, "session-1");
		const target = join(dir, "notes.md");
		const resolved = resolveForContainment(target);
		console.log(`tmpdir=${tmpdir()} scratchpad=${dir} resolved=${resolved}`);
		expect(dir).not.toMatch(/~\d/);
		expect(resolved).toBeDefined();
		expect(isInsideDir(resolved as string, dir, cwd), `${resolved} vs ${dir}`).toBe(true);
		const d = decide({ cwd, home, mode: "auto", cause: undefined, toolName: "write", subject: target, resolvedSubject: resolved, scratchpadDirPath: dir, deny: [], ask: [], allow: [] } as never);
		expect(d).toMatchObject({ decision: "allow", cause: "scratchpad-dir" });
	});
});

describe.skipIf(!win32)("Windows: a .cmd shim on PATH (npm's shape for an LSP server)", () => {
	const dir = mkdtempSync(join(tmpdir(), "cmd-shim-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

	it("is found by whichOnPath (PATHEXT) but not by a bare spawn, which is how lsp/client.ts starts a server", async () => {
		writeFileSync(join(dir, "probe-tool.cmd"), "@echo off\r\necho probe-ok\r\n");
		const env = { ...process.env, PATH: `${dir};${process.env.PATH ?? ""}` };
		expect(whichOnPath("probe-tool", env, "win32")).toBe(join(dir, "probe-tool.cmd"));
		const outcome = await new Promise<string>((done) => {
			const child = spawn("probe-tool", [], { env, stdio: "ignore", windowsHide: true });
			child.on("error", (error) => done(`error:${(error as NodeJS.ErrnoException).code}`));
			child.on("spawn", () => done("spawned"));
		});
		console.log(`bare spawn of a .cmd shim on Windows: ${outcome}`);
		expect(outcome).toMatch(/^error:(ENOENT|EINVAL)$/);
	});
});
