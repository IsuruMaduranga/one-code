import { describe, expect, it, vi } from "vitest";
import sessionTitleExtension from "../../extensions/agents/session-title/index.ts";
import {
	firstUserText,
	isNameableText,
	parseTitle,
	SESSION_TEXT_LIMIT,
	sessionTitleInput as titleInput,
} from "../../extensions/agents/session-title/title.ts";
import { requireText } from "../../extensions/lib/profile/profile.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

/** The naming request's user message in the active profile's words. */
const sessionTitleInput = (text: string) => titleInput(requireText("sessionTitle"), text);

describe("session title input", () => {
	it("trims the text and hands it to the profile's frame", () => {
		expect(sessionTitleInput("  fix the footer  ")).toBe(requireText("sessionTitle").user("fix the footer"));
	});

	it("keeps the TAIL of an over-long first message (CC's MAX_CONVERSATION_TEXT)", () => {
		const text = "x".repeat(SESSION_TEXT_LIMIT) + "END";
		expect(sessionTitleInput(text)).toBe(requireText("sessionTitle").user("x".repeat(SESSION_TEXT_LIMIT - 3) + "END"));
	});
});

describe("isNameableText", () => {
	it("waits for real prose: no breadcrumbs, bash-mode input, slash commands or blanks", () => {
		expect(isNameableText("Fix the login button")).toBe(true);
		expect(isNameableText("   ")).toBe(false);
		expect(isNameableText("/clear")).toBe(false);
		expect(isNameableText("<command-name>/model</command-name>")).toBe(false);
		expect(isNameableText("<local-command-stdout></local-command-stdout>")).toBe(false);
		expect(isNameableText("<bash-input>ls</bash-input>")).toBe(false);
	});
});

describe("parseTitle", () => {
	it("reads CC's JSON shape, also inside a fence or after prose", () => {
		expect(parseTitle('{"title": "One Code project impressions"}')).toBe("One Code project impressions");
		expect(parseTitle('```json\n{"title":"footer branch label"}\n```')).toBe("Footer branch label");
		expect(parseTitle('Sure. {"title": "LSP diagnostics delta"}')).toBe("LSP diagnostics delta");
	});

	it("accepts a single bare line when no JSON was attempted, and refuses paragraphs", () => {
		expect(parseTitle('"Vultr Linux VM bootstrap"')).toBe("Vultr Linux VM bootstrap");
		expect(parseTitle("line one\nline two")).toBeUndefined();
		expect(parseTitle("a".repeat(200))).toBeUndefined();
		expect(parseTitle("")).toBeUndefined();
	});

	it("gives up on malformed JSON rather than titling the session with it", () => {
		expect(parseTitle('{"title": ')).toBeUndefined();
		expect(parseTitle('{"name": "x"}')).toBeUndefined();
	});
});

describe("firstUserText", () => {
	it("returns the first user message's text, string or block content", () => {
		expect(firstUserText([{ type: "message", message: { role: "assistant", content: "hi" } }, { type: "message", message: { role: "user", content: "first" } }, { type: "message", message: { role: "user", content: "second" } }])).toBe("first");
		// customMessageText renders a non-text block as an empty segment; the callers trim.
		expect(
			firstUserText([{ type: "message", message: { role: "user", content: [{ type: "image" }, { type: "text", text: "with image" }] } }])?.trim(),
		).toBe("with image");
		expect(firstUserText([{ type: "session_info" }])).toBeUndefined();
	});
});

describe("session-title wiring on a run an extension opened", () => {
	it("waits for the user's first prompt instead of spending its one attempt on a custom run (pi 1.2.0)", async () => {
		const fake = createFakePi();
		sessionTitleExtension(fake.pi as never);
		const getEntries = vi.fn(() => []);
		const ctx = createFakeCtx({ mode: "tui", sessionManager: { getEntries } });
		await fake.fire("before_agent_start", { messageType: "custom", message: { role: "custom" } }, ctx);
		expect(getEntries).not.toHaveBeenCalled();
		// The user's prompt still gets examined (a slash command is not nameable, so no request).
		await fake.fire("before_agent_start", { messageType: "user", prompt: "/help" }, ctx);
		expect(getEntries).toHaveBeenCalledTimes(1);
	});
});
