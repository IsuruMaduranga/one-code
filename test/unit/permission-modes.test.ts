import { describe, expect, it } from "vitest";
import permissionsExtension from "../../extensions/permissions/index.ts";
import type { PermissionMode } from "../../extensions/permissions/matcher.ts";
import {
	formatModel,
	formatModelSpec,
	MODE_BADGES,
	modeBadge,
	nextMode,
	PERMISSION_STATUS_CHANNEL,
	permissionModeDisplay,
	type PermissionStatus,
	shortModelName,
} from "../../extensions/permissions/modes.ts";
import { normalizePermissionMode } from "../../extensions/permissions/settings.ts";

describe("nextMode", () => {
	it("cycles manual → acceptEdits → plan → manual", () => {
		expect(nextMode("default", { bypassInCycle: false, autoInCycle: false })).toBe("acceptEdits");
		expect(nextMode("acceptEdits", { bypassInCycle: false, autoInCycle: false })).toBe("plan");
		expect(nextMode("plan", { bypassInCycle: false, autoInCycle: false })).toBe("default");
	});

	it("includes bypass only when the session started with it", () => {
		expect(nextMode("plan", { bypassInCycle: true, autoInCycle: false })).toBe("bypassPermissions");
		expect(nextMode("bypassPermissions", { bypassInCycle: true, autoInCycle: false })).toBe("default");
	});

	it("exits a non-cycle mode to the cycle start", () => {
		// dontAsk never cycles in; bypass is outside the cycle unless enabled at start.
		expect(nextMode("dontAsk", { bypassInCycle: false, autoInCycle: false })).toBe("default");
		expect(nextMode("bypassPermissions", { bypassInCycle: false, autoInCycle: false })).toBe("default");
	});

	it("puts auto last, after bypass, matching Claude Code's order", () => {
		expect(nextMode("plan", { bypassInCycle: false, autoInCycle: true })).toBe("auto");
		expect(nextMode("auto", { bypassInCycle: false, autoInCycle: true })).toBe("default");
		expect(nextMode("plan", { bypassInCycle: true, autoInCycle: true })).toBe("bypassPermissions");
		expect(nextMode("bypassPermissions", { bypassInCycle: true, autoInCycle: true })).toBe("auto");
	});

	it("skips auto when no classifier model is reachable", () => {
		// Auto mode with no model would block every call, so it leaves the cycle.
		expect(nextMode("plan", { bypassInCycle: false, autoInCycle: false })).toBe("default");
	});
});

describe("MODE_BADGES", () => {
	it("has a footer badge for every mode", () => {
		const modes: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"];
		for (const mode of modes) {
			expect(MODE_BADGES[mode], mode).toBeTruthy();
		}
	});

	it("uses Claude Code's strings", () => {
		expect(MODE_BADGES.default).toBe("⏸ manual mode on");
		expect(MODE_BADGES.acceptEdits).toBe("⏵⏵ accept edits on");
		expect(MODE_BADGES.plan).toBe("⏸ plan mode on");
		expect(MODE_BADGES.auto).toBe("⏵⏵ auto mode on");
	});
});

describe("modeBadge", () => {
	const HINT = " (ctrl+q to cycle)";

	it("ends every badge with the cycle-key hint", () => {
		expect(modeBadge("default", {})).toBe(`${MODE_BADGES.default}${HINT}`);
		expect(modeBadge("plan", { paused: false })).toBe(`${MODE_BADGES.plan}${HINT}`);
		expect(modeBadge("acceptEdits", {})).toBe(`${MODE_BADGES.acceptEdits}${HINT}`);
	});

	it("names the classifier model beside auto mode", () => {
		// The model reads the user's prompts and CLAUDE.md, so which one it is
		// belongs on screen rather than buried in a command.
		expect(modeBadge("auto", { classifierModel: "claude-haiku-4-5" })).toBe(`⏵⏵ auto mode on · haiku-4-5${HINT}`);
	});

	it("says nothing about the model before one is settled", () => {
		expect(modeBadge("auto", {})).toBe(`${MODE_BADGES.auto}${HINT}`);
	});

	it("keeps the model visible while paused", () => {
		expect(modeBadge("auto", { paused: true, classifierModel: "gpt-5-mini" })).toBe(`⏸ auto mode paused · 5-mini${HINT}`);
	});

	it("appends the interrupt hint only while streaming (CC's mode line)", () => {
		expect(modeBadge("default", { streaming: true })).toBe(`${MODE_BADGES.default}${HINT} · esc to interrupt`);
		expect(modeBadge("default", { streaming: false })).toBe(`${MODE_BADGES.default}${HINT}`);
	});

	it("only shows paused for auto mode", () => {
		expect(modeBadge("default", { paused: true })).toBe(`${MODE_BADGES.default}${HINT}`);
	});
});

describe("shortModelName", () => {
	it("drops a vendor prefix and a date stamp", () => {
		expect(shortModelName("anthropic/claude-haiku-4-5-20251001")).toBe("haiku-4-5");
		expect(shortModelName("google/gemini-2.5-flash")).toBe("2.5-flash");
	});

	it("leaves an already-short id recognisable", () => {
		expect(shortModelName("llama-3.3-70b-versatile")).toBe("3.3-70b-versatile");
		expect(shortModelName("qwen3-coder")).toBe("qwen3-coder");
	});
});

describe("formatModel / formatModelSpec", () => {
	it("shows (provider) and the full vendor-qualified id", () => {
		expect(formatModel("openrouter", "google/gemini-3.7-flash")).toBe("(openrouter) google/gemini-3.7-flash");
	});
	it("trims a trailing date but keeps the rest", () => {
		expect(formatModel("anthropic", "claude-haiku-4-5-20251001")).toBe("(anthropic) claude-haiku-4-5");
	});
	it("omits the parenthesized provider when it is empty", () => {
		expect(formatModel("", "some-model")).toBe("some-model");
	});
	it("splits a combined provider/id spec on the first slash", () => {
		expect(formatModelSpec("openrouter/google/gemini-3.7-flash")).toBe("(openrouter) google/gemini-3.7-flash");
		expect(formatModelSpec("anthropic/claude-opus-4-8")).toBe("(anthropic) claude-opus-4-8");
	});
	it("handles a spec with no provider segment", () => {
		expect(formatModelSpec("bare-model")).toBe("bare-model");
	});
});

describe("normalizePermissionMode", () => {
	it("accepts internal names and Claude Code's manual alias", () => {
		expect(normalizePermissionMode("acceptEdits")).toBe("acceptEdits");
		expect(normalizePermissionMode("manual")).toBe("default");
		expect(normalizePermissionMode("dontAsk")).toBe("dontAsk");
	});

	it("accepts auto", () => {
		expect(normalizePermissionMode("auto")).toBe("auto");
	});

	it("rejects unknown values", () => {
		expect(normalizePermissionMode("")).toBeUndefined();
		expect(normalizePermissionMode("turbo")).toBeUndefined();
		expect(normalizePermissionMode(42)).toBeUndefined();
	});
});

describe("permissionModeDisplay", () => {
	it("shows plain modes as their name", () => {
		expect(permissionModeDisplay({ mode: "default", paused: false })).toBe("default");
		expect(permissionModeDisplay({ mode: "plan", paused: false })).toBe("plan");
	});

	it("names the classifier in auto mode — that model reads the user's prompts", () => {
		expect(
			permissionModeDisplay({ mode: "auto", paused: false, classifier: "openai/gpt-5-mini", pinned: true }),
		).toBe("auto · classifier 5-mini");
	});

	it("marks a classifier that is still the plan rather than the settled fact", () => {
		expect(
			permissionModeDisplay({ mode: "auto", paused: false, classifier: "anthropic/claude-haiku-4-5", pinned: false }),
		).toBe("auto · classifier haiku-4-5 (planned)");
	});

	it("shows the paused state and the missing-model state", () => {
		expect(permissionModeDisplay({ mode: "auto", paused: true, classifier: "openai/gpt-5-mini", pinned: true })).toBe(
			"auto (paused) · classifier 5-mini",
		);
		expect(permissionModeDisplay({ mode: "auto", paused: false })).toBe(
			"auto · classifier no model available (planned)",
		);
	});
});

describe("permissionsExtension model_select updates classifier", () => {
	function makeModel(provider: string, id: string, input?: number) {
		return {
			provider,
			id,
			name: id,
			cost: input === undefined ? undefined : { input, output: input * 4 },
		} as any;
	}

	function makeFakePi() {
		const busHandlers = new Map<string, Array<(data: unknown) => void>>();
		const lifecycleHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
		const emitted: Record<string, unknown[]> = {};

		const pi = {
			events: {
				on(channel: string, handler: (data: unknown) => void) {
					const list = busHandlers.get(channel) ?? [];
					list.push(handler);
					busHandlers.set(channel, list);
				},
				emit(channel: string, data: unknown) {
					(emitted[channel] ??= []).push(data);
					for (const h of busHandlers.get(channel) ?? []) h(data);
				},
			},
			on(event: string, handler: (event: unknown, ctx: unknown) => void) {
				const list = lifecycleHandlers.get(event) ?? [];
				list.push(handler);
				lifecycleHandlers.set(event, list);
			},
			registerCommand: () => {},
			registerShortcut: () => {},
			registerFlag: () => {},
			getFlag: () => undefined,
		};

		const fire = (event: string, payload: unknown, ctx: unknown) => {
			for (const h of lifecycleHandlers.get(event) ?? []) h(payload, ctx);
		};

		return { pi, emitted, fire };
	}

	it("switches classifier candidates to the new provider when the session model changes", () => {
		const anthropicSonnet = makeModel("anthropic", "claude-3-7-sonnet", 3);
		const anthropicHaiku = makeModel("anthropic", "claude-3-5-haiku", 0.8);
		const openaiGpt5 = makeModel("openai", "gpt-5.5", 10);
		const openaiMini = makeModel("openai", "gpt-5-mini", 0.25);

		const available = [anthropicSonnet, anthropicHaiku, openaiGpt5, openaiMini];
		const fake = makeFakePi();
		permissionsExtension(fake.pi as any);

		// Switch to auto mode via bus
		fake.pi.events.emit("one-code:set-permission-mode", { mode: "auto" });

		function makeCtx(currentModel: unknown) {
			return {
				cwd: "/tmp/project",
				model: currentModel,
				modelRegistry: {
					getAvailable: () => available,
				},
				sessionManager: {
					getSessionId: () => "sess-1",
					getSessionDir: () => "/tmp/sess",
				},
				ui: {
					setWidget: () => {},
					notify: () => {},
				},
			};
		}

		// 1. Session start with Anthropic
		fake.fire("session_start", {}, makeCtx(anthropicSonnet));
		const statusList = fake.emitted[PERMISSION_STATUS_CHANNEL] as PermissionStatus[];
		expect(statusList.length).toBeGreaterThan(0);
		const lastStatus1 = statusList[statusList.length - 1];
		expect(lastStatus1.mode).toBe("auto");
		expect(lastStatus1.classifier).toBe("anthropic/claude-3-5-haiku");

		// 2. Main model changes to OpenAI
		fake.fire("model_select", { model: openaiGpt5 }, makeCtx(openaiGpt5));
		const lastStatus2 = statusList[statusList.length - 1];
		expect(lastStatus2.mode).toBe("auto");
		expect(lastStatus2.classifier).toBe("openai/gpt-5-mini");

		// 3. Banner mode display reflects the updated classifier
		expect(permissionModeDisplay(lastStatus2)).toBe("auto · classifier 5-mini (planned)");
	});
});

