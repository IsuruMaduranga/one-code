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
/** A user-role message with its provenance entry: typed, or (`typed: false`) an extension's turn. */
const user = (text: string, typed = true) => {
	const timestamp = ++seq;
	return [
		{ type: "message", id: `u${timestamp}`, message: { role: "user", content: text, timestamp } },
		{ type: "custom", id: `p${timestamp}`, customType: CLASSIFIER_USER_INPUT, data: { timestamp, messageDigest: userMessageDigest(text), userText: typed ? text : null } },
	];
};
const said = (...content: unknown[]) => ({ type: "message", id: `a${++seq}`, message: { role: "assistant", content } });
const text = (body: string) => ({ type: "text", text: body });
const bash = (command: string) => ({ type: "toolCall", id: `c${++seq}`, name: "bash", arguments: { command } });
const project = (branch: unknown[], priorProse = true) => classifierHistory(branch, { priorProse }).transcript;

describe("the agent's prose before a typed reply", () => {
	it("sits directly above the reply it was answered by, only when asked for", () => {
		const branch = [...user("Tidy the release."), said(text("I will force-move the v1 tag. Shall I?")), ...user("go ahead")];
		expect(project(branch)).toEqual([
			{ kind: "user", text: "Tidy the release." },
			{ kind: "assistant", text: "I will force-move the v1 tag. Shall I?" },
			{ kind: "user", text: "go ahead" },
		]);
		// A subagent's view of the main session carries none.
		expect(project(branch, false)).toEqual([
			{ kind: "user", text: "Tidy the release." },
			{ kind: "user", text: "go ahead" },
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
		const long = `${"a".repeat(5000)} Shall I delete the v0 tag?`;
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
