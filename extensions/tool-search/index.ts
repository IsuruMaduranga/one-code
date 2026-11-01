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

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFER_CHANNEL,
	deferredAddendumText,
	deferredMissReminderText,
	DeferredRegistry,
	deferralEnabled,
	deferredReminderText,
	loaderUnavailableReminderText,
	type DeferRequest,
	resultText,
	searchTools,
	selectedRequests,
	type ResponsesToolLoadModel,
	stabilizeDeferredTools,
	stabilizeResponsesToolLoads,
	responsesToolLoadCompat,
	supportsToolReferences,
	toolNotFoundName,
	toolSearchLoads,
	toolsInUse,
	callableDeferredTools,
	reconcileActive,
	WITHHOLD_CHANNEL,
	DEFERRED_QUERY_CHANNEL,
	type DeferredQuery,
	deferredRemovedText,
	withheldMissReminderText,
	unavailableToolReminderText,
} from "../lib/deferred.ts";
import { looksLikeAnthropicRequest, MID_CONVERSATION_SYSTEM_BETA, withBetas } from "../lib/anthropic-payload.ts";
import { liftAddenda, supportsToolAdditions, TOOL_ADDITION_BETAS, withToolAdditions } from "../lib/tool-additions.ts";
import { inContextEntries } from "../lib/compaction-boundary.ts";
import { CALLABLE_TOOLS } from "../lib/ledger/fold.ts";
import { foldOnce, sameEntries } from "../lib/ledger/fold-memo.ts";
import { recordedToolNames } from "../lib/ledger/wire.ts";
import { MCP_TOOLS_CHANNEL } from "../lib/mcp-share.ts";
import { sessionIdentity } from "../lib/anthropic-auth.ts";
import type { EntryLike } from "../lib/ledger/records.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL, RENDER_CHANNEL, type RenderRequest } from "../lib/reminders.ts";
import { sessionAlive } from "../lib/session-lifecycle.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";
import { normalizeToolName } from "../permissions/matcher.ts";
import { registerLocalCommand } from "../lib/local-command.ts";

/** The told mode for "this epoch's message 1 lists deferred tools this run cannot load", said once per epoch. */
const UNAVAILABLE_MODE = "deferred-unavailable";

/** A session manager as far as the reconciler reads it (a test double may lack `getBranch`). */
type SessionLike = { getBranch?: () => unknown[] };
const branchOf = (session: SessionLike | undefined) => (session?.getBranch?.() ?? []) as EntryLike[];

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
	// After session_shutdown every pi.* call throws (the runner is invalidated,
	// findings §8): an event that lands then must do nothing (LIFECYCLE-REVIEW L1).
	const alive = sessionAlive(pi);
	/** The session's manager, for folding what the current epoch has told and loaded outside a hook that carries one. */
	let session: SessionLike | undefined;
	/** The session's model, for a decision made outside a hook that carries one. */
	let currentModel: { provider?: string; api?: string; id?: string; compat?: unknown } | undefined;
	/**
	 * The branch's fold with the live identity, so a model or auth switch
	 * counts. Shared with the ledger (lib/ledger/fold-memo.ts): the fold this
	 * turn_start takes serves the request's `context` hook, and a server's
	 * connect defers its tools in a burst with nothing appended between.
	 */
	const foldOf = (owner: SessionLike | undefined, branch: EntryLike[], model: typeof currentModel) => foldOnce(owner, branch, sessionIdentity(pi, model));

	/** Whether tool_search is registered; a `--tools` list without it turns deferral off (lib/deferred.ts). */
	const deferring = () => deferralEnabled(pi.getAllTools());
	const searchableTools = (all = pi.getAllTools()) => {
		if (!deferralEnabled(all)) return [];
		return all
			.filter((tool) => deferredRegistry.has(tool.name))
			.map((tool) => ({
				name: tool.name,
				description: tool.description ?? "",
				keywords: deferredRegistry.keywordsFor(tool.name),
			}));
	};

	/**
	 * The deferred-tools listing as live state: what an epoch's message 1 says.
	 * Inside an epoch message 1 is the record, so a change here is announced by
	 * the render step below, never by rewriting it.
	 */
	const publishListing = () => {
		if (!alive()) return;
		const available = searchableTools();
		if (available.length === 0) {
			pi.events.emit(REMINDER_CHANNEL, { key: "deferred-tools", remove: true });
			return;
		}
		pi.events.emit(REMINDER_CHANNEL, {
			key: "deferred-tools",
			text: deferredReminderText(available),
			placement: "first-prepend",
			order: CONTEXT_ORDER.deferredTools,
			facts: [{ kind: "tools", names: available.map((tool) => tool.name) }],
		});
	};

	/** Deferred tools this process has seen loadable: one of them missing later is known to be gone. */
	const seenHere = new Set<string>();
	/** True once the MCP extension published its settled tool set: an MCP tool missing then is gone. */
	let mcpSettled = false;
	pi.events.on(MCP_TOOLS_CHANNEL, (data) => {
		if ((data as { settled?: boolean } | undefined)?.settled) mcpSettled = true;
	});

	// Inside an epoch, a deferred tool that registered since the epoch's listing
	// is announced on the request's tail: computed when the request goes out,
	// from what is loadable then and what the epoch has told, so a tool withheld
	// in the meantime is never announced (the H1 class). Where the model takes
	// Claude Code's tool_addition, the addendum becomes one (the context and
	// payload hooks below) and the tool is callable at once.
	pi.events.on(RENDER_CHANNEL, (data) => {
		const request = data as RenderRequest;
		if (request.epoch) return;
		const told = request.told.get("tools") ?? new Set<string>();
		if (!deferring()) {
			// The epoch's message 1 lists deferred tools this run cannot load.
			if (told.size > 0 && !request.modes.has(UNAVAILABLE_MODE)) {
				request.blocks.push({ text: loaderUnavailableReminderText(), facts: [{ kind: "mode", key: UNAVAILABLE_MODE, on: true }] });
			}
			return;
		}
		// A tool told and missing now is announced gone once its absence is known
		// (the fold then holds it untold, so a return is announced as new): this
		// process saw it leave, or it is an MCP tool and the MCP connects have
		// settled (a resume sends its first request before a slow server
		// registers, and a fork never had the parent's own tools). A tool
		// withdrawn for the model is not gone: a call to it says so.
		const loadable = new Set(searchableTools().map((tool) => tool.name));
		for (const name of loadable) seenHere.add(name);
		const absent = (name: string) => seenHere.has(name) || (name.startsWith("mcp__") && mcpSettled);
		const removed = [...told].filter((name) => !loadable.has(name) && !withheldNames.has(name) && absent(name));
		if (removed.length > 0) request.blocks.push({ text: deferredRemovedText(removed), facts: [{ kind: "tools", names: removed, removed: true }] });
		const added = [...loadable].filter((name) => !told.has(name));
		if (added.length === 0) return;
		if (!supportsToolAdditions(request.model)) {
			request.blocks.push({ text: deferredAddendumText(added), facts: [{ kind: "tools", names: added }] });
			return;
		}
		// Here an addendum is a tool_addition, callable at once: only a tool the
		// reconciler activated before pi fixed this turn's tools (turn_start) is
		// announced; one that arrived since waits for the next request.
		const active = new Set(pi.getActiveTools());
		const callable = added.filter((name) => active.has(name));
		if (callable.length > 0) request.blocks.push({ text: deferredAddendumText(callable), facts: [{ kind: "tools", names: callable, callable: true }] });
	});

	/** The addenda the last `context` pass lifted off tool results, by call id (lib/tool-additions.ts). */
	let addendaByCall = new Map<string, string[]>();
	pi.on("context", (event, ctx) => {
		addendaByCall = new Map();
		if (!supportsToolAdditions(ctx?.model) || !Array.isArray(event?.messages)) return undefined;
		const lifted = liftAddenda(event.messages);
		addendaByCall = lifted.byCall;
		return lifted.messages === event.messages ? undefined : { messages: lifted.messages };
	});

	// Every tool_search load still in context (call id → names), derived from the
	// branch by each reconcile, plus the loads this turn made that are not on the
	// branch yet: the wire hook needs it to reference a loaded tool from the
	// result that loaded it.
	let loads = new Map<string, string[]>();
	/** Loads `tool_search` made since the last turn started: their results reach the branch when the batch ends. */
	const freshLoads = new Map<string, string[]>();

	/** What the branch's in-context history loaded and uses, for the branch it was read from. */
	let used: { entries: readonly EntryLike[]; loads: ReadonlyMap<string, string[]>; inUse: ReadonlySet<string> } | undefined;
	/**
	 * The branch's in-context loads and tools in use, read again only when the
	 * branch changed (lib/ledger/fold-memo.ts `sameEntries`): the reconciler runs
	 * at every turn, model switch, defer and withhold, and a server's connect
	 * defers its tools in a burst with nothing appended between. Both are pure
	 * functions of the entries; the registry, the model and this turn's loads
	 * are applied on top at each run.
	 */
	const branchUse = (branch: EntryLike[]) => {
		if (used && sameEntries(used.entries, branch)) return used;
		const inContext = inContextEntries(branch) as SessionEntry[];
		const loads = toolSearchLoads(inContext);
		used = { entries: [...branch], loads, inUse: toolsInUse(inContext, loads) };
		return used;
	};

	/**
	 * The one place deferred tools are activated and deactivated (lib/deferred.ts
	 * callableDeferredTools): a deferred tool is active exactly when the branch
	 * gives a reason. Its history uses it (a load or a call in context), the
	 * epoch announced it callable, the recorded head the next request starts
	 * from declares it eagerly, or the next request announces it callable.
	 * Claude Code keeps a loaded tool callable across a resume (its
	 * tool_reference blocks stay in the history); a compaction returns to
	 * deferred what its kept turns no longer use, and keeps what the last
	 * request declared eagerly (removing it from `tools` would be the miss). A
	 * withheld tool is never active. Run before pi fixes a turn's tools
	 * (turn_start) and whenever the inputs change.
	 */
	const reconcile = (owner: SessionLike | undefined, model: typeof currentModel) => {
		if (!alive()) return;
		const all = pi.getAllTools();
		const registered = new Set(all.map((tool) => tool.name));
		if (!deferralEnabled(all)) {
			// Nothing is deferred without the loader, but a withheld tool is still
			// never active: a /tree switch restores a loadout from before it left.
			const active = pi.getActiveTools();
			const next = reconcileActive(active, new Set(), new Set(), withheldNames, registered);
			if (next !== active) pi.setActiveTools([...next]);
			return;
		}
		const branch = branchOf(owner);
		const use = branchUse(branch);
		loads = new Map([...use.loads, ...freshLoads]);
		const deferred = new Set(deferredRegistry.names);
		// With nothing deferred no deferred tool is callable: the active set
		// loses only withheld tools, and the branch's fold has nothing to decide.
		let callable = new Set<string>();
		if (deferred.size > 0) {
			const fold = foldOf(owner, branch, model);
			const inUse = new Set(use.inUse);
			for (const names of freshLoads.values()) for (const name of names) inUse.add(name);
			const last = fold.lastRequest;
			const told = fold.told.get("tools") ?? new Set<string>();
			const announcing = supportsToolAdditions(model) && !fold.opensEpoch ? new Set(searchableTools(all).map((tool) => tool.name).filter((name) => !told.has(name))) : new Set<string>();
			callable = callableDeferredTools(deferred, {
				inUse,
				toldCallable: fold.told.get(CALLABLE_TOOLS) ?? new Set(),
				declaredEager: last ? recordedToolNames(last, { eager: true }) : new Set(),
				announcing,
			});
		}
		const active = pi.getActiveTools();
		const next = reconcileActive(active, deferred, callable, withheldNames, registered);
		if (next !== active) pi.setActiveTools([...next]);
	};
	const reconcileNow = () => reconcile(session, currentModel);

	// On models that take client-side tool references (first-party Claude >= 4.5,
	// not Haiku) every deferred tool rides every Anthropic request as a
	// `defer_loading: true` definition, and a tool that tool_search loaded — which
	// pi promotes into the eager list — is demoted back to deferred and loaded
	// through `tool_reference` blocks in the tool_search result that activated it
	// (lib/deferred.ts stabilizeDeferredTools has the rules;
	// working-docs/decisions/caching.md the measurements). On OpenAI Responses
	// models with native tool loading (GPT-5.4 and newer on openai and
	// openai-codex) a loaded tool leaves `tools` for pi-ai's own load item at the
	// tool_search result instead (stabilizeResponsesToolLoads). Inside an epoch
	// the request carries only its tail here: the ledger's payload hook, later,
	// puts the recorded list in front and keeps the recorded tools.
	pi.on("before_provider_request", (event, ctx) => {
		const allTools = pi.getAllTools();
		const enabled = deferralEnabled(allTools);
		const toolLoadCompat = responsesToolLoadCompat(ctx.model as ResponsesToolLoadModel | undefined);
		if (toolLoadCompat) {
			if (!enabled) return undefined;
			return stabilizeResponsesToolLoads(event.payload as Record<string, unknown>, (name) => deferredRegistry.has(name), loads, toolLoadCompat);
		}
		const original = event.payload as Record<string, unknown>;
		const additions = supportsToolAdditions(ctx.model) && looksLikeAnthropicRequest(original);
		// The context step lifted this request's addenda off their tool results;
		// whatever happens below, they go out (lib/tool-additions.ts).
		const announceAsText = () => {
			const text = additions ? withToolAdditions(original, addendaByCall, false) : undefined;
			return text ? withBetas(text.payload, [MID_CONVERSATION_SYSTEM_BETA]) : undefined;
		};
		if (!enabled || !supportsToolReferences(ctx.model as { provider?: string; id?: string } | undefined) || !looksLikeAnthropicRequest(original)) return announceAsText();
		const isDeferred = (name: string) => deferredRegistry.has(name);
		// A tool that arrived mid-session goes out as Claude Code's tool_addition
		// where the model takes one, declared deferred.
		const lifted = additions ? withToolAdditions(original, addendaByCall) : undefined;
		const stable = stabilizeDeferredTools(lifted?.payload ?? original, allTools, isDeferred, loads, new Set(lifted?.names ?? []));
		// Renamed (OAuth) tools cannot be referenced: the active tools stay as pi
		// rendered them and the addition goes as text.
		if (!stable) return announceAsText();
		return lifted ? withBetas(stable, TOOL_ADDITION_BETAS) : stable;
	});

	pi.events.on(DEFERRED_QUERY_CHANNEL, (data) => {
		const query = data as DeferredQuery;
		for (const name of deferredRegistry.names) query.tools.push({ name, keywords: deferredRegistry.keywordsFor(name) });
	});

	pi.events.on(DEFER_CHANNEL, (data) => {
		const request = data as DeferRequest;
		deferredRegistry.add(request);
		// A withheld tool brought back is deferred again.
		if (request?.name) withheldNames.delete(request.name);
		// A defer arriving after the session_start pass (MCP servers connect
		// asynchronously and register their tools then) would otherwise leave the
		// tool eager AND unlisted.
		if (sessionStarted && request?.name && deferring() && alive()) {
			reconcileNow();
			publishListing();
		}
	});

	pi.events.on(WITHHOLD_CHANNEL, (data) => {
		const name = (data as { name?: string } | undefined)?.name;
		if (!name || !deferredRegistry.remove(name)) return;
		withheldNames.add(name);
		if (!alive()) return;
		reconcileNow();
		publishListing();
	});

	// A /tree switch keeps the process: pi restored the selected branch's
	// loadout, and the selected branch decides which deferred tools are callable
	// and referenced there.
	pi.on("session_tree", (_event, ctx) => {
		freshLoads.clear();
		reconcile(ctx?.sessionManager, ctx?.model ?? currentModel);
	});

	pi.on("session_start", (_event, ctx) => {
		sessionStarted = true;
		currentModel = ctx?.model;
		session = ctx?.sessionManager;
		freshLoads.clear();
		reconcileNow();
		publishListing();
	});
	pi.on("model_select", (event) => {
		currentModel = event.model;
		reconcileNow();
	});
	// Every turn's tools are fixed right after this (pi's prepareRequest): the
	// tools the request announces callable must be active by then.
	pi.on("turn_start", (_event, ctx) => {
		freshLoads.clear();
		if (ctx?.model) currentModel = ctx.model;
		reconcileNow();
	});

	// A compaction opens an epoch, which lists every deferred tool again. The
	// loads that named a loaded tool went with the summary: the tool goes back to
	// deferred, so the new epoch declares it the way it declares the rest (Claude
	// Code declares a deferred tool only while a reference to it is in the
	// history), unless the reconciler keeps it.
	pi.on("session_compact", (_event, ctx) => {
		reconcile(ctx?.sessionManager, ctx?.model ?? currentModel);
		publishListing();
	});

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
		// Without tool_search there is nothing to steer a deferred-tool miss to.
		if (deferredRegistry.has(name) && deferring()) {
			pi.events.emit(REMINDER_CHANNEL, {
				key: `deferred-miss-${name}`,
				text: deferredMissReminderText(name),
			});
		} else if (withheldNames.has(name)) {
			// A withheld tool is gone from the registry too (WITHHOLD_CHANNEL), so
			// the ordinary steer above would send the model to tool_search for a
			// name that will not be found there either.
			pi.events.emit(REMINDER_CHANNEL, {
				key: `deferred-miss-${name}`,
				text: withheldMissReminderText(name),
			});
		} else if (session && recordedToolNames(foldOf(session, branchOf(session), currentModel).lastRequest ?? { head: {}, list: [] }).has(name)) {
			// The epoch's recorded tools stay declared after the tool left the
			// session (a setting turned it off): the call cannot be salvaged, and
			// the model must not keep trying it.
			pi.events.emit(REMINDER_CHANNEL, {
				key: `deferred-miss-${name}`,
				text: unavailableToolReminderText(name),
			});
		}
	});

	pi.registerTool({
		// A literal, like every registration: agent-view-tool-labels.test.ts reads them from source.
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
			const requested = selectedRequests(params.query);
			// A requested tool that is already callable (an eager tool, or one loaded
			// earlier) is a harmless no-op, as in Claude Code: the model proceeds
			// instead of retrying a name it was told does not exist.
			const active = pi.getActiveTools();
			const alreadyActive = (name: string) => active.find((tool) => tool.toLowerCase() === name);
			const unmatched = requested
				? requested.filter((request) => !matches.some((m) => m.name.toLowerCase() === request.name))
				: [];
			const eager = [...new Set(unmatched.flatMap((request) => alreadyActive(request.name) ?? []))];
			const notFound = unmatched.filter((request) => !alreadyActive(request.name));
			// A withheld name can still sit in the frozen listing (withdrawn by a model
			// change after the first request), so it gets "do not retry", not a
			// spelling hint. Both notes quote the model's own spelling.
			const withdrawn = [...new Set(notFound.filter((n) => withheldNames.has(n.name)).map((n) => n.asWritten))];
			const missing = [...new Set(notFound.filter((n) => !withheldNames.has(n.name)).map((n) => n.asWritten))];
			const notFoundNote =
				(missing.length > 0
					? ` Not found (not deferred tool names — check spelling, or search by keyword instead of \`select:\`): ${missing.join(", ")}.`
					: "") +
				(withdrawn.length > 0 ? ` Withdrawn for the current model (do not retry): ${withdrawn.join(", ")}.` : "");

			if (matches.length === 0 && eager.length > 0) {
				return {
					content: [{ type: "text", text: `Already loaded: ${eager.join(", ")}.${notFoundNote}` }],
					details: { matches: eager, added: [] as string[], notFound, refused: [] as string[] },
				};
			}

			if (matches.length === 0) {
				const names = available.map((t) => t.name).join(", ") || "(none)";
				return {
					content: [
						{ type: "text", text: `No tools matched "${params.query}".${notFoundNote} Tools that can be loaded: ${names}` },
					],
					details: { matches: [] as string[], added: [] as string[], notFound, refused: [] as string[] },
					isError: true,
				};
			}

			const matchNames = matches.map((m) => m.name);
			const toActivate = matchNames.filter((name) => !active.includes(name));
			if (toActivate.length > 0) pi.setActiveTools([...new Set([...active, ...toActivate])]);
			// pi can decline to activate a tool: since 1.0.4 a `--tools` list that
			// names no `mcp__*` entry keeps the MCP tools registered but not
			// activatable. Report what pi actually activated, never a plausible load.
			const now = new Set(pi.getActiveTools());
			const added = toActivate.filter((name) => now.has(name));
			const refused = toActivate.filter((name) => !now.has(name));
			if (added.length > 0) {
				freshLoads.set(toolCallId, added);
				loads.set(toolCallId, added);
			}

			const loaded = [...new Set([...matchNames, ...eager])].filter((name) => now.has(name));
			const already = loaded.filter((name) => !added.includes(name));
			const refusedNote =
				refused.length > 0 ? ` Could not load ${refused.join(", ")}: this session's tool list (pi's --tools) leaves them out, so they cannot be called.` : "";
			return {
				content: [
					{
						type: "text",
						text:
							([
								added.length > 0 ? `Loaded ${added.join(", ")}. These tools are now callable.` : "",
								already.length > 0 ? `Already loaded: ${already.join(", ")}.` : "",
							].filter(Boolean).join(" ") + refusedNote + notFoundNote).trim(),
					},
				],
				details: { matches: loaded, added, notFound, refused },
				isError: loaded.length === 0,
			};
		},
	});

	registerLocalCommand(pi, "tools-deferred", {
		description: "Show which tools are deferred (loadable via tool_search)",
		handler: async (args, ctx) => {
			if (!deferring()) {
				ctx.ui.notify("tool_search is not registered (a --tools list leaves it out), so no tool is deferred.", "info");
				return;
			}
			const available = searchableTools();
			const activeSet = new Set(pi.getActiveTools());
			const lines = available.map((t) => `${activeSet.has(t.name) ? "loaded " : "deferred"} ${t.name}`);
			ctx.ui.notify(lines.length ? lines.join("\n") : "No deferred tools registered.", "info");
		},
	});
}
