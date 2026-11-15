/**
 * The user-message extension owns the one Markdown transformer for user
 * messages. A notification's headline and a typed command's line show with
 * branding on or off; the `❯` pointer only with branding on. Branding itself
 * never touches a user message.
 */
import { afterEach, describe, expect, it } from "vitest";
import userMessageExtension from "../../extensions/ui/user-message/index.ts";
import { commandBreadcrumb } from "../../extensions/lib/plugins/skill-invoke.ts";
import { resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import { envName } from "../../extensions/lib/profile/brand.mjs";
import { profile } from "../../profile/index.ts";

afterEach(() => setActiveProfileForTest(undefined));

type Transform = (markdown: string, context: { messageType: string }) => string;

function load(): { transform: Transform; start(theme?: unknown): void } {
	const transformers: Transform[] = [];
	const handlers: ((event: unknown, ctx: unknown) => void)[] = [];
	const pi = {
		registerMarkdownTransformer: (fn: Transform) => transformers.push(fn),
		on: (event: string, fn: (event: unknown, ctx: unknown) => void) => event === "session_start" && handlers.push(fn),
		events: { on: () => {}, emit: () => {} },
	};
	userMessageExtension(pi as never);
	expect(transformers).toHaveLength(1);
	return { transform: transformers[0], start: (theme) => handlers.forEach((fn) => fn({ reason: "startup" }, { ui: { theme } })) };
}

const command = `${commandBreadcrumb("init", "")}Please analyze the codebase`;
const notification = "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command \"ls\" completed (exit code 0)</summary>\n</task-notification>";
const headline = '✳ Background command "ls" completed (exit code 0)';

describe("user-message transformer", () => {
	it("with branding on: the command line and plain text marked, the notification headline unmarked", () => {
		const { transform, start } = load();
		start({ fg: (color: string, text: string) => `<${color}>${text}</>`, getFgAnsi: (color: string) => `<${color}>` });
		expect(transform(command, { messageType: "user" })).toBe("<dim>❯</><userMessageText> /init");
		expect(transform("hello", { messageType: "user" })).toBe("<dim>❯</><userMessageText> hello");
		expect(transform(notification, { messageType: "user" })).toBe(headline);
		expect(transform("Done.", { messageType: "assistant" })).toBe("Done.");
	});

	it("with branding off: the command line and the notification headline still show, with no pointer", () => {
		setActiveProfileForTest(resolveProfile(profile, { [envName("FEATURES_OFF")]: "branding" }, "/profile"));
		const { transform, start } = load();
		start();
		expect(transform(command, { messageType: "user" })).toBe("/init");
		expect(transform(notification, { messageType: "user" })).toBe(headline);
		expect(transform("hello", { messageType: "user" })).toBe("hello");
	});

	it("cannot be turned off by a profile", () => {
		expect(() => resolveProfile(profile, { [envName("FEATURES_OFF")]: "user-message" }, "/profile")).toThrow(/user-message/);
	});
});
