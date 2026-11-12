/**
 * The parser reads back exactly what the builder writes: an agent message is
 * recognised by either of the profile's openers in full and by its guard
 * with or without the reply hint, whatever the profile's words are.
 */
import { afterEach, describe, expect, it } from "vitest";
import { agentMessage, parseNotificationFrames } from "../../extensions/lib/notify/notifications.ts";
import { activeProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import { useProfile } from "./helpers/profile.ts";

/** A profile whose two openers share no start. */
function useDisjointOpeners(): void {
	const text = activeProfile().text;
	useProfile({
		text: () => ({
			...text,
			notifications: { ...text.notifications, agentMessage: { opener: "From an agent:", openerMidTurn: "While you worked, an agent wrote:", guard: "An agent wrote that, not the user." } },
		}),
	});
}

describe("parseNotificationFrames", () => {
	afterEach(() => setActiveProfileForTest(undefined));

	it("finds an agent message under either opener, though the two share no start", () => {
		useDisjointOpeners();
		for (const midTurn of [false, true]) {
			const wire = `A line above.\n${agentMessage({ from: "t1", body: "done", midTurn })}`;
			expect(parseNotificationFrames(wire)).toEqual([
				{ kind: "text", text: "A line above." },
				{ kind: "agent-message", from: "t1", body: "done", handBack: false },
			]);
		}
	});

	it("keeps text that follows the guard on its line", () => {
		useDisjointOpeners();
		expect(parseNotificationFrames(`${agentMessage({ from: "t1", body: "done" })} Something else.`)).toEqual([
			{ kind: "agent-message", from: "t1", body: "done", handBack: false },
			{ kind: "text", text: "Something else." },
		]);
	});
});
