/**
 * The user-message extension owns the one Markdown transformer for user
 * messages. A notification's headline and a typed command's line show with
 * branding on or off; the `❯` pointer only with branding on. Branding itself
 * never touches a user message.
 */
import { afterEach, describe, expect, it } from "vitest";
import userMessageExtension from "../../extensions/ui/user-message/index.ts";
import { commandBreadcrumb, typedSkillContent } from "../../extensions/lib/plugins/skill-invoke.ts";
import { USER_MARKDOWN_CHANNEL, type UserMarkdownQuery } from "../../extensions/lib/ui/user-message.ts";
import { resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import { envName } from "../../extensions/lib/profile/brand.mjs";
import { profile } from "./helpers/default-profile.ts";

afterEach(() => setActiveProfileForTest(undefined));

type Transform = (markdown: string, context: { messageType: string }) => string;

function load(): { transform: Transform; start(theme?: unknown): void; userRow(): UserMarkdownQuery } {
	const transformers: Transform[] = [];
	const handlers: ((event: unknown, ctx: unknown) => void)[] = [];
	const listeners = new Map<string, ((data: unknown) => void)[]>();
	const pi = {
		registerMarkdownTransformer: (fn: Transform) => transformers.push(fn),
		on: (event: string, fn: (event: unknown, ctx: unknown) => void) => event === "session_start" && handlers.push(fn),
		events: {
			on: (channel: string, fn: (data: unknown) => void) => listeners.set(channel, [...(listeners.get(channel) ?? []), fn]),
			emit: (channel: string, data: unknown) => listeners.get(channel)?.forEach((fn) => fn(data)),
		},
	};
	userMessageExtension(pi as never);
	expect(transformers).toHaveLength(1);
	return {
		transform: transformers[0],
		start: (theme) => handlers.forEach((fn) => fn({ reason: "startup" }, { ui: { theme } })),
		userRow: () => {
			const query: UserMarkdownQuery = {};
			pi.events.emit(USER_MARKDOWN_CHANNEL, query);
			return query;
		},
	};
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

	it("answers the user-row query with the transformer's own rewrite, branding on or off (a skill typed after the first turn)", () => {
		const [breadcrumb, text] = typedSkillContent("greet", "Alice", "Reply with exactly one line: hello Alice");
		const skill = `${breadcrumb}\n${text}`;
		const on = load();
		on.start();
		expect(on.userRow().transform!(skill)).toBe("❯ /greet Alice");
		expect(on.userRow().transform!(skill)).toBe(on.transform(skill, { messageType: "user" }));
		setActiveProfileForTest(resolveProfile(profile, { [envName("FEATURES_OFF")]: "branding" }, "/profile"));
		const off = load();
		off.start();
		expect(off.userRow().transform!(skill)).toBe("/greet Alice");
	});

	it("cannot be turned off by a profile", () => {
		expect(() => resolveProfile(profile, { [envName("FEATURES_OFF")]: "user-message" }, "/profile")).toThrow(/user-message/);
	});
});
