/**
 * The agent's prose before a typed user reply in the classifier transcript:
 * a reply such as "go ahead" names nothing by itself, and the ruleset reads it
 * against the proposal it answers. Which prose qualifies, where it sits, and
 * how it is bounded.
 */
import { describe, expect, it } from "vitest";
import { CLASSIFIER_USER_INPUT, classifierHistory, PRIOR_PROSE_CHARS, userMessageDigest } from "../../extensions/safety/permissions/auto-mode/history.ts";
import { buildPayload } from "../../extensions/safety/permissions/auto-mode/prompt.ts";
import { DEFAULT_ENVIRONMENT } from "./helpers/classify-request.ts";

let seq = 0;
/** A user-role message with its provenance entry: typed, or (`typed: false`) an extension's turn; `queued` when submitted while the agent worked. */
const user = (text: string, typed = true, queued = false) => {
	const timestamp = ++seq;
	return [
		{ type: "message", id: `u${timestamp}`, message: { role: "user", content: text, timestamp } },
		{ type: "custom", id: `p${timestamp}`, customType: CLASSIFIER_USER_INPUT, data: { timestamp, messageDigest: userMessageDigest(text), userText: typed ? text : null, ...(queued ? { queued: true } : {}) } },
	];
};
const said = (...content: unknown[]) => ({ type: "message", id: `a${++seq}`, message: { role: "assistant", content } });
const text = (body: string) => ({ type: "text", text: body });
const bash = (command: string) => ({ type: "toolCall", id: `c${++seq}`, name: "bash", arguments: { command } });
const project = (branch: unknown[]) => classifierHistory(branch);

describe("the agent's prose before a typed reply", () => {
	it("sits directly above the reply it was answered by", () => {
		const branch = [...user("Tidy the release."), said(text("I will force-move the v1 tag. Shall I?")), ...user("go ahead")];
		expect(project(branch)).toEqual([
			{ kind: "user", text: "Tidy the release." },
			{ kind: "assistant", text: "I will force-move the v1 tag. Shall I?" },
			{ kind: "user", text: "go ahead" },
		]);
	});

	it("is in a child's view too, so that view stays a prefix of what the main session's calls sent", () => {
		const spawn = { type: "toolCall", id: "spawn", name: "Agent", arguments: { prompt: "move the tag" } };
		const later = bash("git push --tags");
		const branch = [...user("Tidy the release."), said(text("I will force-move the v1 tag. Shall I?")), ...user("go ahead"), said(bash("git fetch"), spawn), said(later)];
		const atSpawn = classifierHistory(branch, { beforeToolCallId: "spawn" });
		const child = classifierHistory(branch, { throughToolCallId: "spawn" });
		const afterwards = classifierHistory(branch, { beforeToolCallId: later.id });
		expect(atSpawn.some((entry) => entry.kind === "assistant")).toBe(true);
		expect(child.slice(0, atSpawn.length)).toEqual(atSpawn);
		expect(afterwards.slice(0, child.length)).toEqual(child);
	});

	it("is left out for a reply the user submitted while the agent was still working", () => {
		const branch = [...user("Tidy the release."), said(text("Done. Shall I force-push to main?")), ...user("yes, go ahead", true, true)];
		expect(project(branch)).toEqual([
			{ kind: "user", text: "Tidy the release." },
			{ kind: "user", text: "yes, go ahead" },
		]);
	});

	it("survives the agent's own tool calls, and the latest prose wins", () => {
		const check = bash("git status");
		const branch = [...user("Tidy the release."), said(text("First I will look.")), said(check), said(text("I will delete the v0 tag. OK?"), bash("git tag -l")), ...user("yes")];
		expect(project(branch)).toEqual([
			{ kind: "user", text: "Tidy the release." },
			{ kind: "tool", tool: "bash", input: { command: "git status" } },
			{ kind: "tool", tool: "bash", input: { command: "git tag -l" } },
			{ kind: "assistant", text: "I will delete the v0 tag. OK?" },
			{ kind: "user", text: "yes" },
		]);
	});

	it("is dropped when another user-role message comes between it and the reply", () => {
		const branch = [...user("Tidy the release."), said(text("I will delete the v0 tag. OK?")), ...user("A skill body the user never typed.", false), ...user("yes")];
		expect(project(branch)).toEqual([
			{ kind: "user", text: "Tidy the release." },
			{ kind: "user", text: "yes" },
		]);
	});

	it("is dropped by a notification, a branch summary or a shell entry between it and the reply", () => {
		const between = [
			{ type: "custom_message", id: "n1", customType: "task-notification", content: "The build finished.", display: true },
			{ type: "branch_summary", id: "b1", summary: "Another branch's work." },
			{ type: "message", id: "s1", message: { role: "bashExecution", command: "ls", output: "a.txt" } },
		];
		for (const entry of between) {
			const projected = project([...user("Tidy the release."), said(text("I will delete the v0 tag. OK?")), entry, ...user("yes")]);
			expect(projected.some((line) => line.kind === "assistant"), entry.type).toBe(false);
		}
	});

	it("is dropped by a submitted dialog answer, and kept across a dialog with no answer", () => {
		const ask = { questions: [{ question: "Which tag?", options: [{ label: "v0" }, { label: "v1" }] }] };
		const dialog = (id: string, details: unknown) => [
			said(text("I will delete a tag. Which one?"), { type: "toolCall", id, name: "ask_user_question", arguments: ask }),
			{ type: "message", id: `r-${id}`, message: { role: "toolResult", toolCallId: id, toolName: "ask_user_question", content: [{ type: "text", text: "v0" }], details, isError: false } },
			said(bash("git tag -l")),
		];
		const answered = project([...user("Tidy the release."), ...dialog("q1", { answerText: "v0" }), ...user("yes")]);
		expect(answered.filter((line) => line.kind === "assistant")).toEqual([]);
		expect(answered.at(-1)).toEqual({ kind: "user", text: "yes" });
		const cancelled = project([...user("Tidy the release."), ...dialog("q2", {}), ...user("yes")]);
		expect(cancelled.filter((line) => line.kind === "assistant")).toEqual([{ kind: "assistant", text: "I will delete a tag. Which one?" }]);
	});

	it("is never emitted without a reply after it", () => {
		const branch = [...user("Tidy the release."), said(text("Deleting the tag now."), bash("git tag -d v0"))];
		expect(project(branch).some((entry) => entry.kind === "assistant")).toBe(false);
	});

	it("is the reply's text blocks only: no thinking, no errored reply, nothing for whitespace", () => {
		const branch = [
			...user("Tidy the release."),
			said({ type: "thinking", thinking: "hidden reasoning" }, text("Plan:"), text("delete the v0 tag.")),
			{ type: "message", id: "err", message: { role: "assistant", stopReason: "error", content: [text("partial text of a failed reply")] } },
			said(text("  \n ")),
			...user("ok"),
		];
		expect(project(branch)[1]).toEqual({ kind: "assistant", text: "Plan:\ndelete the v0 tag." });
	});

	it("keeps the last characters of a long message, without splitting a surrogate pair", () => {
		expect(PRIOR_PROSE_CHARS).toBe(8000);
		const long = `${"a".repeat(PRIOR_PROSE_CHARS + 3000)} Shall I delete the v0 tag?`;
		const kept = project([...user("Tidy."), said(text(long)), ...user("yes")])[1];
		expect(kept).toEqual({ kind: "assistant", text: long.slice(-PRIOR_PROSE_CHARS) });
		// The cut falls inside "😀" (two code units): the stray half is dropped.
		const emoji = `x😀${"b".repeat(PRIOR_PROSE_CHARS - 1)}`;
		const cut = project([...user("Tidy."), said(text(emoji)), ...user("yes")])[1];
		expect(cut).toEqual({ kind: "assistant", text: "b".repeat(PRIOR_PROSE_CHARS - 1) });
	});

	it("renders as an assistant line directly above the user's line", () => {
		const transcript = project([...user("Tidy the release."), said(text("I will delete the v0 tag. OK?")), ...user("yes"), said(bash("git tag -d v0"))]);
		const { userPrefix } = buildPayload({ toolName: "bash", transcript, username: "tester", environment: DEFAULT_ENVIRONMENT });
		expect(userPrefix).toContain(`{"assistant":"I will delete the v0 tag. OK?"}\n{"user":"yes"}`);
	});
});
