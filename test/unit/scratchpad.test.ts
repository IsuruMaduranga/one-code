import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveForContainment } from "../../extensions/auto-mode/paths.ts";
import { comparablePath } from "../../extensions/lib/paths.ts";
import {
	ensurePrivateScratchpad,
	isPrivateScratchpad,
	ownerDirProblem,
	scratchpadDir,
	sessionScratchpadDir,
} from "../../extensions/lib/scratchpad.ts";
import { isInsideDir } from "../../extensions/permissions/matcher.ts";

describe("scratchpadDir", () => {
	it("builds Claude Code's path shape under a One Code-named owner dir", () => {
		expect(scratchpadDir("/private/tmp", 501, "/Users/u/ml/proj", "abc-123")).toBe(
			join("/private/tmp", "onecode-501", "-Users-u-ml-proj", "abc-123", "scratchpad"),
		);
	});

	it("drops the uid suffix where the platform has none", () => {
		expect(scratchpadDir("/tmp", undefined, "/home/u/proj", "s1")).toBe(join("/tmp", "onecode", "-home-u-proj", "s1", "scratchpad"));
	});
});

describe("sessionScratchpadDir", () => {
	it("is spelled in the temp root's resolved form, so a resolved write inside it is recognised", () => {
		// macOS: /tmp → /private/tmp; Windows: %TEMP% through its 8.3 short names
		// (`RUNNER~1` on the CI runner). The permission check compares the
		// realpath'd subject against this dir with no further resolution.
		const dir = sessionScratchpadDir(process.cwd(), "session-1");
		const resolved = resolveForContainment(join(dir, "notes.md"));
		expect(resolved, `${resolved} vs ${dir}`).toBe(comparablePath(join(dir, "notes.md")));
		expect(isInsideDir(resolved!, dir, process.cwd())).toBe(true);
	});
});

describe("the scratchpad on a shared temp root (a pre-created owner dir)", () => {
	const root = mkdtempSync(join(tmpdir(), "scratch-owner-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const uid = process.getuid?.() ?? 0;
	const dirFor = (owner: string) => join(root, owner, "-proj", "session-1", "scratchpad");
	// POSIX owners and mode bits: Windows has neither (process.getuid is absent
	// there, so One Code passes no uid and skips the check).
	const posix = process.platform !== "win32";

	it.runIf(posix)("creates every level private to the user", () => {
		const dir = dirFor("fresh");
		expect(ensurePrivateScratchpad(dir, uid)).toBe(true);
		expect(statSync(join(root, "fresh")).mode & 0o777).toBe(0o700);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(isPrivateScratchpad(dir, uid)).toBe(true);
	});

	it.runIf(posix)("tightens an owner dir this user made before with a readable mode", () => {
		mkdirSync(join(root, "loose"), { mode: 0o755 });
		chmodSync(join(root, "loose"), 0o755);
		expect(isPrivateScratchpad(dirFor("loose"), uid)).toBe(false);
		expect(ensurePrivateScratchpad(dirFor("loose"), uid)).toBe(true);
		expect(statSync(join(root, "loose")).mode & 0o777).toBe(0o700);
	});

	it("refuses an owner dir that is a symlink, writable by others, or someone else's", () => {
		mkdirSync(join(root, "elsewhere"));
		symlinkSync(join(root, "elsewhere"), join(root, "linked"));
		expect(ensurePrivateScratchpad(dirFor("linked"), uid)).toBe(false);
		mkdirSync(join(root, "open"));
		chmodSync(join(root, "open"), 0o777);
		expect(ensurePrivateScratchpad(dirFor("open"), uid)).toBe(false);
		expect(existsSync(dirFor("open"))).toBe(false);
		// Another user's directory: the same check with a uid that is not the owner's.
		expect(ensurePrivateScratchpad(dirFor("fresh"), uid + 1)).toBe(false);
		expect(isPrivateScratchpad(dirFor("fresh"), uid + 1)).toBe(false);
	});

	it("judges an lstat the way the check does", () => {
		const base = { isSymbolicLink: false, isDirectory: true, uid: 501, mode: 0o40700 };
		expect(ownerDirProblem(base, 501)).toBeUndefined();
		expect(ownerDirProblem({ ...base, uid: 1001 }, 501)).toBe("it is owned by uid 1001");
		expect(ownerDirProblem({ ...base, mode: 0o40777 }, 501)).toBe("others may write to it");
		expect(ownerDirProblem({ ...base, mode: 0o40770 }, 501)).toBe("others may write to it");
		expect(ownerDirProblem({ ...base, isSymbolicLink: true }, 501)).toBe("it is a symlink");
	});
});
