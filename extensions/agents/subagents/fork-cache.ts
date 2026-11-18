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
 * The parent's tools block declares tools only the main conversation has
 * (ask_user_question, list_agents, workflow, yield on a model offered it), so a
 * fork's model can call one its own session lacks, and pi answers "tool not
 * found". At session start the fork registers a stub for each such tool, which
 * refuses with what to do instead (`forkToolUnavailable`). The wire keeps the
 * parent's tools block, byte for byte, on both of a fork's paths:
 *
 * - Only a tool the capture declares gets a stub (its wire name mapped to the
 *   parent's registry name, `registryNameOnWire`), so the splice below never
 *   adds one: it appends only tools the parent did not declare.
 * - Each stub takes the parent tool's own `parameters`, so the fork's ledger,
 *   which extends the parent's recorded request (`decisions/caching.md`),
 *   keeps the recorded declaration: it puts a live one in its place only when
 *   the input schema differs (lib/request/ledger/wire.ts mergeDeclarations).
 *   This holds while a stubbed tool's rendering depends on its name and
 *   parameters alone; of One Code's tools only pi's read, edit, write and bash
 *   set `constrainedSampling`, and every fork has those.
 *
 * A request that goes out whole (below) carries the stubs, which mirror the
 * parent's tools.
 *
 * Both steps check the same thing first (the capture's model and its boundary
 * message in this context); when either fails, or the tail leaves less than
 * `MIN_REPLAY_OUTPUT_TOKENS` of the captured output room, the request goes out
 * the ordinary way, whole, and uncached. That happens only for a fork that
 * compacted its own history away, runs on another model, or has nearly
 * filled the window.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deferBaseTool, registryNameOnWire } from "../../lib/request/deferred.ts";
import { type AffinityModel, affinityHeaders, captureMatches, forkOutputRoom, forkRequestPayload, forkBaselineNames, MIN_REPLAY_OUTPUT_TOKENS, type RequestCapture, uncoveredMessages } from "../../lib/side-calls/request-replay.ts";
import { RESPONSES_SESSION_HEADER } from "../../lib/side-calls/running-pi-ai.ts";
import { subagentResultText } from "../../lib/agents/subagent-text.ts";
import { toolRenderers } from "../../lib/ui/tui-render.ts";

/** One of the parent's registered tools, as a fork needs it to stand in for the tool. */
export interface ParentTool {
	name: string;
	parameters: unknown;
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
			const declared = forkBaselineNames(capture.payload, capture.api);
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

		/** Set by the context step for the request it shaped; the payload step splices only then. */
		let shaped = false;
		/** The tool names of the fork's first request: anything added later was loaded during the run. */
		let baseline: Set<string> | undefined;

		pi.on("context_with_system", (event, ctx) => {
			shaped = false;
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
			return { messages: tail as typeof event.messages };
		});

		// Route to the parent's host: a gateway picks it by the session-affinity
		// headers, and the parent's cache lives there. Harmless on a whole request.
		pi.on("before_provider_headers", (event, ctx) => {
			if (!capture.sessionId || !captureMatches(capture, ctx.model as ModelRef | undefined)) return;
			Object.assign(event.headers, affinityHeaders(ctx.model as AffinityModel, capture.sessionId, RESPONSES_SESSION_HEADER));
		});

		pi.on("before_provider_request", (event, ctx) => {
			if (!shaped || !captureMatches(capture, ctx.model as ModelRef | undefined)) return undefined;
			shaped = false;
			const payload = event.payload as Record<string, unknown>;
			baseline ??= forkBaselineNames(payload, capture.api);
			return forkRequestPayload(capture, payload, baseline);
		});
	};
}
