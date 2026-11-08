/**
 * The eager set follows Claude Code's: schedule_wakeup and list_agents are
 * declared from the first request (never announced on the deferral channel),
 * artifact stays deferred. An eager tool needs no promptSnippet: the prompt
 * lists only the tools that bring one. The Agent tool's description comes
 * from the profile in force, in the form the model's tier calls for (One
 * Code's own forms: profile/test/eager-set-wording.test.ts).
 */
import { describe, expect, it, vi } from "vitest";
import artifactsExtension from "../../extensions/artifacts/index.ts";
import backgroundExtension from "../../extensions/background/index.ts";
import { DEFER_CHANNEL } from "../../extensions/lib/deferred.ts";
import subagentsExtension from "../../extensions/subagents/index.ts";
import { requireText } from "../../extensions/lib/profile.ts";
import { projectConfigDirName } from "../../extensions/lib/sources.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

function deferredBy(...extensions: Array<(pi: never) => void>) {
	const fake = createFakePi();
	const deferred: string[] = [];
	fake.events.on(DEFER_CHANNEL, (data) => deferred.push((data as { name: string }).name));
	for (const extension of extensions) extension(fake.pi as never);
	return { fake, deferred };
}

/** The Agent tool's description in `form`, as the profile renders it for the base. */
function agentDescription(form: "short" | "long"): string {
	return requireText("subagents").agentDescription({ form, configDir: projectConfigDirName() });
}

describe("eager and deferred tools", () => {
	it("schedule_wakeup and list_agents are eager; their neighbours stay deferred", () => {
		const { fake, deferred } = deferredBy(backgroundExtension as never, subagentsExtension as never, artifactsExtension as never);
		expect(fake.tools.has("schedule_wakeup")).toBe(true);
		expect(fake.tools.has("list_agents")).toBe(true);
		expect(deferred).not.toContain("schedule_wakeup");
		expect(deferred).not.toContain("list_agents");
		expect(deferred).toEqual(expect.arrayContaining(["artifact", "monitor", "task_output", "task_stop", "cron_create", "cron_list", "cron_delete", "SendMessage"]));
	});

	it("SendMessage no longer tells the model to load list_agents", () => {
		const { fake } = deferredBy(backgroundExtension as never, subagentsExtension as never);
		expect(fake.tools.get("SendMessage")!.description).not.toContain("select:list_agents");
	});

	it("the Agent tool switches to the long form on a cheap model", async () => {
		const { fake } = deferredBy(backgroundExtension as never, subagentsExtension as never);
		expect(fake.tools.get("Agent")!.description).toBe(agentDescription("short"));
		expect(agentDescription("long")).not.toBe(agentDescription("short"));
		vi.stubEnv("CC_PROMPT_TIER", "cheap");
		try {
			const model = { provider: "openai", id: "gpt-test", input: ["text"], cost: { input: 1, output: 4 } };
			await fake.fire("model_select", { type: "model_select", model, source: "set" }, createFakeCtx({ model, modelRegistry: { getAvailable: () => [model] } }));
		} finally {
			vi.unstubAllEnvs();
		}
		expect(fake.tools.get("Agent")!.description).toBe(agentDescription("long"));
	});
});
