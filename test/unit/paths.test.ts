import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeConfigDir, gitBashPathToNative, msysPathToWindows, oneCodeStateDir } from "../../extensions/lib/paths.ts";

describe("paths", () => {
	it("defaults to ~/.claude and ~/.onecode", () => {
		expect(claudeConfigDir({})).toBe(join(homedir(), ".claude"));
		expect(oneCodeStateDir({})).toBe(join(homedir(), ".onecode"));
	});

	it("honours the env overrides", () => {
		expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/custom/claude" })).toBe("/custom/claude");
		expect(oneCodeStateDir({ ONECODE_STATE_DIR: "/custom/one-code" })).toBe("/custom/one-code");
	});

	it("ignores empty overrides", () => {
		expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "" })).toBe(join(homedir(), ".claude"));
		expect(oneCodeStateDir({ ONECODE_STATE_DIR: "" })).toBe(join(homedir(), ".onecode"));
	});
});

/**
 * Git Bash spells absolute paths the MSYS way; a bash command line on Windows
 * carries them (`echo x > /c/proj/out`), and `path.resolve` misreads them as
 * `<drive>:\c\proj\out`. The converter is pure so its shapes are pinned on
 * every platform; the win32 gate around it is pinned per platform.
 */
describe("msysPathToWindows", () => {
	const TMP = "C:\\Users\\x\\AppData\\Local\\Temp";

	it("maps a drive-letter root, with or without a tail", () => {
		expect(msysPathToWindows("/c/Users/x/proj/a.ts", TMP)).toBe("C:\\Users\\x\\proj\\a.ts");
		expect(msysPathToWindows("/d/", TMP)).toBe("D:\\");
		expect(msysPathToWindows("/d", TMP)).toBe("D:\\");
	});

	it("maps the cygdrive form Claude Code also accepts", () => {
		expect(msysPathToWindows("/cygdrive/c/proj", TMP)).toBe("C:\\proj");
	});

	it("maps /tmp onto the user's temp dir (Git for Windows' usertemp mount)", () => {
		expect(msysPathToWindows("/tmp/out.txt", TMP)).toBe(join(TMP, "out.txt"));
		expect(msysPathToWindows("/tmp", TMP)).toBe(TMP);
	});

	it("leaves every other spelling alone", () => {
		for (const p of ["/usr/bin/env", "/etc/hosts", "/tmpfile", "/cc/x", "C:/proj/a.ts", "C:\\proj\\a.ts", "rel/a.ts", "~/x", "//server/share/x"]) {
			expect(msysPathToWindows(p, TMP)).toBe(p);
		}
	});

	it("is gated to win32", () => {
		const converted = gitBashPathToNative("/c/proj/a.ts");
		if (process.platform === "win32") expect(converted).toBe("C:\\proj\\a.ts");
		else expect(converted).toBe("/c/proj/a.ts");
	});
});
