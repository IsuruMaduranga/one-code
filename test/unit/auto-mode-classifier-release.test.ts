import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-ai")>()),
	cleanupSessionResources: vi.fn(),
}));
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { classifierCacheKey, releaseClassifierResources } from "../../extensions/auto-mode/classifier.ts";
import { releaseSideCalls } from "../../extensions/lib/side-call-run.ts";
import { SIDE_CALL_KINDS } from "../../extensions/lib/side-call-usage.ts";

// On openai-codex the classifier's key is pi-ai's sessionId, which keeps a
// WebSocket and a 5-minute idle timer alive past the session (findings §59).
describe("releaseClassifierResources", () => {
	it("closes what pi-ai holds under the session's classifier key", () => {
		releaseClassifierResources("s1");
		expect(cleanupSessionResources).toHaveBeenCalledWith("s1:auto-mode");
		expect(classifierCacheKey("s1")).toBe("s1:auto-mode");
	});
});

// btw, recap and the web_fetch reader key their calls `<session id>:<kind>`.
describe("releaseSideCalls", () => {
	it("closes every side-call kind's key for the session", () => {
		releaseSideCalls("s2");
		for (const kind of SIDE_CALL_KINDS) expect(cleanupSessionResources).toHaveBeenCalledWith(`s2:${kind}`);
	});
});
