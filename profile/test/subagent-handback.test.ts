/**
 * One Code's SubagentHandback wording (profile/text/handback/): Claude Code's
 * description, parameter, reminder and results. The base's hand-back
 * behavior is in test/unit/subagent-handback.test.ts.
 */
import { describe, expect, it } from "vitest";
import { handback } from "../text/handback/index.ts";
import { handbackResultText } from "../../extensions/lib/agents/handback-text.ts";

describe("One Code's SubagentHandback text", () => {
	it("carries Claude Code's description, reminder and parameter", () => {
		expect(handback.description).toBe(
			"Deliver your final report to the agent that spawned you (your caller). Use it once, for that hand-off only: when your work is complete, call SubagentHandback({message: <your full report>}). The call ends your run, so do everything else first and put everything your caller needs in that one report. It is not a messaging channel: do not use it for progress updates or questions.\n\nOnly a report delivered through SubagentHandback reaches your caller; plain text you write at the end of your run is NOT delivered. There is no recipient parameter: the report can only go to your caller.",
		);
		expect(handbackResultText.reminder).toBe(
			"Your final report is delivered through SubagentHandback: when your work is complete, call SubagentHandback({message: <your full report>}). The call ends your run, so make it your last step. Only a SubagentHandback call reaches your caller as your result; plain text you write at the end is not delivered.",
		);
		expect(handback.messageParam).toBe("Your full report for your caller");
	});

	it("words a delivered report, and a second one by whether the child can still message its caller", () => {
		expect(handbackResultText.delivered).toBe("Report delivered to your caller.");
		expect(handbackResultText.alreadyDelivered({ sendMessage: true })).toBe(
			"Nothing was sent: your report was already delivered (SubagentHandback delivers one report). Use SendMessage for anything further, then stop.",
		);
		expect(handbackResultText.alreadyDelivered({ sendMessage: false })).not.toContain("SendMessage");
	});
});
