/** Memory grants use actual filesystem containment and never replace file freshness checks. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveForContainment, toAbsolute } from "../../extensions/auto-mode/paths.ts";
import fileTrackerExtension from "../../extensions/file-tracker/index.ts";
import { CHILD_WROTE_CHANNEL } from "../../extensions/lib/child-writes.ts";
import { projectMemoryDir } from "../../extensions/lib/memory.ts";
import { comparablePath, forwardSlashes } from "../../extensions/lib/paths.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { decide, parseRules, type DecideInput } from "../../extensions/permissions/matcher.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

const modes = ["default", "auto", "dontAsk", "acceptEdits"] as const;
const escapedDecisions = { default: "ask", auto: "classify", dontAsk: "deny", acceptEdits: "ask" } as const;
let root: string;
let home: string;
let cwd: string;
let memoryDirPath: string;
let outside: string;

beforeEach(() => {
	root = realpathSync.native(mkdtempSync(join(tmpdir(), "memory-permissions-")));
	home = join(root, "home");
	cwd = join(root, "project");
	outside = join(root, "outside");
	for (const dir of [home, cwd, outside]) mkdirSync(dir);
	stubHome(home);
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
	vi.stubEnv("ONECODE_STATE_DIR", join(home, ".onecode"));
	memoryDirPath = projectMemoryDir(cwd, home);
	mkdirSync(memoryDirPath, { recursive: true });
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

function at(subject: string, mode: DecideInput["mode"] = "auto", extras: Partial<DecideInput> = {}) {
	const absolute = toAbsolute(cwd, subject, home);
	const resolvedSubject = resolveForContainment(absolute);
	expect(resolvedSubject).toBeDefined();
	return decide({
		toolName: "write", subject, cwd, mode,
		deny: [], ask: [], allow: [], memoryDirPath,
		resolvedCwd: resolveForContainment(cwd), resolvedSubject,
		...extras,
	});
}

function escapeSubject(kind: string): string {
	switch (kind) {
		case "parent traversal": return `${memoryDirPath}${sep}..${sep}escaped.md`;
		case "absolute outside path": return join(outside, "fact.md");
		case "sibling prefix": {
			const sibling = `${memoryDirPath}-other`;
			mkdirSync(sibling);
			return join(sibling, "fact.md");
		}
		case "existing symlink": {
			const target = join(outside, "existing.md");
			writeFileSync(target, "OUTSIDE\n");
			const alias = join(memoryDirPath, "existing-link.md");
			symlinkSync(target, alias);
			return alias;
		}
		case "dangling symlink": {
			const alias = join(memoryDirPath, "dangling-link.md");
			symlinkSync(join(outside, "missing.md"), alias);
			return alias;
		}
		case "symlinked parent": {
			const alias = join(memoryDirPath, "linked-folder");
			symlinkSync(outside, alias, "dir");
			return join(alias, "missing.md");
		}
		default: throw new Error(`Unknown escape fixture: ${kind}`);
	}
}

describe("memory directory permission containment", () => {
	it.each(modes)("allows ordinary memory writes and edits in %s mode", (mode) => {
		for (const toolName of ["write", "edit"]) {
			for (const subject of [join(memoryDirPath, "MEMORY.md"), join(memoryDirPath, "topics", "user.md")]) {
				expect(at(subject, mode, { toolName })).toMatchObject({ decision: "allow", cause: "memory-dir" });
			}
		}
	});

	it.each(["parent traversal", "absolute outside path", "sibling prefix", "existing symlink", "dangling symlink", "symlinked parent"])(
		"does not grant memory access to a %s", (kind) => {
			const subject = escapeSubject(kind);
			for (const mode of modes) {
				const result = at(subject, mode);
				expect(result.decision, mode).toBe(escapedDecisions[mode]);
				expect(result.cause, mode).not.toBe("memory-dir");
			}
		},
	);

	it("resolves existing and dangling aliases to their actual outside targets", () => {
		for (const kind of ["existing symlink", "dangling symlink"]) {
			const subject = escapeSubject(kind);
			const target = join(outside, kind === "existing symlink" ? "existing.md" : "missing.md");
			expect(resolveForContainment(subject)).toBe(comparablePath(target));
			expect(at(subject)).not.toMatchObject({ decision: "allow", cause: "memory-dir" });
		}
	});

	it("permits an alias whose resolved target is genuinely inside memory", () => {
		const target = join(memoryDirPath, "user.md");
		writeFileSync(target, "USER MEMORY\n");
		const alias = join(outside, "memory-alias.md");
		symlinkSync(target, alias);
		expect(resolveForContainment(alias)).toBe(comparablePath(target));
		expect(at(alias)).toMatchObject({ decision: "allow", cause: "memory-dir" });
	});

	it.skipIf(process.platform === "win32").each(modes)("does not grant a literal backslash sibling memory access in %s mode", (mode) => {
		const subject = `${memoryDirPath}\\outside.md`;
		writeFileSync(subject, "OUTSIDE MEMORY\n");
		expect(at(subject, mode).decision).toBe(escapedDecisions[mode]);
		expect(at(subject, mode).cause).not.toBe("memory-dir");
	});

	it("uses the running platform's semantics for Windows separators", () => {
		const native = join(memoryDirPath, "user.md");
		const windowsSpelling = native.replaceAll("/", "\\");
		if (process.platform === "win32") {
			expect(resolveForContainment(toAbsolute(cwd, windowsSpelling, home))).toBe(comparablePath(native));
			expect(at(windowsSpelling)).toMatchObject({ decision: "allow", cause: "memory-dir" });
		} else {
			// A backslash is a filename character here, not a Windows path separator.
			expect(resolveForContainment(toAbsolute(cwd, windowsSpelling, home))).toBe(comparablePath(resolve(cwd, windowsSpelling)));
			expect(at(windowsSpelling).cause).not.toBe("memory-dir");
		}
		const windowsEscape = `${memoryDirPath.replaceAll("/", "\\")}\\..\\escaped.md`;
		expect(at(windowsEscape).cause).not.toBe("memory-dir");
	});

	it.each(modes)("keeps explicit deny and ask rules ahead of memory grants in %s mode", (mode) => {
		const subject = join(memoryDirPath, "user.md");
		const rules = parseRules([`Write(${forwardSlashes(memoryDirPath)}/**)`]);
		expect(at(subject, mode, { deny: rules, ask: rules, allow: rules })).toMatchObject({ decision: "deny", cause: "rule" });
		const asked = at(subject, mode, { ask: rules, allow: rules });
		expect(asked.decision).toBe(mode === "dontAsk" ? "deny" : "ask");
		expect(asked.cause).not.toBe("memory-dir");
	});

	it("does not bypass plan mode or grant memory privileges to shell commands", () => {
		expect(at(join(memoryDirPath, "user.md"), "plan")).toMatchObject({ decision: "deny", cause: "plan-mode" });
		const result = decide({
			toolName: "bash", subject: `touch '${forwardSlashes(join(memoryDirPath, "user.md"))}'`, cwd,
			mode: "auto", deny: [], ask: [], allow: [], memoryDirPath,
		});
		expect(result.decision).toBe("classify");
		expect(result.cause).not.toBe("memory-dir");
	});
});

describe("memory freshness across sessions", () => {
	it.each(["independent sessions", "parent and child"])("rejects a stale sequential memory write from %s", async (relationship) => {
		const path = join(memoryDirPath, "user.md");
		writeFileSync(path, "user: v1\n");
		const sessions = await Promise.all(["parent", "child"].map(async (id) => {
			const fake = createFakePi();
			fileTrackerExtension(fake.pi as never);
			const ctx = createFakeCtx({ cwd, sessionManager: { getSessionId: () => id, getBranch: () => [] } });
			await fake.fire("session_start", { reason: "startup" }, ctx);
			await fake.fire("tool_result", { toolName: "read", toolCallId: `${id}-read`, input: { path }, isError: false }, ctx);
			return { fake, ctx };
		}));
		const [parent, child] = sessions;
		const write = (id: string) => ({ toolName: "write", toolCallId: `${id}-write`, input: { path, content: "user: v3\n" } });
		// Both calls pass permissions, but only the session with current read state may write.
		expect(at(path)).toMatchObject({ decision: "allow", cause: "memory-dir" });
		expect(await child.fake.fireOne("tool_call", write("child"), child.ctx)).toBeUndefined();
		writeFileSync(path, "user: v2\n");
		await child.fake.fire("tool_result", { ...write("child"), isError: false }, child.ctx);
		expect(await child.fake.fireOne("tool_call", write("child-next"), child.ctx)).toBeUndefined();

		if (relationship === "parent and child") {
			const reminders: string[] = [];
			parent.fake.events.on(REMINDER_CHANNEL, (data) => reminders.push((data as { text: string }).text));
			parent.fake.events.emit(CHILD_WROTE_CHANNEL, { path, agent: "memory child" });
			await parent.fake.fire("tool_execution_end", { toolName: "Agent", toolCallId: "child-run", isError: false }, parent.ctx);
			expect(reminders.join("\n")).toContain('was changed by the agent "memory child"');
		}
		const stale = await parent.fake.fireOne<{ block?: boolean; reason?: string }>("tool_call", write("parent"), parent.ctx);
		expect(stale?.block).toBe(true);
		expect(stale?.reason).toContain("has changed on disk");
		expect(readFileSync(path, "utf8")).toBe("user: v2\n");
		await parent.fake.fire("tool_result", { toolName: "read", toolCallId: "parent-reread", input: { path }, isError: false }, parent.ctx);
		expect(await parent.fake.fireOne("tool_call", write("parent-retry"), parent.ctx)).toBeUndefined();
	});
});
