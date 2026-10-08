import { describe, expect, it } from "vitest";
import { deferredToolsBaseline, deferredToolsFromReminder, planAnnouncement } from "../../extensions/tool-search/announce.ts";
import { emptyAnnounced, mcpAnnouncedBaseline, mcpAnnouncedFromReminders, serializeMcpAnnounced } from "../../extensions/mcp/announce.ts";
import { emptySubagentBaseline, planSubagentAnnouncement, subagentBaseline, subagentBaselineFromStack } from "../../extensions/subagents/announce.ts";
import subagentsExtension from "../../extensions/subagents/index.ts";
import { CONTEXT_BASELINE_CHANNEL, CONTEXT_RESTORE_CHANNEL } from "../../extensions/lib/context-stack.ts";
import { MODEL_UNUSABLE_CHANNEL } from "../../extensions/lib/model-unusable.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

describe("phase-2 capability baselines", () => {
	it("restores the deferred-tools baseline and preserves a removed name", () => {
		const announced = new Set(deferredToolsBaseline(["web_fetch", "old_tool", "web_fetch"])!);
		expect(planAnnouncement({ requestSent: true, announced, available: ["web_fetch"] })).toEqual({ kind: "none" });
		expect(planAnnouncement({ requestSent: true, announced, available: ["web_fetch", "new_tool"] })).toEqual({
			kind: "addendum", added: ["new_tool"],
		});
		expect(deferredToolsFromReminder("The following deferred tools are available via tool_search. Their schemas are NOT loaded\na\nb")).toEqual(["a", "b"]);
	});

	it("round-trips arbitrary MCP instructions and errors through structured arrays", () => {
		const announced = emptyAnnounced();
		announced.instructed.set("server", "Use this\n\n## literal heading\nwithout parsing it.");
		announced.failed.set("bad", "error:\nany arbitrary text");
		const restored = mcpAnnouncedBaseline(serializeMcpAnnounced(announced));
		expect([...restored!.instructed]).toEqual([...announced.instructed]);
		expect([...restored!.failed]).toEqual([...announced.failed]);
		expect(mcpAnnouncedBaseline({ instructed: [["a", 1]], failed: [] })).toBeUndefined();
		expect([...mcpAnnouncedFromReminders(
			"# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n## old\nuse it",
			undefined,
		).instructed]).toEqual([["old", "use it"]]);
	});

	it("uses locked stack text only as an older subagent snapshot fallback, including absence", () => {
		expect(subagentBaselineFromStack([
			{ key: "subagent-models", text: "models" }, { key: "subagent-agents", text: "agents" },
		])).toEqual({ models: "models", agents: "agents", delegation: null, refusedModels: [] });
		expect(subagentBaseline({ models: "models", agents: "agents", delegation: null })).toEqual({
		models: "models", agents: "agents", delegation: null, refusedModels: [],
	});
	});

	it("does not rewrite unchanged resumed capability blocks, appends real changes, and resets fresh sessions", () => {
		const baseline = { models: "old models", agents: "old agents", delegation: null, refusedModels: [] };
		expect(planSubagentAnnouncement({ restored: true, baseline, capability: "models", text: "old models" }).kind).toBe("none");
		expect(planSubagentAnnouncement({ restored: true, baseline, capability: "models", text: "new models" })).toMatchObject({
			kind: "addendum", text: "new models",
		});
		expect(planSubagentAnnouncement({ restored: true, baseline, capability: "delegation", text: "tiny guidance" })).toMatchObject({
			kind: "addendum", text: "tiny guidance",
		});
		expect(planSubagentAnnouncement({ restored: false, baseline: emptySubagentBaseline(), capability: "models", text: "fresh models" })).toMatchObject({
			kind: "standing",
		});
	});

	it("keeps the meaningful refused-model correction on a restored session", async () => {
		const fake = createFakePi();
		fake.events.on(CONTEXT_RESTORE_CHANNEL, (request) => {
			(request as { restored?: unknown }).restored = { version: 1, stack: [], sticky: [], baselines: { subagents: emptySubagentBaseline() } };
		});
		const reminders: Array<{ text?: string }> = [];
		const baselines: Array<{ key: string; value: { models?: string | null; refusedModels?: string[] } }> = [];
		fake.events.on(REMINDER_CHANNEL, (reminder) => reminders.push(reminder as { text?: string }));
		fake.events.on(CONTEXT_BASELINE_CHANNEL, (baseline) => baselines.push(baseline as { key: string; value: { models?: string | null; refusedModels?: string[] } }));
		subagentsExtension(fake.pi as never);
		const main = { provider: "openai", id: "main", name: "main", input: ["text"], cost: { input: 2, output: 8 } };
		const fallback = { provider: "openai", id: "fallback", name: "fallback", input: ["text"], cost: { input: 1, output: 4 } };
		const ctx = createFakeCtx({ model: main, modelRegistry: { getAvailable: () => [main, fallback] } });
		await fake.fire("session_start", {}, ctx);
		reminders.length = 0;
		fake.events.emit(MODEL_UNUSABLE_CHANNEL, { model: "openai/main", reason: "account refusal" });
		expect(reminders.map((r) => r.text).join("\n")).toContain("Model openai/main is not usable on this account");
		// The one-shot is deliberately narrow, but a resume must compare against
		// the corrected catalog rather than append the same correction forever.
		const corrected = baselines.filter((baseline) => baseline.key === "subagents").at(-1)!.value;
		expect(corrected.refusedModels).toEqual(["openai/main"]);
		expect(corrected.models).toContain("openai/fallback");

		const repeat = createFakePi();
		const repeatReminders: Array<{ text?: string }> = [];
		repeat.events.on(CONTEXT_RESTORE_CHANNEL, (request) => {
			(request as { restored?: unknown }).restored = { version: 1, stack: [], sticky: [], baselines: { subagents: corrected } };
		});
		repeat.events.on(REMINDER_CHANNEL, (reminder) => repeatReminders.push(reminder as { text?: string }));
		subagentsExtension(repeat.pi as never);
		await repeat.fire("session_start", {}, ctx);
		// The persisted refusal also repopulates the selection floor, so the same
		// resumed catalog produces no duplicate tail correction or full-menu append.
		expect(repeatReminders).toEqual([]);
	});
});
