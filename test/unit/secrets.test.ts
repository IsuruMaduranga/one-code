/**
 * A product's secrets (lib/profile/secrets.ts): the gate refuses the
 * profile's secret files by name in every mode, and registered secret values
 * are replaced in every tool result and task notification.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childExtensionPaths, LAST_CHILD_EXTENSION } from "../../extensions/lib/agents/child-extensions.ts";
import { frameForDelivery } from "../../extensions/lib/notify/notifications.ts";
import { resetProcessStateForTest } from "../../extensions/lib/profile/process-state.ts";
import { setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import { commandNamesSecretFile, isSecretFilePath, MIN_SECRET_LENGTH, redactSecretValues, setSecretValues } from "../../extensions/lib/profile/secrets.ts";
import { decide, type DecideInput } from "../../extensions/lib/rules/matcher.ts";
import { toolResultsText } from "../../extensions/lib/request/tool-results-text.ts";
import secretValuesExtension from "../../extensions/safety/secret-values/index.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { useProfile } from "./helpers/profile.ts";

const use = (secretFiles: string[]) => useProfile({ secretFiles });
const call = (toolName: string, subject: string, extra: Partial<DecideInput> = {}): DecideInput => ({ toolName, subject, cwd: "/work", mode: "default", deny: [], ask: [], allow: [], ...extra });

beforeEach(() => resetProcessStateForTest());
afterEach(() => setActiveProfileForTest(undefined));

describe("secret files, by name", () => {
	const names = new Set(["config.toml"]);

	it("matches a path's last segment, whatever its case or folder", () => {
		expect(isSecretFilePath("Config.toml", names)).toBe(true);
		expect(isSecretFilePath("/work/tests/CONFIG.TOML", names)).toBe(true);
		expect(isSecretFilePath("C:\\work\\Config.toml", names)).toBe(true);
		expect(isSecretFilePath("/work/Config.toml.bak", names)).toBe(false);
		expect(isSecretFilePath("/work/MyConfig.toml", names)).toBe(false);
		expect(isSecretFilePath("/work/Config.toml/", names)).toBe(true);
	});

	it("finds the name in a command, bounded by characters a file name does not continue with", () => {
		for (const command of ["cat Config.toml", "cat ./tests/Config.toml | head", "grep x 'Config.toml'", "cp config.toml /tmp/x", "echo $(<Config.toml)", "sed -n 1p Config.toml;ls"]) {
			expect(commandNamesSecretFile(command, names), command).toBe(true);
		}
		for (const command of ["cat Config.toml.example", "cat MyConfig.toml", "bal run", "cat Config_toml", "ls *.toml"]) {
			expect(commandNamesSecretFile(command, names), command).toBe(false);
		}
	});

	it("is refused by the gate in every mode, before any allow rule, for file tools and shell commands", () => {
		use(["Config.toml"]);
		const secret = { decision: "deny", cause: "secret-file" };
		for (const mode of ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"] as const) {
			expect(decide(call("read", "/work/Config.toml", { mode })), mode).toEqual(secret);
			expect(decide(call("bash", "cat Config.toml", { mode })), mode).toEqual(secret);
		}
		expect(decide(call("write", "tests/Config.toml"))).toEqual(secret);
		expect(decide(call("edit", "/work/pkg/Config.toml"))).toEqual(secret);
		expect(decide(call("powershell", "Get-Content .\\Config.toml"))).toEqual(secret);
		// Through a symlink: the resolved form is checked too.
		expect(decide(call("read", "/work/settings.link", { resolvedSubject: "/work/Config.toml" }))).toEqual(secret);
		expect(decide(call("read", "/work/Config.toml", { allow: [{ raw: "Read", tool: "read" }] }))).toEqual(secret);
		// Other files, and a command that names none, go on as before.
		expect(decide(call("read", "/work/main.bal")).decision).toBe("allow");
		expect(decide(call("bash", "ls")).cause).not.toBe("secret-file");
	});

	it("lets a bash command that only mentions the name run, and refuses one whose words or redirects touch the file", () => {
		use(["Config.toml"]);
		const refused = (command: string) => decide(call("bash", command)).cause === "secret-file";
		for (const command of [
			"echo Config.toml >> .gitignore",
			'git commit -m "Ignore Config.toml"',
			"grep -rl Config.toml docs/",
			"rg -l 'Config.toml' docs/",
			"printf '%s\\n' Config.toml",
			"ls",
		]) {
			expect(refused(command), command).toBe(false);
		}
		for (const command of [
			"cat Config.toml",
			"cat ./tests/Config.toml | head",
			"head -c 20 < Config.toml",
			"echo x > Config.toml",
			"cp Config.toml /tmp/x",
			"base64 Config.toml",
			"mytool --config=Config.toml",
			"grep password Config.toml",
			'bash -c "cat Config.toml"',
			"echo $(cat Config.toml)",
			"git add Config.toml",
			"env X=1 cat Config.toml",
			"./Config.toml",
		]) {
			expect(refused(command), command).toBe(true);
		}
		// PowerShell has no word-level parse here, so the mention still decides.
		expect(decide(call("powershell", "Write-Output Config.toml")).cause).toBe("secret-file");
	});

	it("changes nothing for a profile that lists no secret file", () => {
		expect(decide(call("read", "/work/Config.toml")).decision).toBe("allow");
	});

	it("refuses a name that is a path", () => {
		expect(() => use(["tests/Config.toml"])).toThrow(/secret file "tests\/Config.toml" must be a bare file name/);
		expect(() => use(["*.toml"])).toThrow(/no wildcard/);
	});
});

describe("secret values", () => {
	it("replaces every occurrence, longest first, with the value's name", () => {
		setSecretValues("a", [{ value: "hunter2-token", name: "db_password" }, { value: "hunter2-token-long" }]);
		expect(redactSecretValues("x hunter2-token y hunter2-token-long z hunter2-token")).toBe("x [secret:db_password] y [secret] z [secret:db_password]");
		expect(redactSecretValues("nothing here")).toBe("nothing here");
	});

	it("never rewrites a placeholder it has just written", () => {
		setSecretValues("a", [{ value: "s3cr3tPass!", name: "db_password" }, { value: "db_password", name: "key" }]);
		expect(redactSecretValues("s3cr3tPass! and db_password")).toBe("[secret:db_password] and [secret:key]");
	});

	it("also replaces the JSON-escaped spelling", () => {
		setSecretValues("a", [{ value: 'pa"ss\\word', name: "p" }]);
		expect(redactSecretValues(JSON.stringify({ v: 'pa"ss\\word' }))).toBe('{"v":"[secret:p]"}');
	});

	it("leaves out a value too short to replace safely, and replaces a source's set whole", () => {
		expect(setSecretValues("a", [{ value: "8080" }, { value: "x".repeat(MIN_SECRET_LENGTH) }])).toBe(1);
		expect(redactSecretValues("port 8080 xxxxxx")).toBe("port 8080 [secret]");
		setSecretValues("a", []);
		expect(redactSecretValues("port 8080 xxxxxx")).toBe("port 8080 xxxxxx");
	});

	it("keeps a placeholder name to safe characters", () => {
		setSecretValues("a", [{ value: "secret-value", name: "a]\n<b>" }]);
		expect(redactSecretValues("secret-value")).toBe("[secret:ab]");
	});

	it("leave a task notification's frame", () => {
		setSecretValues("a", [{ value: "hunter2-token", name: "t" }]);
		expect(frameForDelivery("the service printed hunter2-token", "mid-turn")).toBe("the service printed [secret:t]");
	});
});

describe("the secret-values extension", () => {
	const result = async (event: Record<string, unknown>) => {
		const fake = createFakePi();
		secretValuesExtension(fake.pi as never);
		const [handler] = fake.handlers.get("tool_result") ?? [];
		return handler({ type: "tool_result", toolName: "bash", toolCallId: "1", input: {}, isError: false, ...event }, {});
	};

	it("does nothing until a value is registered", async () => {
		expect(await result({ content: [{ type: "text", text: "hunter2-token" }] })).toBeUndefined();
	});

	it("rewrites the text parts and the structured content, and leaves a clean result alone", async () => {
		setSecretValues("a", [{ value: "hunter2-token", name: "t" }]);
		const image = { type: "image", data: "x", mimeType: "image/png" };
		expect(await result({ content: [{ type: "text", text: "a hunter2-token" }, image], structuredContent: { out: ["hunter2-token"], n: 1 } })).toEqual({
			content: [{ type: "text", text: "a [secret:t]" }, image],
			structuredContent: { out: ["[secret:t]"], n: 1 },
		});
		expect(await result({ content: [{ type: "text", text: "clean" }] })).toBeUndefined();
	});

	it("loads last in a child session, after a product's own child extensions", () => {
		const dir = mkdtempSync(join(tmpdir(), "secrets-child-"));
		try {
			mkdirSync(join(dir, "extensions", "bal"), { recursive: true });
			writeFileSync(join(dir, "extensions", "bal", "child.ts"), "");
			useProfile({ childExtensions: ["extensions/bal/child.ts"] }, dir);
			const paths = childExtensionPaths().map((path) => path.replaceAll("\\", "/"));
			expect(paths.at(-1)?.endsWith(`extensions/${LAST_CHILD_EXTENSION}`)).toBe(true);
			expect(paths.at(-2)?.endsWith("extensions/bal/child.ts")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses a file write whose input carries a placeholder, which would replace the real value", async () => {
		const fake = createFakePi();
		secretValuesExtension(fake.pi as never);
		const [gate] = fake.handlers.get("tool_call") ?? [];
		const PLACEHOLDER_REFUSAL = toolResultsText.secretPlaceholderWrite;
		const write = { toolName: "write", input: { path: "settings.json", content: '{"password": "[secret:db_password]"}' } };
		expect(await gate(write, {})).toBeUndefined();
		setSecretValues("a", [{ value: "hunter2-token", name: "db_password" }]);
		expect(await gate(write, {})).toEqual({ block: true, reason: PLACEHOLDER_REFUSAL });
		expect(await gate({ toolName: "edit", input: { path: "a", edits: [{ oldText: "x", newText: "[secret:db_password]" }] } }, {})).toEqual({ block: true, reason: PLACEHOLDER_REFUSAL });
		// Another name's placeholder, a clean write and a non-writing tool pass.
		expect(await gate({ toolName: "write", input: { path: "a", content: "[secret:other]" } }, {})).toBeUndefined();
		expect(await gate({ toolName: "write", input: { path: "a", content: "ok" } }, {})).toBeUndefined();
		expect(await gate({ toolName: "bash", input: { command: "echo '[secret:db_password]'" } }, {})).toBeUndefined();
	});
});
