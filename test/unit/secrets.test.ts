/**
 * A product's secrets (lib/profile/secrets.ts): the gate refuses the
 * profile's secret files by name in every mode, and registered secret values
 * are replaced in every tool result and task notification.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHILD_EXTENSIONS } from "../../extensions/lib/agents/child-extensions.ts";
import { frameForDelivery } from "../../extensions/lib/notify/notifications.ts";
import { resetProcessStateForTest } from "../../extensions/lib/profile/process-state.ts";
import { setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import { commandNamesSecretFile, isSecretFilePath, MIN_SECRET_LENGTH, redactSecretValues, setSecretValues } from "../../extensions/lib/profile/secrets.ts";
import { decide, type DecideInput } from "../../extensions/lib/rules/matcher.ts";
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

	it("changes nothing for a profile that lists no secret file", () => {
		expect(decide(call("read", "/work/Config.toml")).decision).toBe("allow");
	});

	it("refuses a name that is a path", () => {
		expect(() => use(["tests/Config.toml"])).toThrow(/secret file "tests\/Config.toml" must be a bare file name/);
	});
});

describe("secret values", () => {
	it("replaces every occurrence, longest first, with the value's name", () => {
		setSecretValues("a", [{ value: "hunter2-token", name: "db_password" }, { value: "hunter2-token-long" }]);
		expect(redactSecretValues("x hunter2-token y hunter2-token-long z hunter2-token")).toBe("x [secret:db_password] y [secret] z [secret:db_password]");
		expect(redactSecretValues("nothing here")).toBe("nothing here");
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

	it("loads last in a child session, after the tools whose results it rewrites", () => {
		expect(CHILD_EXTENSIONS.at(-1)).toBe("safety/secret-values/index.ts");
	});
});
