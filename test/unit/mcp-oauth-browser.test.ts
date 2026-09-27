/**
 * The OAuth browser opener's argv. An authorization URL carries `&`-joined
 * parameters and comes from the server's metadata, so on Windows it must reach
 * the opener as one argument with no `cmd.exe` parse in between, and a
 * non-web scheme is never handed to the desktop's handler.
 */
import { describe, expect, it } from "vitest";
import { system32Path } from "../../extensions/lib/paths.ts";
import { browserOpenPlan, openBrowser, refuseAuthorizationUrl } from "../../extensions/mcp/oauth/browser.ts";

const AUTH_URL = "https://auth.example.com/authorize?response_type=code&client_id=abc&code_challenge=xyz&redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2Fcallback&state=s1";

describe("browserOpenPlan", () => {
	it("hands the whole URL to rundll32 on Windows, never to cmd", () => {
		const plan = browserOpenPlan(AUTH_URL, "win32", { SystemRoot: "C:\\Windows" });
		expect(plan).toEqual({ command: system32Path("rundll32.exe", { SystemRoot: "C:\\Windows" }), args: ["url.dll,FileProtocolHandler", AUTH_URL] });
		if ("refused" in plan) throw new Error("refused");
		expect(plan.command.toLowerCase()).not.toContain("cmd");
		expect(plan.args.at(-1)).toBe(AUTH_URL);
		expect(plan.args.some((arg) => arg === "/c" || arg === "start")).toBe(false);
	});

	it("keeps a URL with cmd metacharacters intact as the last argument", () => {
		const hostile = "https://auth.example.com/authorize?x=1&calc.exe&y=%PATH%^|more";
		const plan = browserOpenPlan(hostile, "win32", { SystemRoot: "C:\\Windows" });
		expect("refused" in plan ? undefined : plan.args).toEqual(["url.dll,FileProtocolHandler", hostile]);
	});

	it("uses open and xdg-open elsewhere", () => {
		expect(browserOpenPlan(AUTH_URL, "darwin")).toEqual({ command: "open", args: [AUTH_URL] });
		expect(browserOpenPlan(AUTH_URL, "linux")).toEqual({ command: "xdg-open", args: [AUTH_URL] });
	});

	it("refuses every scheme but https, and http on a loopback host", () => {
		for (const url of ["file:///etc/passwd", "ms-settings:privacy", "http://auth.example.com/authorize", "smb://host/share", "not a url"]) {
			for (const platform of ["win32", "darwin", "linux"] as const) {
				expect(browserOpenPlan(url, platform), `${platform} ${url}`).toHaveProperty("refused");
			}
		}
		for (const url of ["http://localhost:8080/authorize", "http://127.0.0.1/authorize", "http://[::1]:9/authorize"]) {
			expect(refuseAuthorizationUrl(url), url).toBeUndefined();
		}
	});

	it("fails loud instead of opening a refused URL", () => {
		expect(() => openBrowser("file:///etc/passwd")).toThrow(/refusing to open the authorization URL/);
	});
});
