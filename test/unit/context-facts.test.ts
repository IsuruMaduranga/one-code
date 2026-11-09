import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import claudeContextExtension from "../../extensions/claude-context/index.ts";
import { contextBlockFacts, contextFingerprints, FACT_KEYS, gitFingerprint, instructionFacts, resumeFactsNotice } from "../../extensions/claude-context/context-facts.ts";
import { GIT_SNAPSHOT_OWNER_CHANNEL } from "../../extensions/lib/context/git-status.ts";
import { toldOf } from "../../extensions/lib/request/ledger/fold.ts";
import type { ToldFact } from "../../extensions/lib/request/ledger/records.ts";
import { projectMemoryDir } from "../../extensions/lib/context/memory.ts";
import { requireText } from "../../extensions/lib/profile/profile.ts";
import { REMINDER_CHANNEL, RENDER_CHANNEL, type RenderRequest } from "../../extensions/lib/request/reminders.ts";
import { createFakeCtx, createFakePi, renderRequest } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

/** The profile's notice for what changed since the saved context snapshot. */
const changedNotice = (changes: Array<"git" | "memory" | "instructions">, atCompaction = false) => requireText("context").changedSinceSnapshot({ changes, atCompaction });

describe("context fact comparisons", () => {
	const files: Parameters<typeof contextFingerprints>[0] = { contextFiles: [{ path: "/CLAUDE.md", content: "rules", descriptor: "rules" }] as never, memoryIndex: { path: "/MEMORY.md", content: "memory" } };
	const told = toldOf([...instructionFacts(contextFingerprints(files)), ...contextBlockFacts("git snapshot", false)]);
	const live = (changes: Partial<typeof files> = {}, git = "git snapshot") => ({ ...contextFingerprints({ ...files, ...changes }), git: gitFingerprint(git) });

	it("reports only changed categories and sends nothing for identical visible facts", () => {
		expect(resumeFactsNotice(told.blocks, false, live())).toBeUndefined();
		expect(resumeFactsNotice(told.blocks, false, live({ memoryIndex: null }))?.text).toBe(changedNotice(["memory"]));
		const changed = resumeFactsNotice(told.blocks, false, live({ contextFiles: [], memoryIndex: null }, "new git"));
		expect(changed?.text).toBe(changedNotice(["git", "memory", "instructions"]));
		expect(resumeFactsNotice(told.blocks, true, live({}, "new git"))?.text).toBe(changedNotice(["git"], true));
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
	/** Any change notice, whichever changes it names. */
	const isNotice = (text: string) =>
		(["git", "memory", "instructions"] as const)
			.flatMap((a, i, all) => [[a], ...all.slice(i + 1).map((b) => [a, b]), ...(i === 0 ? [[...all]] : [])])
			.some((changes) => text === changedNotice(changes as Array<"git" | "memory" | "instructions">));
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
		writeFileSync(join(cwd, "AGENTS.md"), "old instructions\n");
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
		writeFileSync(join(cwd, "AGENTS.md"), "new instructions\n");
		writeFileSync(memory, "new memory\n");
		const resumed = await open();
		const blocks = renderRequest(resumed.events, { facts: told });
		const notice = changedNotice(["memory", "instructions"]);
		expect(blocks.map((block) => block.text).filter((text) => text === notice)).toHaveLength(1);
		// The request failed (nothing new told): the retry says it again.
		expect(resumed.render(told).filter((text) => text === notice)).toHaveLength(1);
		// Answered: its facts are told, so nothing more.
		const delivered = [...told, ...blocks.flatMap((block) => block.facts ?? [])];
		expect(resumed.render(delivered).filter(isNotice)).toHaveLength(0);
	});

	it("tells the absence of instructions, so an instructions file added between sessions is noticed on resume", async () => {
		rmSync(join(cwd, "AGENTS.md"));
		rmSync(memory);
		const told = (await open()).facts;
		expect(told.some((fact) => fact.kind === "block" && fact.key === FACT_KEYS.instructions)).toBe(true);
		writeFileSync(join(cwd, "AGENTS.md"), "new instructions\n");
		// Adding the file also shows in git status.
		expect((await open()).render(told).filter(isNotice)).toEqual([changedNotice(["git", "instructions"])]);
	});

	it("says nothing when nothing changed", async () => {
		const told = (await open()).facts;
		expect((await open()).render(told).filter(isNotice)).toEqual([]);
	});
});
