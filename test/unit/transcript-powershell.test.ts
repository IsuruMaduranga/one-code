import { describe, expect, it } from "vitest";
import { renderTranscript } from "../../extensions/auto-mode/transcript.ts";

describe("renderTranscript — PowerShell and the gitStatus meta line", () => {
	it("renders a powershell call as {\"PowerShell\":\"<command>\"} like Bash", () => {
		const text = renderTranscript([
			{ kind: "user", text: "check the tree" },
			{ kind: "tool", tool: "powershell", input: { command: "git status", description: "look" } },
			{ kind: "tool", tool: "bash", input: { command: "git status" } },
		]);
		expect(text).toContain('{"PowerShell":"git status"}');
		expect(text).toContain('{"Bash":"git status"}');
		expect(text).not.toContain('"description"');
	});

	it("renders the captured ground-truth line after a git status", () => {
		const text = renderTranscript([
			{ kind: "tool", tool: "powershell", input: { command: "git status" } },
			{ kind: "meta", gitStatus: { clean: true } },
		]);
		expect(text.split("\n")).toEqual(["<transcript>", '{"PowerShell":"git status"}', '{"meta":{"gitStatus":{"clean":true}}}', "</transcript>"]);
	});

	it("renders a denied powershell call with Claude Code's tool name", () => {
		const text = renderTranscript([{ kind: "denied", tool: "powershell", subject: "rm -r x", rule: "PowerShell(Remove-Item:*)" }]);
		expect(text).toContain('"tool":"PowerShell"');
	});
});
