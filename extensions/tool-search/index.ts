/**
 * tool-search extension — Claude Code's ToolSearch.
 *
 * Deactivates every tool registered in the deferred registry at session start,
 * tells the model which names exist (a system reminder, as Claude Code does),
 * and activates matches additively when the model calls `tool_search`.
 *
 * Deferral runs on ALL model tiers, matching Claude Code: capture-confirmed that
 * current CC (v2.1.224/226) defers the niche/long-tail tools behind ToolSearch
 * even on Haiku, keeping only the core set eager (findings §14). Which tools are
 * deferrable is decided per tool (extensions opt in via DEFER_CHANNEL) — core
 * tools like read/edit/write/bash never register, so they stay eager.
 *
 * The mechanism is provider-independent: `pi.setActiveTools` edits the agent's
 * active tool set (`agent.state.tools`), which IS what pi sends, so a deactivated
 * tool is omitted from the request on any provider (OpenRouter, deepseek, etc.).
 * Provider-native deferral (Anthropic `defer_loading`, OpenAI `tool_search_call`)
 * is only a cache optimization on top; without it, loading a tool mid-session
 * grows the tools array and invalidates the prompt cache from the tools block
 * down — an accepted tradeoff (findings §7). On Anthropic tool-reference models
 * this extension keeps the tools array byte-stable itself (the
 * before_provider_request hook below), since pi 0.86 no longer does.
 *
 * Load order matters: this extension must come BEFORE any extension that defers
 * a tool, because those emit their defer request while extensions are loading
 * and pi's event bus only delivers to listeners already registered.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFER_CHANNEL,
	deferredAddendumText,
	deferredMissReminderText,
	DeferredRegistry,
	deferredReminderText,
	type DeferRequest,
	resultText,
	searchTools,
	selectedNames,
	stabilizeDeferredTools,
	supportsToolReferences,
	toolNotFoundName,
	toolSearchLoads,
	WITHHOLD_CHANNEL,
	withheldMissReminderText,
} from "../lib/deferred.ts";
import { looksLikeAnthropicRequest } from "../lib/anthropic-payload.ts";
import { MCP_TOOLS_CHANNEL, type McpToolsPayload } from "../lib/mcp-share.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL } from "../lib/reminders.ts";
import { sessionAlive } from "../lib/session-lifecycle.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";
import { normalizeToolName } from "../permissions/matcher.ts";
import { applyAnnouncement, planAnnouncement } from "./announce.ts";
import { registerLocalCommand } from "../lib/local-command.ts";

/** Coalesces the burst of per-tool defers one server emits into one listing update. */
const ANNOUNCE_DEBOUNCE_MS = 100;

export default function toolSearchExtension(pi: ExtensionAPI) {
	// Owned here (see lib/deferred.ts): the only instance, fed over DEFER_CHANNEL.
	const deferredRegistry = new DeferredRegistry();
	// Names WITHHOLD_CHANNEL removed from the registry, kept only so a direct
	// call to one still gets an explanation (tool_execution_end below) instead
	// of a bare "not found": the registry itself can't answer that, since
	// removal is what makes the name stop being deferred (searchable/loadable).
	// A re-defer (a model change bringing it back) clears the name from here.
	const withheldNames = new Set<string>();
	let sessionStarted = false;
	// The deferred-tools listing is a first-prepend reminder on message 1, part of
	// the cached prefix of every later request. Before the first request nothing
	// is cached, so the listing is (re)written freely; after it the listing is
	// FROZEN and later arrivals ride a one-shot addendum where the model reads
	// next (./announce.ts — a rewrite re-cached 16.7k tokens of history on
	// request 2 of every run whose MCP tools registered inside the debounce,
	// measured 2026-09-04). While the initial MCP connect is still settling the
	// addendum waits for settle, so one burst of per-tool defers is one notice.
	let requestSent = false;
	let mcpSettled = false;
	let announcePending = false;
	let announceTimer: NodeJS.Timeout | undefined;
	// After session_shutdown every pi.* call throws (the runner is invalidated,
	// findings §8); a debounced announce landing in a timer callback then would
	// be an uncaught exception and take pi down (LIFECYCLE-REVIEW L1).
	const alive = sessionAlive(pi);
	/** Names the model has been told about: the frozen listing plus every addendum. */
	const announced = new Set<string>();

	const searchableTools = () =>
		pi
			.getAllTools()
			.filter((tool) => deferredRegistry.has(tool.name))
			.map((tool) => ({
				name: tool.name,
				description: tool.description ?? "",
				keywords: deferredRegistry.keywordsFor(tool.name),
			}));

	const announce = () => {
		if (!alive()) return;
		const available = searchableTools();
		const plan = planAnnouncement({ requestSent, announced, available: available.map((t) => t.name) });
		if (plan.kind === "rewrite") {
			pi.events.emit(REMINDER_CHANNEL, {
				scope: "every-turn",
				key: "deferred-tools",
				text: deferredReminderText(available),
				placement: "first-prepend",
				order: CONTEXT_ORDER.deferredTools,
			});
		} else if (plan.kind === "addendum") {
			// Unkeyed on purpose: a keyed next-turn reminder replaces its
			// predecessor, and an addendum replaced before delivery would lose names.
			pi.events.emit(REMINDER_CHANNEL, { text: deferredAddendumText(plan.added) });
		}
		applyAnnouncement(announced, plan);
	};

	const clearAnnounce = () => {
		if (announceTimer) clearTimeout(announceTimer);
		announceTimer = undefined;
	};
	const scheduleAnnounce = () => {
		clearAnnounce();
		if (!alive()) return;
		announceTimer = setTimeout(() => {
			announceTimer = undefined;
			// Decided at fire time, not schedule time: a request may have gone out
			// during the debounce (the -p race).
			if (requestSent && !mcpSettled) {
				announcePending = true;
				return;
			}
			announce();
		}, ANNOUNCE_DEBOUNCE_MS);
		announceTimer.unref?.();
	};

	pi.events.on(MCP_TOOLS_CHANNEL, (data) => {
		if (!(data as McpToolsPayload | undefined)?.settled) return;
		mcpSettled = true;
		if (announcePending) {
			announcePending = false;
			announce();
		}
	});

	pi.on("context", () => {
		requestSent = true;
	});

	// Every tool_search load of this session (call id → names), seeded from the
	// transcript at session_start and extended by each load: the wire hook needs
	// it to reference a loaded tool from the result that loaded it.
	let loads = new Map<string, string[]>();
	// The loads a resumed session's transcript already holds (empty after
	// /clear). The transcript tells the model those tools are callable, and
	// Claude Code keeps a ToolSearch-loaded tool callable across a resume (its
	// tool_reference blocks stay in the history), so deferring them again would
	// send the model into a "Tool <name> not found" round trip. pi restores them
	// as active from the transcript before session_start; deferAll and the
	// late-defer handler leave those alone. A load made during this session
	// activates the tool directly and never needs this set.
	let loadedBefore = new Set<string>();

	// On models that take client-side tool references (first-party Claude >= 4.5,
	// not Haiku) the `tools` array is held byte-identical to request 1's: every
	// deferred tool rides every Anthropic request as a `defer_loading: true`
	// definition, and a tool that tool_search loaded — which pi 0.86 promotes into
	// the eager list, re-caching everything from the tools block down — is
	// demoted back to deferred and loaded through `tool_reference` blocks in the
	// tool_search result that activated it (lib/deferred.ts stabilizeDeferredTools
	// has the rules; working-docs/decisions/caching.md the measurements).
	pi.on("before_provider_request", (event, ctx) => {
		if (!supportsToolReferences(ctx.model as { provider?: string; id?: string } | undefined)) return undefined;
		if (!looksLikeAnthropicRequest(event.payload)) return undefined;
		return stabilizeDeferredTools(event.payload as Record<string, unknown>, pi.getAllTools(), (name) => deferredRegistry.has(name), loads);
	});


	/** Deactivate every deferred-registry tool the transcript has not loaded, and announce the loadable set. */
	const deferAll = () => {
		const deferred = new Set(deferredRegistry.names);
		if (deferred.size === 0) return;
		const active = pi.getActiveTools();
		const next = active.filter((name) => !deferred.has(name) || loadedBefore.has(name));
		if (next.length !== active.length) pi.setActiveTools(next);
		announce();
	};

	pi.events.on(DEFER_CHANNEL, (data) => {
		const request = data as DeferRequest;
		deferredRegistry.add(request);
		if (request?.name) withheldNames.delete(request.name);
		// A defer arriving after the session_start pass (MCP servers connect
		// asynchronously and register their tools then) would otherwise leave the
		// tool eager AND unlisted in the reminder. Deactivate it (unless the
		// transcript loaded it) and refresh the keyed reminder.
		if (sessionStarted && request?.name) {
			const active = pi.getActiveTools();
			if (active.includes(request.name) && !loadedBefore.has(request.name)) {
				pi.setActiveTools(active.filter((name) => name !== request.name));
			}
			// The tool is searchable (keyword search reads the registry) from now;
			// only the standing listing waits.
			scheduleAnnounce();
		}
	});

	pi.events.on(WITHHOLD_CHANNEL, (data) => {
		const name = (data as { name?: string } | undefined)?.name;
		if (!name || !deferredRegistry.remove(name)) return;
		withheldNames.add(name);
		if (!alive()) return;
		const active = pi.getActiveTools();
		if (active.includes(name)) pi.setActiveTools(active.filter((n) => n !== name));
		// Before the first request the listing is still free to change: rewrite it
		// now, synchronously, so a request going out right after session_start
		// never names the withheld tool. After it the frozen listing stands.
		if (sessionStarted && !requestSent) announce();
	});

	pi.on("session_start", (_event, ctx) => {
		sessionStarted = true;
		// A pending debounce belongs to the previous session's listing (RPC's
		// new_session emits session_start twice, findings §3); deferAll below
		// announces the fresh one.
		clearAnnounce();
		loads = toolSearchLoads(ctx?.sessionManager?.getBranch?.() ?? []);
		loadedBefore = new Set([...loads.values()].flat());
		// A new session (/clear, or a resume in a new process) has no cached prefix
		// yet: its first request gets a freshly written listing.
		requestSent = false;
		announced.clear();
		deferAll();
	});

	pi.on("session_shutdown", clearAnnounce);

	// The every-turn deferred-tools list tells the model to load via tool_search,
	// but if it calls a deferred tool directly anyway, pi's core dispatcher fails
	// the call with a bare "Tool <name> not found" — which fires here as an error
	// tool_execution_end. (This path skips beforeToolCall/afterToolCall, so the
	// tool_call/tool_result hooks never see it.) The call can't be salvaged
	// mid-turn, but we steer the model straight back to tool_search on its next
	// step with a one-shot reminder, far more pointed than the standing list.
	pi.on("tool_execution_end", (event) => {
		if (!event.isError) return;
		const raw = toolNotFoundName(resultText(event.result));
		// Map a Claude Code spelling (a direct `NotebookEdit` call) to our name so
		// the miss is recognised and the steer names the loadable tool (M1).
		const name = raw ? normalizeToolName(raw) : undefined;
		if (!name) return;
		if (deferredRegistry.has(name)) {
			pi.events.emit(REMINDER_CHANNEL, {
				scope: "next-turn",
				key: `deferred-miss-${name}`,
				text: deferredMissReminderText(name),
			});
		} else if (withheldNames.has(name)) {
			// A withheld tool is gone from the registry too (WITHHOLD_CHANNEL), so
			// the ordinary steer above would send the model to tool_search for a
			// name that will not be found there either.
			pi.events.emit(REMINDER_CHANNEL, {
				scope: "next-turn",
				key: `deferred-miss-${name}`,
				text: withheldMissReminderText(name),
			});
		}
	});

	pi.registerTool({
		name: "tool_search",
		label: "Tool Search",
		...ccToolRenderers("Tool Search"),
		description:
			"Fetches full schema definitions for deferred tools so they can be called.\n\nDeferred tools appear by name in <system-reminder> messages. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and loads the matched tools' full schemas so they become callable exactly like any tool defined at the top of the prompt.\n\nQuery forms:\n- `select:web_fetch,notebook_edit` — fetch these exact tools by name\n- `notebook jupyter` — keyword search, up to max_results best matches\n- `+slack send` — require \"slack\" in the name, rank by remaining terms",
		promptSnippet: "Load additional tool schemas on demand",
		parameters: Type.Object({
			query: Type.String({ description: "Tool names (`select:a,b`) or keywords describing the capability needed" }),
			max_results: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 20, description: "Maximum tools to load (default 5)" }),
			),
		}),
		async execute(toolCallId, params) {
			const available = searchableTools();
			const matches = searchTools(params.query, available, params.max_results ?? 5);

			// For an exact `select:` query, a requested name that matched nothing was
			// silently dropped before — the model was told the rest "Loaded" and only
			// discovered the miss later as an opaque InputValidationError. Always
			// surface the unmatched names.
			const requested = selectedNames(params.query);
			const notFound = requested
				? requested.filter((n) => !matches.some((m) => m.name.toLowerCase() === n))
				: [];
			// A withheld name can still sit in the frozen listing (withdrawn by a model
			// change after the first request), so it gets "do not retry", not a
			// spelling hint.
			const withdrawn = notFound.filter((n) => withheldNames.has(n));
			const missing = notFound.filter((n) => !withheldNames.has(n));
			const notFoundNote =
				(missing.length > 0
					? ` Not found (not deferred tool names — check spelling, or search by keyword instead of \`select:\`): ${missing.join(", ")}.`
					: "") +
				(withdrawn.length > 0 ? ` Withdrawn for the current model (do not retry): ${withdrawn.join(", ")}.` : "");

			if (matches.length === 0) {
				const names = available.map((t) => t.name).join(", ") || "(none)";
				return {
					content: [
						{ type: "text", text: `No tools matched "${params.query}".${notFoundNote} Tools that can be loaded: ${names}` },
					],
					details: { matches: [] as string[], added: [] as string[], notFound },
					isError: true,
				};
			}

			const active = pi.getActiveTools();
			const added = matches.map((m) => m.name).filter((name) => !active.includes(name));
			if (added.length > 0) {
				pi.setActiveTools([...new Set([...active, ...added])]);
				loads.set(toolCallId, added);
			}

			const loaded = matches.map((m) => m.name);
			return {
				content: [
					{
						type: "text",
						text:
							(added.length > 0
								? `Loaded ${added.join(", ")}. These tools are now callable.`
								: `Already loaded: ${loaded.join(", ")}.`) + notFoundNote,
					},
				],
				details: { matches: loaded, added, notFound },
			};
		},
	});

	registerLocalCommand(pi, "tools-deferred", {
		description: "Show which tools are deferred (loadable via tool_search)",
		handler: async (args, ctx) => {
			const available = searchableTools();
			const activeSet = new Set(pi.getActiveTools());
			const lines = available.map((t) => `${activeSet.has(t.name) ? "loaded " : "deferred"} ${t.name}`);
			ctx.ui.notify(lines.length ? lines.join("\n") : "No deferred tools registered.", "info");
		},
	});
}
