import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * app/bin.mjs patches two pi prototypes and reads five unexported renderer
 * fields (the clean-exit path and the suppressed "Operation aborted" line). A
 * pi pin bump that renames any of them would revert that UX silently, so this
 * pins their presence in the installed build. On failure: re-verify the patch
 * against the new pi source and update both bin.mjs and this list.
 */
// pi's exports map blocks both a CJS main and "./package.json", so locate the
// installed package by path from this repo's node_modules (the devDep pin).
const piRoot = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/", import.meta.url));
const piDist = join(piRoot, "dist");

describe("app/bin.mjs pi-internal patch points (A3)", () => {
	it("InteractiveMode.prototype.stopInteractiveTui and AssistantMessageComponent.prototype.updateContent exist", async () => {
		const pi = (await import("@earendil-works/pi-coding-agent")) as unknown as {
			InteractiveMode: { prototype: Record<string, unknown> };
			AssistantMessageComponent: { prototype: Record<string, unknown> };
		};
		expect(typeof pi.InteractiveMode.prototype.stopInteractiveTui).toBe("function");
		expect(typeof pi.AssistantMessageComponent.prototype.updateContent).toBe("function");
	});

	it("the main-screen renderer still carries the fields the clean-exit patch reads", () => {
		const tuiDist = join(piRoot, "node_modules", "@earendil-works", "pi-tui", "dist");
		// The regular-mode renderer (tui-main-screen.js) holds the scrollback fields;
		// the overlay API lives on the shared TUI class (tui.js).
		const renderer = readFileSync(join(tuiDist, "tui-main-screen.js"), "utf8") + readFileSync(join(tuiDist, "tui.js"), "utf8");
		for (const field of ["previousLines", "hardwareCursorRow", "previousViewportTop", "hasOverlayEntries", "hideOverlay", "deleteKittyImages", "previousKittyImageIds"]) {
			expect(renderer, field).toContain(field);
		}
	});

	it("stopInteractiveTui still switches modes the way the patch assumes (fullscreen → regular repaint)", () => {
		const source = readFileSync(join(piDist, "modes", "interactive", "interactive-mode.js"), "utf8");
		expect(source).toContain("stopInteractiveTui");
		expect(source).toContain(`switchTuiMode("regular"`);
	});

	it("updateContent still keys the abort line off stopReason", () => {
		const source = readFileSync(join(piDist, "modes", "interactive", "components", "assistant-message.js"), "utf8");
		expect(source).toContain("updateContent");
		expect(source).toContain('"aborted"');
	});
});
