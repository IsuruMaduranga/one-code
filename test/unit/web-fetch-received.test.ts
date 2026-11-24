/**
 * web_fetch's transcript row (extensions/tools/web-fetch/received.ts): Claude
 * Code's "Received 2.4KB (200 OK)" in place of the model's framed page.
 */
import { describe, expect, it } from "vitest";
import { receivedLine } from "../../extensions/tools/web-fetch/received.ts";

describe("web_fetch's Received row", () => {
	it("names the status when the tool fetched the page itself", () => {
		expect(receivedLine({ bytes: 2463, status: 200, statusText: "OK" })).toBe("Received 2.4KB (200 OK)");
		expect(receivedLine({ bytes: 312, status: 301 })).toBe("Received 312 bytes (301)");
		expect(receivedLine({ bytes: 900 })).toBe("Received 900 bytes");
	});

	it("leaves a result without a size (an older session) to the tool's text", () => {
		expect(receivedLine(undefined)).toBeUndefined();
		expect(receivedLine({ status: 200 })).toBeUndefined();
	});
});
