import { describe, expect, it } from "vitest";
import { shellName } from "../../extensions/system-prompt/environment.ts";

describe("shellName", () => {
	it("is the basename of SHELL, else COMSPEC, with .exe stripped (Claude Code's Shell: line)", () => {
		expect(shellName({ SHELL: "/bin/zsh" })).toBe("zsh");
		expect(shellName({ SHELL: "C:\\Program Files\\Git\\bin\\bash.exe" })).toBe("bash");
		expect(shellName({ COMSPEC: "C:\\Windows\\system32\\cmd.exe" })).toBe("cmd");
		expect(shellName({ SHELL: "/usr/bin/fish", COMSPEC: "C:\\Windows\\system32\\cmd.exe" })).toBe("fish");
		expect(shellName({})).toBe("unknown");
	});
});
