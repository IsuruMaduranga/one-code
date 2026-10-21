import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import claudeContextExtension from "../../extensions/claude-context/index.ts";
import { contextBlockFacts, contextFingerprints, FACT_KEYS, gitFingerprint, instructionFacts, resumeFactsNotice } from "../../extensions/lib/context-facts.ts";
import { GIT_SNAPSHOT_OWNER_CHANNEL } from "../../extensions/lib/git-status.ts";
import { toldOf } from "../../extensions/lib/ledger/fold.ts";
import type { ToldFact } from "../../extensions/lib/ledger/records.ts";
import { projectMemoryDir } from "../../extensions/lib/memory.ts";
import { REMINDER_CHANNEL, RENDER_CHANNEL, type RenderRequest } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi, renderRequest } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";


describe("context fact comparisons", () => {
	const files: Parameters<typeof contextFingerprints>[0] = { contextFiles: [{ path: "/CLAUDE.md", content: "rules", descriptor: "rules" }] as never, memoryIndex: { path: "/MEMORY.md", content: "memory" } };
	const told = toldOf([...instructionFacts(contextFingerprints(files)), ...contextBlockFacts("git snapshot", false)]);
	const live = (changes: Partial<typeof files> = {}, git = "git snapshot") => ({ ...contextFingerprints({ ...files, ...changes }), git: gitFingerprint(git) });

	it("reports only changed categories and sends nothing for identical visible facts", () => {
		expect(resumeFactsNotice(told.blocks, false, live())).toBeUndefined();
		expect(resumeFactsNotice(told.blocks, false, live({ memoryIndex: null }))?.text).toBe("Since the saved context snapshot, the memory index changed. The earlier context block reflects the session's start, not the current workspace. Read the current files or run git status if needed.");
		const changed = resumeFactsNotice(told.blocks, false, live({ contextFiles: [], memoryIndex: null }, "new git"));
		expect(changed?.text).toContain("git status changed; the memory index changed; CLAUDE.md-family instructions changed");
		expect(resumeFactsNotice(told.blocks, true, live({}, "new git"))?.text).toContain("reflects the latest compaction");
	});

	it("tells the live fingerprints with the notice, so it is said once", () => {
		const notice = resumeFactsNotice(told.blocks, false, live({}, "new git"));
		expect(notice?.facts).toEqual([{ kind: "block", key: FACT_KEYS.git, hash: gitFingerprint("new git") }]);
	});

	it("says nothing about facts the epoch never told (blocks that predate the facts)", () => {
		expect(resumeFactsNotice(new Map(), false, live({ memoryIndex: null }, "new git"))).toBeUndefined();
	});
});

describe("claude-context's resumed-session check", () => {
	let home: string;
	let cwd: string;
	let memory: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "context-facts-"));
		cwd = join(home, "project");
		mkdirSync(cwd);
		stubHome(home);
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
		execFileSync("git", ["init", "-q", cwd]);
		execFileSync("git", ["-C", cwd, "config", "user.email", "first@example.invalid"]);
		writeFileSync(join(cwd, "CLAUDE.md"), "old instructions\n");
		memory = join(projectMemoryDir(cwd, home), "MEMORY.md");
		mkdirSync(join(memory, ".."), { recursive: true });
		writeFileSync(memory, "old memory\n");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	/** One process: start, first turn, and the facts its live blocks tell. */
	async function open() {
		const fake = createFakePi();
		const facts: ToldFact[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => facts.push(...((data as { facts?: ToldFact[] }).facts ?? [])));
		claudeContextExtension(fake.pi as never);
		fake.events.emit(GIT_SNAPSHOT_OWNER_CHANNEL, {});
		const ctx = createFakeCtx({ cwd, sessionManager: { getSessionId: () => "s", getBranch: () => [] } });
		await fake.fire("session_start", { reason: "startup" }, ctx);
		await fake.fire("turn_start", {}, ctx);
		const render = (facts: readonly ToldFact[]) => renderRequest(fake.events, { facts }).map((block) => block.text);
		return { facts, render, events: fake.events };
	}

	it("says once, on the first request of a resumed process, what changed since the epoch's message 1", async () => {
		const first = await open();
		const told = first.facts;
		writeFileSync(join(cwd, "CLAUDE.md"), "new instructions\n");
		writeFileSync(memory, "new memory\n");
		const resumed = await open();
		const blocks = renderRequest(resumed.events, { facts: told });
		const notices = blocks.map((block) => block.text).filter((text) => text.startsWith("Since the saved context snapshot"));
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("the memory index changed; CLAUDE.md-family instructions changed");
		// The request failed (nothing new told): the retry says it again.
		expect(resumed.render(told).filter((text) => text.startsWith("Since the saved context snapshot"))).toHaveLength(1);
		// Answered: its facts are told, so nothing more.
		const delivered = [...told, ...blocks.flatMap((block) => block.facts ?? [])];
		expect(resumed.render(delivered).filter((text) => text.startsWith("Since the saved context snapshot"))).toHaveLength(0);
	});

	it("tells the absence of instructions, so a CLAUDE.md added between sessions is noticed on resume", async () => {
		rmSync(join(cwd, "CLAUDE.md"));
		rmSync(memory);
		const told = (await open()).facts;
		expect(told.some((fact) => fact.kind === "block" && fact.key === FACT_KEYS.instructions)).toBe(true);
		writeFileSync(join(cwd, "CLAUDE.md"), "new instructions\n");
		const notices = (await open()).render(told).filter((text) => text.startsWith("Since the saved context snapshot"));
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("CLAUDE.md-family instructions changed");
	});

	it("says nothing when nothing changed", async () => {
		const told = (await open()).facts;
		expect((await open()).render(told).filter((text) => text.startsWith("Since the saved context snapshot"))).toEqual([]);
	});
});
