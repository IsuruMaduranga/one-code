/**
 * The epoch rule covers every input that shapes the head (lifecycle-grid-hunt
 * round 3, R3-M4, M5, M10): the login, pi-ai's effort-marker regime, and a
 * tool's live input schema.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestIdentity } from "../../extensions/lib/anthropic-auth.ts";
import { foldBranch } from "../../extensions/lib/ledger/fold.ts";
import { makeRecord, RECORD, type RequestIdentity } from "../../extensions/lib/ledger/records.ts";
import { mergeDeclarations } from "../../extensions/lib/ledger/wire.ts";
import { LedgerSim } from "./helpers/ledger-sim.ts";

const sonnet = { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-5-5", reasoning: true, compat: { supportsMidConvoEffort: true } };
const gpt = { api: "openai-responses", provider: "openai", id: "gpt-6.1-sol", baseUrl: "https://api.openai.com/v1" };

describe("the request identity", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "identity-"));
		mkdirSync(join(dir, "agent"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});
	const login = (auth: unknown, mtime: number) => {
		const path = join(dir, "agent", "auth.json");
		writeFileSync(path, JSON.stringify(auth));
		utimesSync(path, mtime, mtime);
	};

	it("tells Sign in with ChatGPT from an API key on OpenAI's own endpoint", () => {
		login({ openai: { type: "api_key", key: "sk-1" } }, 1000);
		expect(requestIdentity(gpt)?.auth).toBe("key");
		login({ openai: { type: "oauth", access: "a", refresh: "r" } }, 2000);
		expect(requestIdentity(gpt)?.auth).toBe("chatgpt");
		expect(requestIdentity({ ...gpt, baseUrl: "https://gateway.example/v1" })?.auth).toBe("key");
	});

	it("carries pi-ai's effort-marker regime on a model that takes the markers, and nothing elsewhere", () => {
		expect(requestIdentity(sonnet, "high")?.effortMarkers).toBe(true);
		expect(requestIdentity(sonnet, "off")?.effortMarkers).toBe(false);
		expect(requestIdentity({ ...sonnet, compat: {} }, "off")).not.toHaveProperty("effortMarkers");
	});

	it("opens an epoch when thinking turns off where pi marks effort per message", () => {
		const on = requestIdentity(sonnet, "high") as RequestIdentity;
		const branch = [
			{ type: "custom", id: "r1", parentId: null, customType: RECORD.request, data: makeRecord("request", "test", { identity: on, keep: 0, append: [], head: "h", blobs: { h: {} }, consumed: [], covers: { count: 1, role: "user", timestamp: 1 } }) },
			{ type: "message", id: "a1", parentId: "r1", message: { role: "assistant" } },
		];
		expect(foldBranch(branch, on).opensEpoch).toBe(false);
		expect(foldBranch(branch, requestIdentity(sonnet, "off")).cause).toBe("effort");
	});
});

describe("mergeDeclarations", () => {
	const tool = (description: string, properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ name: "lookup", description, input_schema: { type: "object", properties }, ...extra });

	it("keeps the recorded bytes for a tool whose text or deferral changed", () => {
		const recorded = tool("old text", { id: { type: "string" } }, { defer_loading: true });
		const live = tool("new text", { id: { type: "string" } });
		expect(mergeDeclarations([recorded], [live])).toEqual([recorded]);
	});

	it("takes the live declaration, with the recorded deferral, for a tool whose input schema changed", () => {
		const recorded = tool("v1", { id: { type: "string" } }, { defer_loading: true });
		const live = tool("v2", { id: { type: "string" }, project: { type: "string" } });
		expect(mergeDeclarations([recorded], [live])).toEqual([{ ...live, defer_loading: true }]);
	});
});

// Transition probe, deepseek-v4-flash to qwen3.6-27b and back: pi's tools come
// from the transcript's tool deltas, where a changed definition is a removal
// and an addition, so the tier-dependent bash moved to the end at the hop and
// stayed there on the hop back, which read 0 of 20,306 cached.
describe("the tools order at an epoch", () => {
	const names = (payload: { tools: { name: string }[] }) => payload.tools.map((tool) => tool.name);
	/** A declaration whose text follows the tier, as bash's does. */
	const tool = (name: string, description?: string): { name: string } => (description ? { name, description } : { name }) as { name: string };

	it("follows the order the branch first declared, so a hop back renders the first request's tools again", async () => {
		const s = new LedgerSim();
		// `deferred` stands for a tool the hop model does not declare (pi's deferred placeholder on a model without tool references).
		s.tools = [{ name: "read" }, tool("bash", "cheap"), { name: "edit" }, { name: "deferred" }];
		s.message("user", "one");
		const first = await s.request("a");
		s.model = { ...s.model, id: "m2" };
		s.tools = [{ name: "read" }, { name: "edit" }, tool("bash", "tiny"), { name: "grep" }];
		s.message("user", "two");
		expect(names(await s.request("b"))).toEqual(["read", "bash", "edit", "grep"]);
		s.model = { ...s.model, id: "m1" };
		s.tools = [{ name: "read" }, { name: "edit" }, tool("bash", "cheap"), { name: "deferred" }];
		s.message("user", "three");
		expect((await s.request("c")).tools).toEqual(first.tools);
	});

	it("is the same in a fresh process on the branch", async () => {
		const s = new LedgerSim();
		s.tools = [{ name: "read" }, { name: "bash" }, { name: "edit" }];
		s.message("user", "one");
		await s.request("a");
		s.load();
		s.model = { ...s.model, id: "m2" };
		s.tools = [{ name: "read" }, { name: "edit" }, tool("bash", "tiny")];
		s.message("user", "two");
		expect(names(await s.request("b"))).toEqual(["read", "bash", "edit"]);
	});
});
