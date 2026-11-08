/** One Code's words for a one-shot background shell's end and its saved output. */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";

describe("background shell output wording", () => {
	it("says a timed-out run failed, naming the timeout", () => {
		const text = requireText("shell").ranToEnd({
			label: "Bash",
			id: "b1",
			description: "sleep",
			end: { kind: "timedOut", seconds: 0.2 },
			note: "",
			logPath: "/tmp/out.log",
			output: "",
		} as never);
		expect(text).toContain("failed (timed out after 0.2s)");
	});

	it("names the file the whole output was saved to", () => {
		expect(requireText("toolResults").persisted({ size: "305.6KB", file: "/tmp/out.log" })).toContain("Full output saved to: /tmp/out.log");
	});
});
