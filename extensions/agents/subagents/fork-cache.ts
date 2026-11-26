/**
 * The fork's side of reading the parent's prompt cache (decisions/caching.md,
 * "A call that inherits the session's context reads the session's cache").
 *
 * A fork's own session builds its requests from its own system prompt, tools
 * and reminder stack, so every fork re-read the parent's whole transcript
 * uncached: on a parent near a 1M-token window, the whole window per fork.
 * This inline extension, loaded last in a fork's session, sends the parent's
 * last captured request instead, with the fork's own messages after it:
 *
 * - `context_with_system` (it runs after every `context` handler, so the
 *   fork's reminder stack is already on the messages it drops) removes the
 *   messages the capture carries, leaving pi to convert only the fork's tail;
 * - `before_provider_request` (inline extensions load after the path ones, so
 *   tool-search has already edited the body) replaces everything but the tail
 *   with the captured body (`forkRequestPayload`);
 * - `before_provider_headers` sends the parent's session-affinity headers, so a
 *   gateway such as OpenRouter routes the fork to the host holding the cache.
 *
 * One rule keeps the parent's tools block, byte for byte: every tool the
 * parent declared, the fork declares with the parent tool's own `parameters`.
 * The fork's ledger extends the parent's recorded request
 * (`decisions/caching.md`) and keeps a recorded declaration only while the
 * live input schema matches it (lib/request/ledger/wire.ts mergeDeclarations);
 * otherwise it declares the fork's in its place, mid-array, and the cache
 * misses from there. pi validates a call against the live schema, so the
 * tool's execute() gets the parent's shape and refuses what the fork cannot do.
 * It is applied in two places, from the same `ParentTool` handover:
 *
 * - The fork's SDK tools (SendMessage, the spawn tool Agent, the cron and MCP
 *   tools) take the parent's parameters in the runner (`withParentParameters`):
 *   pi lets an SDK tool override any extension registration, so this
 *   extension cannot.
 * - A parent tool the fork lacks (ask_user_question, list_agents, workflow,
 *   yield on a model offered it) gets a stub at session start, which refuses
 *   with what to do instead (`forkToolUnavailable`), so the model's call is not
 *   "tool not found". Only a tool the capture declares gets one (its wire name
 *   mapped to the parent's registry name, `registryNameOnWire`), so the splice
 *   below never adds one: it appends only tools the parent did not declare. A
 *   resume hands over the parent's tools at spawn for any the parent has since
 *   lost (`withSavedParentTools`), so its stub still answers.
 *
 * This holds while a tool's rendering depends on its name and parameters
 * alone; of One Code's tools only pi's read, edit, write and bash set
 * `constrainedSampling`, and every fork has those. A request that goes out
 * whole (below) carries the same declarations.
 *
 * Both steps check the same thing first (the capture's model and its boundary
 * message in this context); when either fails, or the tail leaves less than
 * `MIN_REPLAY_OUTPUT_TOKENS` of the captured output room, the request goes out
 * the ordinary way, whole, and uncached. That happens only for a fork that
 * compacted its own history away, runs on another model, or has nearly
 * filled the window.
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { deferBaseTool, registryNameOnWire } from "../../lib/request/deferred.ts";
import { LEDGER_EPOCH_BODY_CHANNEL, LEDGER_PLAN_CHANNEL, type LedgerEpochBody, type RequestPlan } from "../../lib/request/ledger/plan.ts";
import { listKey } from "../../lib/request/ledger/wire.ts";
import { sessionIdentity } from "../../lib/request/anthropic-auth.ts";
import { type AffinityModel, affinityHeaders, captureDeclarations, captureMatches, forkOutputRoom, forkRequestPayload, forkBaselineNames, MIN_REPLAY_OUTPUT_TOKENS, type RequestCapture, uncoveredMessages } from "../../lib/side-calls/request-replay.ts";
import { RESPONSES_SESSION_HEADER } from "../../lib/side-calls/running-pi-ai.ts";
import { subagentResultText } from "../../lib/agents/subagent-text.ts";
import { toolRenderers } from "../../lib/ui/tui-render.ts";

/** One of the parent's registered tools, as a fork needs it to stand in for the tool. */
export interface ParentTool {
	name: string;
	parameters: unknown;
}

/**
 * The fork's own SDK tools, each declaring the parent tool's parameters where
 * the parent has one of that name (the rule in the header).
 */
export function withParentParameters(tools: readonly ToolDefinition[], parentTools: readonly ParentTool[]): ToolDefinition[] {
	const byName = new Map(parentTools.map((tool) => [tool.name, tool]));
	return tools.map((tool) => {
		const parent = byName.get(tool.name);
		return parent ? { ...tool, parameters: parent.parameters as ToolDefinition["parameters"] } : tool;
	});
}

/**
 * A resumed fork's parent tools: the parent's current ones, plus each tool
 * `saved` (the parent's tools when the fork was spawned, read back from disk)
 * names that the parent no longer registers, so the fork still stubs a tool
 * its saved capture declares after a tool flag or profile removed it. The
 * current parameters win where both have a tool. `saved` is untrusted file
 * content: anything but an array of named tools is ignored.
 */
export function withSavedParentTools(current: readonly ParentTool[], saved: unknown): readonly ParentTool[] {
	if (!Array.isArray(saved)) return current;
	const names = new Set(current.map((tool) => tool.name));
	const missing = saved.filter((tool): tool is ParentTool => typeof (tool as Partial<ParentTool> | null)?.name === "string" && !names.has((tool as ParentTool).name));
	return missing.length ? [...current, ...missing.map((tool) => ({ name: tool.name, parameters: tool.parameters }))] : current;
}

type ModelRef = { api?: string; provider?: string; id?: string };

/** The APIs whose fork splice (`forkRequestPayload`) handles the body's shape. */
const SPLICED_FORK_APIS: ReadonlySet<string> = new Set(["anthropic-messages", "openai-completions", "openai-responses", "azure-openai-responses", "openai-codex-responses"]);

export function forkCacheExtension(capture: RequestCapture, parentTools: readonly ParentTool[] = []) {
	return (pi: ExtensionAPI) => {
		// The fork advertises the parent's tools, where SendMessage is deferred
		// (agents/subagents/index.ts). Defer the fork's own SendMessage the same way, so a
		// tool_search load reaches it: on a model without tool references the load
		// appends it, and elsewhere the parent's compatible schema (to: "main")
		// already declares it. Inline extensions load after tool-search.
		deferBaseTool(pi.events, "SendMessage", ["message", "main", "report", "progress"]);
		// Every other extension has registered its tools by session start.
		pi.on("session_start", () => {
			const own = new Set(pi.getAllTools().map((tool) => tool.name));
			const declared = captureDeclarations(capture);
			const parameters = new Map(parentTools.map((tool) => [tool.name, tool.parameters]));
			const registryName = registryNameOnWire([...parameters.keys()], declared);
			for (const wireName of declared) {
				const tool = registryName(wireName);
				if (tool === undefined || own.has(tool)) continue;
				own.add(tool);
				const refusal = subagentResultText().forkToolUnavailable({ tool });
				pi.registerTool({
					name: tool,
					label: tool,
					...toolRenderers(tool),
					description: refusal,
					parameters: parameters.get(tool) as never,
					async execute() {
						return { content: [{ type: "text", text: refusal }], details: {}, isError: true };
					},
				});
			}
		});

		/**
		 * Set by the context step for the request it shaped, and kept until the
		 * next one: pi-ai can render that request again in the same call (its
		 * strict-tools fallback), from the same cut context, and that body needs
		 * the capture as much as the first.
		 */
		let shaped = false;
		/** The ledger took this request's body in its epoch: the payload step leaves it alone. */
		let ledgerTook = false;
		/** The tool names of the fork's first request: anything added later was loaded during the run. */
		let baseline: Set<string> | undefined;
		/** Whether the fork's model sets its effort with items (its identity's effortMarkers), read when the context step shapes a request. */
		let effortItems = false;

		// One mechanism shapes a fork's request. The fork's own ledger does when
		// it extends a recorded request (its `context` hook, which runs first,
		// has already cut the messages that record covers): cutting and splicing
		// again here sent the record's list a second time after the capture, and
		// the following requests lost the messages between the two. This
		// extension does only when the ledger opens an epoch, and then inside
		// the ledger's payload hook (`LEDGER_EPOCH_BODY_CHANNEL`), so the record
		// holds the capture and the tail and the next request extends both.
		let ledgerExtends = false;
		pi.events.on(LEDGER_PLAN_CHANNEL, (data) => {
			ledgerExtends = (data as RequestPlan).epoch === false;
		});
		const splice = (payload: Record<string, unknown>): Record<string, unknown> => {
			baseline ??= forkBaselineNames(payload, capture.api);
			return forkRequestPayload(capture, payload, baseline, effortItems);
		};
		pi.events.on(LEDGER_EPOCH_BODY_CHANNEL, (data) => {
			// `shaped` is set only for a request whose model the capture matches.
			if (!shaped) return;
			ledgerTook = true;
			const body = data as LedgerEpochBody;
			body.payload = splice(body.payload);
			// The capture's elements the splice left as they were are the parent's
			// cached bytes: the ledger must not redact or re-lay them. A capture's
			// last turn the fork's first one was joined into is the fork's again.
			const key = listKey(capture.api);
			const base = Array.isArray(capture.payload[key]) ? (capture.payload[key] as unknown[]) : [];
			const list = Array.isArray(body.payload[key]) ? (body.payload[key] as unknown[]) : [];
			let kept = 0;
			while (kept < base.length && list[kept] === base[kept]) kept++;
			body.kept = kept;
		});

		pi.on("context_with_system", (event, ctx) => {
			shaped = false;
			ledgerTook = false;
			if (ledgerExtends) return undefined;
			const covers = capture.covers;
			// Bedrock and Google nest their tools and need joined turns and the
			// fork's own abort signal, which the fork splice does not handle: their
			// forks go out whole instead.
			if (!covers || !SPLICED_FORK_APIS.has(capture.api) || !captureMatches(capture, ctx.model as ModelRef | undefined)) return undefined;
			const tail = uncoveredMessages(event.messages as { role: string; timestamp?: number }[], covers);
			if (!tail) return undefined;
			// Too little output room left after the prefix: send the fork whole
			// (pi's overflow handling then compacts it) rather than a splice the
			// window cannot hold. The messages' JSON overstates the wire tail.
			const room = forkOutputRoom(capture, tail.filter((message) => message.role !== "system"));
			if (room !== undefined && room < MIN_REPLAY_OUTPUT_TOKENS) return undefined;
			shaped = true;
			effortItems = sessionIdentity(pi, ctx.model)?.effortMarkers === true;
			return { messages: tail as typeof event.messages };
		});

		// Route to the parent's host: a gateway picks it by the session-affinity
		// headers, and the parent's cache lives there. Harmless on a whole request.
		pi.on("before_provider_headers", (event, ctx) => {
			if (!capture.sessionId || !captureMatches(capture, ctx.model as ModelRef | undefined)) return;
			Object.assign(event.headers, affinityHeaders(ctx.model as AffinityModel, capture.sessionId, RESPONSES_SESSION_HEADER));
		});

		pi.on("before_provider_request", (event, ctx) => {
			if (!shaped || ledgerTook || !captureMatches(capture, ctx.model as ModelRef | undefined)) return undefined;
			// No ledger in this session took the body in its epoch: splice it here.
			return splice(event.payload as Record<string, unknown>);
		});
	};
}
