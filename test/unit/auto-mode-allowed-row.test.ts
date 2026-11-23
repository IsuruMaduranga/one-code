/**
 * Claude Code's dim `⎿ Allowed by auto mode` row (findings §103): the
 * permissions extension remembers the calls the classifier itself allowed and
 * adds the row under their results through its tool-renderer resolver. A
 * fast-path allow, an error and a call it never saw get none.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import permissionsExtension from "../../extensions/safety/permissions/index.ts";
import { classify } from "../../extensions/safety/permissions/auto-mode/classifier.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";
import { productStateDir } from "../../extensions/lib/profile/brand.mjs";
import { plainTheme } from "./helpers/plain-theme.ts";

vi.mock("../../extensions/safety/permissions/auto-mode/classifier.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../extensions/safety/permissions/auto-mode/classifier.ts")>()),
	classify: vi.fn(async () => ({ decision: "allow", reason: "", tier: "allow" })),
}));

describe("the auto-mode approval row", () => {
	let fake: FakePi;
	let home: string;
	let ctx: Record<string, unknown>;

	beforeEach(async () => {
		home = mkdtempSync(join(tmpdir(), "auto-allowed-row-"));
		const cwd = join(home, "project");
		mkdirSync(cwd);
		stubHome(home);
		vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "agent"));
		mkdirSync(productStateDir());
		fake = createFakePi();
		permissionsExtension(fake.pi as never);
		ctx = createFakeCtx({
			cwd,
			model: { provider: "openai-codex", id: "gpt-6-astra" },
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => join(home, "sessions"), getBranch: () => [] },
		});
		await fake.fire("session_start", { reason: "startup" }, ctx);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	/** What the result of call `toolCallId` draws, given a tool whose own renderer draws `RESULT`. */
	const drawn = (toolCallId: string, isError = false) => {
		type Renderers = { renderResult: (...args: unknown[]) => { render: (width: number) => string[] } };
		const own: Renderers & { renderShell: string } = { renderShell: "self", renderResult: () => ({ render: () => ["RESULT"] }) };
		const resolved = fake.toolRendererResolvers.reduceRight<() => unknown>((next, resolver) => () => resolver("bash", next), () => own)() as Renderers;
		return resolved.renderResult({ content: [] }, { expanded: false, isPartial: false }, plainTheme, { toolCallId, isError }).render(80);
	};

	it("draws the row under a call the classifier allowed, and only on success", async () => {
		const outcome = await fake.fireOne<{ block?: boolean }>("tool_call", { toolName: "bash", input: { command: "git push origin main" }, toolCallId: "t1" }, ctx);
		expect(outcome?.block).toBeFalsy();
		expect(classify).toHaveBeenCalled();
		expect(drawn("t1")).toEqual(["RESULT", "  ⎿  Allowed by auto mode"]);
		expect(drawn("t1", true)).toEqual(["RESULT"]);
	});

	it("draws nothing extra for a pre-gate allow or a call it never judged", async () => {
		// On a cheap model decide() leaves an in-project write to the classifier
		// step, whose containment pre-gate clears it without asking the model.
		ctx.model = { provider: "openai-codex", id: "gpt-6-luna" };
		vi.mocked(classify).mockClear();
		const outcome = await fake.fireOne<{ block?: boolean }>("tool_call", { toolName: "write", input: { path: "notes.txt", content: "x" }, toolCallId: "t2" }, ctx);
		expect(outcome?.block).toBeFalsy();
		expect(classify).not.toHaveBeenCalled();
		expect(drawn("t2")).toEqual(["RESULT"]);
		expect(drawn("never-seen")).toEqual(["RESULT"]);
	});
});
