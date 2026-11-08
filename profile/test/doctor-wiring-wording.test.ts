/**
 * One Code's `/doctor` checkup prompt tells the model which files it may
 * write. How the base sends the prompt: test/unit/doctor-wiring.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { FixPromptInput } from "../../extensions/doctor/text.ts";
import { ALL_LIVE } from "../../test/unit/helpers/live.ts";
import { doctorText } from "../text/doctor/index.ts";

const input: FixPromptInput = {
	reportText: "REPORT BODY",
	install: "app",
	productVersion: "9.9.9",
	sessionsDir: "/agent/sessions",
	sessionDir: "/agent/sessions/--proj--",
	productSettingsPath: "/home/u/.onecode/settings.json",
	productProjectSettingsPath: "/home/u/.onecode/projects/x/settings.json",
	decisionLogEnabled: false,
	modeCycleKey: "shift+tab",
	upgradeCommands: { npm: "npm i -g pkg", brew: "brew upgrade pkg", "pi-package": "pi update" },
};

describe("One Code's /doctor checkup prompt", () => {
	it("says One Code never writes Claude Code's files", () => {
		expect(doctorText(ALL_LIVE).fixPrompt(input)).toContain("One Code never writes Claude Code's files");
	});
});
