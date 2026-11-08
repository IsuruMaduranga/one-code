import { describe, expect, it } from "vitest";
import { envName } from "../../extensions/lib/brand.mjs";
import { NO_SHELL_NOTICE, POWERSHELL_KNOB, powerShellSwitch, shellToolPolicy, withShellTools } from "../../extensions/powershell/policy.ts";

/** The product's own spelling of the switch (One Code: ONECODE_USE_POWERSHELL_TOOL). */
const KNOB = envName(POWERSHELL_KNOB);

describe("powerShellSwitch", () => {
	it("reads the product's USE_POWERSHELL_TOOL switch the way Claude Code reads its own", () => {
		expect(powerShellSwitch({})).toBe("unset");
		expect(powerShellSwitch({ [KNOB]: "" })).toBe("unset");
		expect(powerShellSwitch({ [KNOB]: "1" })).toBe("on");
		expect(powerShellSwitch({ [KNOB]: "true" })).toBe("on");
		expect(powerShellSwitch({ [KNOB]: "0" })).toBe("off");
		expect(powerShellSwitch({ [KNOB]: "False" })).toBe("off");
	});
});

describe("shellToolPolicy", () => {
	const win = (over: Partial<Parameters<typeof shellToolPolicy>[0]>) =>
		shellToolPolicy({ platform: "win32", env: {}, bash: true, powershell: true, ...over });
	const mac = (over: Partial<Parameters<typeof shellToolPolicy>[0]>) =>
		shellToolPolicy({ platform: "darwin", env: {}, bash: true, powershell: true, ...over });

	it("Windows: on by default, PowerShell primary, bash alongside", () => {
		expect(win({})).toMatchObject({ powershell: true, bash: true, primary: "powershell", notices: [] });
	});
	it("Windows without Git Bash: PowerShell alone", () => {
		expect(win({ bash: false })).toMatchObject({ powershell: true, bash: false, primary: "powershell" });
	});
	it("Windows with the switch off: bash primary", () => {
		expect(win({ env: { [KNOB]: "0" } })).toMatchObject({ powershell: false, bash: true, primary: "bash" });
	});
	it("Windows with neither shell fails loud in Claude Code's words", () => {
		const p = win({ bash: false, powershell: false });
		expect(p.primary).toBe("none");
		expect(p.notices).toContain(NO_SHELL_NOTICE);
	});
	it("off Windows: the env var is the whole gate", () => {
		expect(mac({})).toMatchObject({ powershell: false, bash: true, primary: "bash", notices: [] });
		expect(mac({ env: { [KNOB]: "1" } })).toMatchObject({ powershell: true, primary: "powershell" });
	});
	it("a set switch with no PowerShell installed is reported, and the tool stays off", () => {
		const p = mac({ env: { [KNOB]: "1" }, powershell: false });
		expect(p.powershell).toBe(false);
		expect(p.notices[0]).toMatch(/no `pwsh` was found/);
	});
});

describe("withShellTools", () => {
	const BASE = ["read", "bash", "edit", "write"];
	it("appends powershell when on and keeps order", () => {
		expect(withShellTools(BASE, { powershell: true, bash: true })).toEqual([...BASE, "powershell"]);
		expect(withShellTools([...BASE, "powershell"], { powershell: true, bash: true })).toEqual([...BASE, "powershell"]);
	});
	it("removes powershell when off and bash when none exists", () => {
		expect(withShellTools([...BASE, "powershell"], { powershell: false, bash: true })).toEqual(BASE);
		expect(withShellTools(BASE, { powershell: true, bash: false })).toEqual(["read", "edit", "write", "powershell"]);
	});
});
