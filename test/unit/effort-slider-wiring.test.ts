/**
 * The `/effort` slider as the effort feature draws it: the profile's
 * `sliderNote` is asked for the highlighted stop on every render, and a
 * profile without one leaves the slider as it was.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import effortExtension from "../../extensions/ui/effort/index.ts";
import { activeProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import { brand } from "../../extensions/lib/profile/brand.mjs";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";
import type { EffortText } from "../../extensions/sdk/profile.ts";
import { useProfile } from "./helpers/profile.ts";

// Captured before any test replaces it: the profile in force when the file loads.
const inForce = activeProfile();
/** The profile in force with its effort text replaced; the rest of its text, as built for the tools the profile has live. */
const withEffort = (effort: EffortText) =>
	useProfile({ text: ({ live }) => ({ ...inForce.textFor(live), effort }) });
const effortText = inForce.text.effort!;

const MODEL = { provider: "openai", id: "reasoner", name: "Reasoner", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
const RIGHT = "\u001b[C";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "effort-slider-wiring-"));
	stubHome(home);
	vi.stubEnv("PI_CODING_AGENT_DIR", join(home, brand.stateDir, "agent"));
});
afterEach(() => {
	setActiveProfileForTest(undefined);
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

/** Opens the slider on medium and returns what each step of a walk to the right renders, then cancels. */
async function walk(width = 120, steps = 2): Promise<string[][]> {
	const fake = createFakePi();
	fake.pi.getThinkingLevel = vi.fn(() => "medium");
	fake.pi.setThinkingLevel = vi.fn();
	fake.pi.getSettings = () => ({});
	const ctx = createFakeCtx({ model: MODEL, mode: "tui", hasUI: true });
	const screens: string[][] = [];
	notified = (ctx as unknown as { _notified: Array<{ message: string; type?: string }> })._notified;
	(ctx.ui as { custom: ReturnType<typeof vi.fn> }).custom.mockImplementation(
		async (factory) =>
			new Promise((done) => {
				const component = factory({ requestRender: vi.fn() }, {}, {}, done);
				screens.push(component.render(width));
				for (let i = 0; i < steps; i++) {
					component.handleInput(RIGHT);
					screens.push(component.render(width));
				}
				component.handleInput("\u001b");
			}),
	);
	effortExtension(fake.pi as never);
	await fake.commands.get("effort")!.handler("", ctx);
	return screens;
}

/** What the last walk's session told the user. */
let notified: Array<{ message: string; type?: string }> = [];

const markerColumn = (screen: string[]) => screen.find((l) => l.includes("▲"))!.indexOf("▲");

describe("the slider's profile note, as wired", () => {
	it("shows the profile's note for the stop under the marker and asks once per stop", async () => {
		const asked: string[] = [];
		withEffort({ ...effortText, sliderNote: (choice) => (asked.push(choice), `note for ${choice}`) });
		const [medium, high, xhigh] = await walk();
		expect(asked).toEqual(["medium", "high", "xhigh"]);
		expect(medium).toContain("note for medium");
		expect(high).toContain("note for high");
		expect(xhigh).toContain("note for xhigh");
		for (const screen of [high, xhigh]) expect(screen.filter((l) => l.startsWith("note for "))).toHaveLength(1);
	});

	it("keeps the marker where it was with the note, and clips the note at a narrow width", async () => {
		const [withoutNote] = await walk();
		withEffort({ ...effortText, sliderNote: () => "a note ".repeat(30) });
		const [narrow] = await walk(30);
		// The width limit itself is the unit test's (rows before truncateLine); here only that the note reaches the compact layout.
		withEffort({ ...effortText, sliderNote: () => "short note" });
		const [withNote] = await walk();
		expect(markerColumn(withNote)).toBe(markerColumn(withoutNote));
		expect(narrow.some((l) => l.includes("a note a note"))).toBe(true);
	});

	it("draws the slider without a note when the profile's function throws", async () => {
		withEffort({
			...effortText,
			sliderNote: () => {
				throw new Error("profile bug");
			},
		});
		const screens = await walk(120, 3);
		for (const screen of screens) expect(screen.some((l) => l.includes("▲"))).toBe(true);
		expect(screens.join("\n")).not.toContain("profile bug");
		// Reported once, with the reason, though several renders and stops threw.
		const warnings = notified.filter((n) => n.message.includes("profile bug"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0].type).toBe("warning");
	});

	it("shows what the profile in force words for a stop, and nothing when it words nothing", async () => {
		// Runs on One Code's profile (no note) and on the fixture profile (a note for high).
		const wording = effortText.sliderNote?.("high");
		const [, high] = await walk();
		withEffort({ ultracodeOn: "on", ultracodeOff: "off" });
		const [, bare] = await walk();
		if (wording) expect(high).toContain(wording);
		expect(high.length - bare.length).toBe(wording ? 1 : 0);
	});
});
