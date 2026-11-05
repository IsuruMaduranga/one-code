/**
 * One Code's `/doctor fix` prompt (profile/doctor/): the golden snapshot does
 * not run /doctor (its report names the machine's tool versions), so the
 * prompt's moving parts are checked here.
 */
import { describe, expect, it } from "vitest";
import { doctor } from "../../profile/doctor/index.ts";
import type { FixPromptInput } from "../../extensions/doctor/text.ts";

const input: FixPromptInput = {
	reportText: "REPORT BODY",
	install: "app",
	oneCodeVersion: "9.9.9",
	sessionsDir: "/agent/sessions",
	sessionDir: "/agent/sessions/--proj--",
	oneCodeSettingsPath: "/home/u/.onecode/settings.json",
	oneCodeProjectSettingsPath: "/home/u/.onecode/projects/x/settings.json",
	decisionLogEnabled: false,
	modeCycleKey: "shift+tab",
	upgradeCommands: { npm: "npm i -g pkg", brew: "brew upgrade pkg", "pi-package": "pi update" },
};

describe("One Code's /doctor fix prompt", () => {
	it("attaches the report and names the install's upgrade commands and the mode key", () => {
		const text = doctor.fixPrompt(input);
		expect(text.startsWith("# One Code Doctor")).toBe(true);
		expect(text).toContain("REPORT BODY");
		expect(text).toContain("`npm i -g pkg` (or `brew upgrade pkg` for a Homebrew install)");
		expect(text).toContain("change the mode with shift+tab");
		expect(doctor.fixPrompt({ ...input, install: "pi-package" })).toContain("`pi update`");
	});

	it("maps Claude Code's paths to One Code's own only in independent mode", () => {
		expect(doctor.fixPrompt(input)).not.toContain("This session runs in independent mode");
		expect(doctor.fixPrompt({ ...input, independent: true })).toContain("This session runs in independent mode");
	});
});
