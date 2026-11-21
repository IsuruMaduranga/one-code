import { describe, expect, it } from "vitest";
import { rebrandResumeHint } from "../../extensions/lib/app/create-app.mjs";

const DIM = "\x1b[2m";
const RESET = "\x1b[22m";

describe("the app's name in pi's exit hint", () => {
	it("replaces the command on its own line (pi 1.6.0) and after a space (earlier)", () => {
		expect(rebrandResumeHint(`${DIM}To resume this session:${RESET}\npi --session abc123\n`, "onecode")).toBe(`${DIM}To resume this session:${RESET}\nonecode --session abc123\n`);
		expect(rebrandResumeHint(`${DIM}To resume this session:${RESET} pi --session abc123\n`, "onecode")).toBe(`${DIM}To resume this session:${RESET} onecode --session abc123\n`);
		expect(rebrandResumeHint("To resume this session:\npi --session abc123\n", "onecode")).toBe("To resume this session:\nonecode --session abc123\n");
	});

	it("replaces it when a session directory comes first", () => {
		expect(rebrandResumeHint(`${DIM}To resume this session:${RESET}\npi --session-dir /tmp/s --session abc123\n`, "onecode")).toBe(
			`${DIM}To resume this session:${RESET}\nonecode --session-dir /tmp/s --session abc123\n`,
		);
	});

	it("changes only the command word, and leaves other output alone", () => {
		expect(rebrandResumeHint(`To resume this session:\npi --session-dir "/x/ pi --session /y" --session abc\n`, "onecode")).toBe(`To resume this session:\nonecode --session-dir "/x/ pi --session /y" --session abc\n`);
		expect(rebrandResumeHint("run pi --session abc\n", "onecode")).toBe("run pi --session abc\n");
	});
});
