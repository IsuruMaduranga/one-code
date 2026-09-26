import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCallbackServer } from "../../extensions/mcp/oauth/callback.ts";
import { readDisabledMcpServers, setMcpServerDisabled } from "../../extensions/lib/mcp-overrides.ts";
import { hasStoredTokens, readAuth, updateAuth, writeAuth } from "../../extensions/mcp/oauth/store.ts";
import { McpOAuthProvider } from "../../extensions/mcp/oauth/provider.ts";

let home: string;
const env: NodeJS.ProcessEnv = {}; // no ONECODE_STATE_DIR → <home>/.onecode
const server = (name: string, url = "https://mcp.example.com/mcp", headers?: Record<string, string>) => ({ name, url, headers });
const srv = server("srv");

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "onecode-mcp-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("mcp-overrides", () => {
	const cwd = "/some/project";

	it("has no disabled servers by default", () => {
		expect(readDisabledMcpServers(cwd, home, env).size).toBe(0);
	});

	it("persists a per-project disable and reads it back", () => {
		setMcpServerDisabled("github", true, "project", cwd, home, env);
		expect([...readDisabledMcpServers(cwd, home, env)]).toEqual(["github"]);
	});

	it("persists a user-scope disable independent of project", () => {
		setMcpServerDisabled("deepwiki", true, "user", cwd, home, env);
		// A different project still sees a user-scope disable.
		expect(readDisabledMcpServers("/other/project", home, env).has("deepwiki")).toBe(true);
	});

	it("merges user and project scopes and supports re-enable", () => {
		setMcpServerDisabled("a", true, "user", cwd, home, env);
		setMcpServerDisabled("b", true, "project", cwd, home, env);
		expect(readDisabledMcpServers(cwd, home, env)).toEqual(new Set(["a", "b"]));
		setMcpServerDisabled("a", false, "user", cwd, home, env);
		expect(readDisabledMcpServers(cwd, home, env)).toEqual(new Set(["b"]));
	});
});

describe("oauth store", () => {
	it("returns an empty record for an unknown server", () => {
		expect(readAuth(server("nope"), home, env)).toEqual({});
		expect(hasStoredTokens(server("nope"), home, env)).toBe(false);
	});

	it("writes, merges, and reports stored tokens", () => {
		writeAuth(server("srv"), { codeVerifier: "v1" }, home, env);
		updateAuth(server("srv"), { tokens: { access_token: "tok", token_type: "bearer" } }, home, env);
		const stored = readAuth(server("srv"), home, env);
		expect(stored.codeVerifier).toBe("v1"); // preserved by the merge
		expect(stored.tokens?.access_token).toBe("tok");
		expect(hasStoredTokens(server("srv"), home, env)).toBe(true);
	});

	it("binds a record to the server's URL and headers, not its name", () => {
		const user = server("github", "https://api.githubcopilot.com/mcp/");
		writeAuth(user, { tokens: { access_token: "user-token", token_type: "bearer" } }, home, env);
		expect(hasStoredTokens(user, home, env)).toBe(true);
		// A project server that reuses the name at another URL gets nothing.
		const shadow = server("github", "https://evil.example.com/mcp");
		expect(hasStoredTokens(shadow, home, env)).toBe(false);
		expect(readAuth(shadow, home, env)).toEqual({});
		// Nor at the same URL with other headers.
		expect(hasStoredTokens(server("github", user.url, { "X-Tenant": "other" }), home, env)).toBe(false);
		// Header order does not change the key.
		const withHeaders = server("h", "https://h.example.com/mcp", { A: "1", B: "2" });
		writeAuth(withHeaders, { codeVerifier: "v" }, home, env);
		expect(readAuth(server("h", withHeaders.url, { B: "2", A: "1" }), home, env).codeVerifier).toBe("v");
	});

	it("never offers a record whose recorded URL differs from the server's", () => {
		const a = server("s", "https://a.example.com/mcp");
		writeAuth(a, { tokens: { access_token: "t", token_type: "bearer" } }, home, env);
		const file = readdirSync(join(home, ".onecode", "mcp-auth"))[0];
		const path = join(home, ".onecode", "mcp-auth", file);
		writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), serverUrl: "https://b.example.com/mcp" }));
		expect(hasStoredTokens(a, home, env)).toBe(false);
	});

	it("does not read a record written under the old name-only key", () => {
		mkdirSync(join(home, ".onecode", "mcp-auth"), { recursive: true });
		writeFileSync(join(home, ".onecode", "mcp-auth", "github-0badc0de.json"), JSON.stringify({ tokens: { access_token: "old", token_type: "bearer" } }));
		expect(hasStoredTokens(server("github"), home, env)).toBe(false);
	});

	it("sanitizes the server name into a distinct file (no collision/escape)", () => {
		writeAuth(server("a/b"), { codeVerifier: "x" }, home, env);
		writeAuth(server("a_b"), { codeVerifier: "y" }, home, env);
		// Distinct slugs — the second must not overwrite the first.
		expect(readAuth(server("a/b"), home, env).codeVerifier).toBe("x");
		expect(readAuth(server("a_b"), home, env).codeVerifier).toBe("y");
	});
});

describe("startCallbackServer", () => {
	it("delivers a code that arrives BEFORE waitForCode is called (no lost redirect)", async () => {
		const cb = await startCallbackServer();
		try {
			// Redirect lands first (an IdP with a live session redirects instantly).
			const res = await fetch(`${cb.redirectUrl}?code=abc123`);
			expect(res.status).toBe(200);
			// waitForCode is only called afterwards — must still resolve, not time out.
			await expect(cb.waitForCode(1000)).resolves.toMatchObject({ code: "abc123" });
		} finally {
			cb.close();
		}
	});

	it("delivers a code that arrives after waitForCode is waiting", async () => {
		const cb = await startCallbackServer();
		try {
			const pending = cb.waitForCode(2000);
			await fetch(`${cb.redirectUrl}?code=later`);
			await expect(pending).resolves.toMatchObject({ code: "later" });
		} finally {
			cb.close();
		}
	});

	it("rejects on an error redirect", async () => {
		const cb = await startCallbackServer();
		try {
			await fetch(`${cb.redirectUrl}?error=access_denied&error_description=nope`);
			await expect(cb.waitForCode(1000)).rejects.toThrow(/access_denied|nope/);
		} finally {
			cb.close();
		}
	});
});

describe("McpOAuthProvider", () => {
	const make = (opts: { redirectUrl?: string; opener?: (url: URL) => void } = {}) =>
		new McpOAuthProvider({
			server: srv,
			redirectUrl: opts.redirectUrl,
			openAuthorization: opts.opener,
			home,
			env,
		});

	it("exposes public-client metadata with the loopback redirect", () => {
		const provider = make({ redirectUrl: "http://127.0.0.1:5000/callback" });
		const meta = provider.clientMetadata;
		expect(meta.redirect_uris).toEqual(["http://127.0.0.1:5000/callback"]);
		expect(meta.token_endpoint_auth_method).toBe("none");
		expect(meta.grant_types).toContain("authorization_code");
	});

	it("round-trips tokens, client info, and the code verifier through the store", () => {
		const provider = make({ redirectUrl: "http://127.0.0.1:5000/callback" });
		provider.saveCodeVerifier("verifier");
		expect(provider.codeVerifier()).toBe("verifier");
		provider.saveTokens({ access_token: "tok", token_type: "bearer" });
		expect(provider.tokens()?.access_token).toBe("tok");
		provider.saveClientInformation({ client_id: "cid" });
		expect(provider.clientInformation()?.client_id).toBe("cid");
		// clientMetadata persists once client info is saved, so a later silent
		// provider (no redirectUrl) still reports the registered redirect.
		expect(make().clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:5000/callback"]);
	});

	it("throws when asked to redirect without an opener (silent reconnect)", () => {
		expect(() => make().redirectToAuthorization(new URL("https://auth.example/authorize"))).toThrow(/needs authentication/);
	});

	it("opens the authorization URL when an opener is provided", () => {
		let opened: URL | undefined;
		make({ opener: (url) => (opened = url) }).redirectToAuthorization(new URL("https://auth.example/authorize"));
		expect(opened?.href).toBe("https://auth.example/authorize");
	});

	it("invalidates credentials by scope", () => {
		const provider = make();
		provider.saveTokens({ access_token: "tok", token_type: "bearer" });
		provider.saveCodeVerifier("v");
		provider.invalidateCredentials("tokens");
		expect(provider.tokens()).toBeUndefined();
		expect(readAuth(server("srv"), home, env).codeVerifier).toBe("v"); // untouched
		provider.invalidateCredentials("all");
		expect(readAuth(server("srv"), home, env)).toEqual({ serverUrl: srv.url });
	});
});

describe("OAuth state (M9)", () => {
	it("issues one state per provider and echoes it back through the callback", async () => {
		const provider = new McpOAuthProvider({ server: srv, redirectUrl: "http://127.0.0.1:1/callback", home, env });
		const state = provider.state();
		expect(state).toMatch(/^[0-9a-f]{32}$/);
		expect(provider.state()).toBe(state);
		expect(provider.expectedState()).toBe(state);
		const cb = await startCallbackServer();
		try {
			await fetch(`${cb.redirectUrl}?code=c1&state=${state}`);
			await expect(cb.waitForCode(1000)).resolves.toEqual({ code: "c1", state });
		} finally {
			cb.close();
		}
	});
});

