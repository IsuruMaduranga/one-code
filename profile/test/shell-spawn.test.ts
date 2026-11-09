/**
 * One Code's provider reads Claude Code's spelling of the Git Bash knob,
 * `CLAUDE_CODE_GIT_BASH_PATH`, as an alias (lib/profile/knobs.ts), from the process
 * environment and from the settings `env` block. The base's override rules
 * are in test/unit/shell-spawn.test.ts.
 */
import { describe, expect, it } from "vitest";
import { gitBashOverride, resolveBashSpawn } from "../../extensions/lib/shell-run/shell-spawn.ts";

describe("Claude Code's Git Bash knob", () => {
	it("names a custom bash from the environment or the settings env block", () => {
		expect(gitBashOverride({ CLAUDE_CODE_GIT_BASH_PATH: "C:\\a\\bash.exe" }, { CLAUDE_CODE_GIT_BASH_PATH: "C:\\b\\bash.exe" })).toEqual({
			path: "C:\\a\\bash.exe",
			source: "env",
			name: "CLAUDE_CODE_GIT_BASH_PATH",
		});
		expect(gitBashOverride({}, { CLAUDE_CODE_GIT_BASH_PATH: "C:\\b\\bash.exe" })).toEqual({ path: "C:\\b\\bash.exe", source: "settings", name: "CLAUDE_CODE_GIT_BASH_PATH" });
	});

	it("is ignored with a warning naming it when it is not a bash binary", () => {
		const result = resolveBashSpawn({
			env: { CLAUDE_CODE_GIT_BASH_PATH: "C:\\Windows\\System32\\cmd.exe" },
			exists: () => true,
			fallback: () => ({ shell: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["-c"] }),
		});
		expect(result.warning).toBe('CLAUDE_CODE_GIT_BASH_PATH ignored: "C:\\Windows\\System32\\cmd.exe" is not a bash or sh binary.');
	});
});
