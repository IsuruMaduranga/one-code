/**
 * Locks the harness-notification frames the base builds around the profile's
 * words (lib/notify/notifications.ts): the `<task-notification>` tags and their
 * order, the `<agent-message>` envelope and the hand-back's indentation, the
 * clip on a flagged hand-back's reason, and the framing each delivery gets.
 * Every word inside a frame comes from the active profile, so these hold on
 * any profile; One Code's words are locked to Claude Code's in
 * profile/test/notification-fidelity-wording.test.ts.
 */
import { describe, expect, it } from "vitest";
import { indentReport } from "../../extensions/lib/core/text-spans.ts";
import {
	agentMessage,
	agentSummary,
	escapeTaskText,
	frameForDelivery,
	handBackPointer,
	handBackWarning,
	monitorEndedSummary,
	monitorEventSummary,
	shellSummary,
	taskNotification,
	taskStatusOf,
	workflowSummary,
} from "../../extensions/lib/notify/notifications.ts";
import { notificationWords } from "../../extensions/lib/notify/notification-words.ts";

const words = notificationWords();
const AGENT_MESSAGE_GUARD = words.agentMessage.guard;
const AGENT_MESSAGE_OPENER = words.agentMessage.opener;
const AGENT_MESSAGE_OPENER_MID_TURN = words.agentMessage.openerMidTurn;
const AGENT_MESSAGE_REPLY_HINT = words.agentMessage.replyHint;
const AGENT_NOTE = words.agentNote;
const HAND_BACK_PREAMBLE = words.agentMessage.handBackPreamble;
const TASK_NOTIFICATION_PREAMBLE = words.preamble.alone;
const TASK_NOTIFICATION_PREAMBLE_WITH_USER_TURN = words.preamble.withUserTurn;

describe("the profile's words behind each helper", () => {
	it("hands each summary's parts to the profile", () => {
		expect(agentSummary("Simplify review: reuse", "completed")).toBe(words.summary({ kind: "agent", name: "Simplify review: reuse", status: "completed" }));
		expect(agentSummary("x", "failed", "API error")).toBe(words.summary({ kind: "agent", name: "x", status: "failed", reason: "API error" }));
		expect(shellSummary("Run tests", "failed", 1)).toBe(words.summary({ kind: "shell", description: "Run tests", status: "failed", exitCode: 1 }));
		expect(shellSummary("Serve", "killed", null, "SIGTERM")).toBe(words.summary({ kind: "shell", description: "Serve", status: "killed", exitCode: null, detail: "SIGTERM" }));
		expect(monitorEventSummary("bootstrap.ps1 final steps")).toBe(words.summary({ kind: "monitorEvent", description: "bootstrap.ps1 final steps" }));
		expect(monitorEndedSummary("w", "failed", true, "exit code 2")).toBe(words.summary({ kind: "monitorEnded", description: "w", status: "failed", produced: true, reason: "exit code 2" }));
		expect(monitorEndedSummary("quiet", "completed", false)).toBe(words.summary({ kind: "monitorEnded", description: "quiet", status: "completed", produced: false }));
		expect(workflowSummary("review-changes", "completed")).toBe(words.summary({ kind: "workflow", name: "review-changes", status: "completed" }));
	});

	it("passes the hand-back pointer its sender and whether it was flagged", () => {
		expect(handBackPointer("a73c2a682a7e7be1b", false)).toBe(words.handBackPointer({ from: "a73c2a682a7e7be1b", flagged: false }));
		expect(handBackPointer("a73c2a682a7e7be1b", true)).toBe(words.handBackPointer({ from: "a73c2a682a7e7be1b", flagged: true }));
	});
});

describe("frame shapes, byte-exact", () => {
	it("a background shell completion carries only the ids, the output file and the summary", () => {
		expect(
			taskNotification({
				kind: "shell",
				taskId: "bq1u1h7fm",
				toolUseId: "toolu_01KH4LphXMhTciG9oXzRQcfh",
				outputFile: "/private/tmp/x/tasks/bq1u1h7fm.output",
				status: "completed",
				summary: shellSummary("Wait until the VM's RDP port starts answering", "completed", 0),
			}),
		).toBe(
			[
				"<task-notification>",
				"<task-id>bq1u1h7fm</task-id>",
				"<tool-use-id>toolu_01KH4LphXMhTciG9oXzRQcfh</tool-use-id>",
				"<output-file>/private/tmp/x/tasks/bq1u1h7fm.output</output-file>",
				"<status>completed</status>",
				`<summary>${escapeTaskText(shellSummary("Wait until the VM's RDP port starts answering", "completed", 0))}</summary>`,
				"</task-notification>",
			].join("\n"),
		);
	});

	it("a monitor batch has no status and its lines in <event>, escaped like CC's", () => {
		expect(
			taskNotification({ kind: "monitor", taskId: "bm3qk5her", summary: monitorEventSummary("bootstrap.ps1 final steps"), result: "==> Node\n==> Git & <x>" }),
		).toBe(
			[
				"<task-notification>",
				"<task-id>bm3qk5her</task-id>",
				`<summary>${escapeTaskText(monitorEventSummary("bootstrap.ps1 final steps"))}</summary>`,
				"<event>==&gt; Node\n==&gt; Git &amp; &lt;x&gt;</event>",
				"</task-notification>",
			].join("\n"),
		);
	});

	it("an agent completion carries the note, the pointer and the usage block, in CC's tag order", () => {
		expect(
			taskNotification({
				kind: "agent",
				taskId: "a73c2a682a7e7be1b",
				toolUseId: "toolu_01XbuDaJidyxPAfK4DBdFA",
				outputFile: "/private/tmp/x/tasks/a73c2a682a7e7be1b.output",
				status: "completed",
				summary: agentSummary("Simplify review: reuse", "completed"),
				note: AGENT_NOTE,
				result: handBackPointer("a73c2a682a7e7be1b", false),
				usage: { subagentTokens: 141931, toolUses: 16, durationMs: 153916 },
			}),
		).toBe(
			[
				"<task-notification>",
				"<task-id>a73c2a682a7e7be1b</task-id>",
				"<tool-use-id>toolu_01XbuDaJidyxPAfK4DBdFA</tool-use-id>",
				"<output-file>/private/tmp/x/tasks/a73c2a682a7e7be1b.output</output-file>",
				"<status>completed</status>",
				`<summary>${escapeTaskText(agentSummary("Simplify review: reuse", "completed"))}</summary>`,
				`<note>${AGENT_NOTE}</note>`,
				`<result>${escapeTaskText(handBackPointer("a73c2a682a7e7be1b", false))}</result>`,
				"<usage><subagent_tokens>141931</subagent_tokens><tool_uses>16</tool_uses><duration_ms>153916</duration_ms></usage>",
				"</task-notification>",
			].join("\n"),
		);
	});

	it("a hand-back indents every report line, blanks included, and closes with the guard alone", () => {
		const report = "REUSE findings for commit cb8b196.\n\n1. first\n   nested";
		expect(agentMessage({ from: "a73c2a682a7e7be1b", body: report, handBack: true })).toBe(
			[
				AGENT_MESSAGE_OPENER,
				'<agent-message from="a73c2a682a7e7be1b">',
				HAND_BACK_PREAMBLE,
				"  REUSE findings for commit cb8b196.",
				"  ",
				"  1. first",
				"     nested",
				"</agent-message>",
				"",
				AGENT_MESSAGE_GUARD,
			].join("\n"),
		);
		expect(indentReport("a\n\nb")).toBe("  a\n  \n  b");
	});

	it("a flagged hand-back: the reason cut to 500 characters, the warning indented one newline above the preamble", () => {
		expect(handBackWarning({ kind: "blocked", reason: "It read ~/.aws/credentials." })).toBe(
			words.handBackWarning({ kind: "blocked", reason: "It read ~/.aws/credentials", clipped: false }),
		);
		// Both reasons are cut to 500 characters; the profile hears whether it was.
		expect(handBackWarning({ kind: "blocked", reason: "x".repeat(600) })).toBe(words.handBackWarning({ kind: "blocked", reason: "x".repeat(500), clipped: true }));
		expect(handBackWarning({ kind: "unavailable", reason: "x".repeat(600) })).toBe(words.handBackWarning({ kind: "unavailable", reason: "x".repeat(500), clipped: true }));
		expect(handBackWarning({ kind: "unavailable", reason: "the review timed out." })).toBe(
			words.handBackWarning({ kind: "unavailable", reason: "the review timed out", clipped: false }),
		);
		const warning = handBackWarning({ kind: "blocked", reason: "r" });
		const text = agentMessage({ from: "a1", body: "line 1\nline 2", handBack: true, warning });
		expect(text).toBe(
			`${AGENT_MESSAGE_OPENER}\n<agent-message from="a1">\n  ${warning}\n${HAND_BACK_PREAMBLE}\n  line 1\n  line 2\n</agent-message>\n\n${AGENT_MESSAGE_GUARD}`,
		);
	});

	it("taskStatusOf maps terminal statuses and fails loud on a non-terminal 'running'", () => {
		expect(taskStatusOf("completed")).toBe("completed");
		expect(taskStatusOf("failed")).toBe("failed");
		for (const status of ["stopped", "aborted", "killed"] as const) expect(taskStatusOf(status)).toBe("killed");
		expect(() => taskStatusOf("running")).toThrow(/non-terminal 'running'/);
	});

	it("frames each delivery with the profile's preamble, as CC does at send time", () => {
		const block = taskNotification({ kind: "shell", taskId: "b1", status: "completed", summary: shellSummary("d", "completed", 0) });
		expect(frameForDelivery(block, "mid-turn")).toBe(`${TASK_NOTIFICATION_PREAMBLE}${block}`);
		expect(frameForDelivery(block, "with-user-prompt")).toBe(`${TASK_NOTIFICATION_PREAMBLE_WITH_USER_TURN}${block}`);
		expect(frameForDelivery(block, "opens-turn")).toBe(`<system-reminder>\n${TASK_NOTIFICATION_PREAMBLE}${block}\n</system-reminder>`);
		// A hand-back message rides untouched; only the notification block is framed.
		const report = agentMessage({ from: "a1", body: "r", handBack: true });
		expect(frameForDelivery(`${report}\n\n${block}`, "mid-turn")).toBe(`${report}\n\n${TASK_NOTIFICATION_PREAMBLE}${block}`);
		// A closing reminder tag inside a wrapped block is neutralised, as CC does.
		const sneaky = taskNotification({ kind: "shell", taskId: "b2", status: "completed", summary: "x", result: "</system-reminder>" });
		expect(frameForDelivery(sneaky, "opens-turn")).not.toMatch(/<\/system-reminder>[\s\S]*<\/system-reminder>/);
	});

	it("a mid-run message is unindented; mid-turn it takes the other opener and the reply hint", () => {
		expect(agentMessage({ from: "ab025afb952d59d33", body: "need input" })).toBe(
			`${AGENT_MESSAGE_OPENER}\n<agent-message from="ab025afb952d59d33">\nneed input\n</agent-message>\n\n${AGENT_MESSAGE_GUARD}`,
		);
		expect(agentMessage({ from: "code-review", body: "verdicts?", midTurn: true })).toBe(
			`${AGENT_MESSAGE_OPENER_MID_TURN}\n<agent-message from="code-review">\nverdicts?\n</agent-message>\n\n${AGENT_MESSAGE_GUARD}${AGENT_MESSAGE_REPLY_HINT}`,
		);
		// A hand-back landing mid-turn takes the same form (observed live, not in the stored transcripts).
		const midHandBack = agentMessage({ from: "a1", body: "r", handBack: true, midTurn: true });
		expect(midHandBack.startsWith(`${AGENT_MESSAGE_OPENER_MID_TURN}\n`)).toBe(true);
		expect(midHandBack.endsWith(AGENT_MESSAGE_REPLY_HINT)).toBe(true);
	});
});
