/**
 * system-reminder extension, the renderer of the record-once request path
 * (lib/reminders.ts has the placement contract, extensions/ledger the design).
 * It owns the live reminder state every other extension feeds over
 * `one-code:system-reminder`: the `first-prepend` stack and the open sticky
 * states. A one-shot is persisted when emitted, as a `one-code:pending` entry,
 * and delivered from the ledger's outbox.
 *
 * Its `context` hook runs right after the ledger's, which has cut the request
 * to its tail and published the plan. It renders onto that tail only: the
 * stack when the request opens an epoch, the sticky states, the pending
 * one-shots, and the blocks capability owners add on RENDER_CHANNEL (live
 * minus what the epoch told). It writes into the plan which pending items the
 * request carries and what its new blocks tell, and the ledger records both
 * with the request. Nothing is snapshotted or restored: everything above the
 * tail is the record.
 *
 * On a model that takes a mid-conversation system message (lib/system-role.ts),
 * its `before_provider_request` hook lifts the stack's session-fact blocks off
 * the first user message into one system message after it (an epoch's request
 * only), and shapes the tail's `<total_tokens>` lines (lib/turn-budget-layout.ts).
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CLEAR_AT_BETA, MID_CONVERSATION_SYSTEM_BETA, reseatMessageMark, withBetas } from "../lib/anthropic-payload.ts";
import { emptyToolResultContent } from "../lib/empty-tool-result.ts";
import { foldBranch } from "../lib/ledger/fold.ts";
import { LEDGER_PLAN_CHANNEL, type RequestPlan } from "../lib/ledger/plan.ts";
import { type EntryLike, makeRecord, type PendingRecordData, RECORD } from "../lib/ledger/records.ts";
import { claudeFamily } from "../lib/model-tier.ts";
import { extensionVersion } from "../lib/package-version.ts";
import { LiveReminders, type OneShot, REMINDER_CHANNEL, RENDER_CHANNEL, type RenderRequest, renderReminders, type ReminderPayload, stickyFact } from "../lib/reminders.ts";
import { sessionAlive } from "../lib/session-lifecycle.ts";
import { instructionRole, messagesKey, type MovedBlock, systemRoleLayout, wireShape, withSystemRoleContext } from "../lib/system-role.ts";
import { resolveCountdowns, withTurnBudgetMessages } from "../lib/turn-budget-layout.ts";

/** Whether requests carry the `<total_tokens>` budget lines (`CC_TOTAL_TOKENS=0` turns them off). */
const budgetMarkers = () => process.env.CC_TOTAL_TOKENS !== "0";

/** A pending entry as a one-shot to place. */
function oneShotOf(item: PendingRecordData): OneShot {
	return {
		id: item.id,
		text: item.text,
		placement: item.placement ?? "last-append",
		...(item.raw ? { raw: true } : {}),
		...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
		...(item.once ? { once: true } : {}),
		...(item.orTail ? { orTail: true } : {}),
	};
}

export default function systemReminderExtension(pi: ExtensionAPI) {
	const alive = sessionAlive(pi);
	const by = extensionVersion();
	const live = new LiveReminders();
	/** The plan the ledger published for the request being rendered. */
	let plan: RequestPlan | undefined;
	/** One-shots emitted before the session started (an extension's load): persisted at session_start. */
	let early: ReminderPayload[] | undefined = [];
	/** Without the ledger (a test harness, a session that does not load it): the pending ids this instance delivered. */
	const deliveredHere = new Set<string>();

	const persist = (payload: ReminderPayload) => {
		const data = makeRecord("pending", by, {
			id: randomUUID(),
			text: payload.text as string,
			placement: payload.placement === "user-prepend" ? "user-prepend" : "last-append",
			...(payload.key ? { key: payload.key } : {}),
			...(payload.raw ? { raw: true } : {}),
			...(payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
			...(payload.once ? { once: true } : {}),
			...(payload.orTail ? { orTail: true } : {}),
			...(payload.untilCompaction ? { untilCompaction: true } : {}),
		});
		pi.appendEntry(RECORD.pending, data);
	};

	pi.events.on(REMINDER_CHANNEL, (data) => {
		const payload = data as ReminderPayload | undefined;
		if (!payload || live.apply(payload) !== "one-shot") return;
		if (early) early.push(payload);
		else if (alive()) persist(payload);
	});
	pi.on("session_start", () => {
		const queued = early ?? [];
		early = undefined;
		for (const payload of queued) persist(payload);
	});
	pi.events.on(LEDGER_PLAN_CHANNEL, (data) => {
		plan = data as RequestPlan;
	});

	// A tool's empty result is normalized before anything else reads it. Read's
	// raw bytes stay for file-tracker's empty-file warning.
	pi.on("tool_result", (event) => {
		const replacement = emptyToolResultContent(event.content, event.toolName);
		if (!replacement) return;
		return { content: replacement, ...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}) };
	});

	/** The stack blocks the last `context` pass placed for the system message; the payload hook moves them. */
	let moved: MovedBlock[] = [];
	/** Whether the last `context` pass rendered an epoch: only then does the first user message carry the stack. */
	let epochRequest = true;
	/** The tool results' countdowns the last `context` pass lifted, by call id (lib/turn-budget-layout.ts). */
	let countdowns = new Map<string, number>();

	pi.on("context", (event, ctx) => {
		const current = plan;
		plan = undefined;
		const layout = systemRoleLayout(ctx.model);
		const epoch = current?.epoch ?? true;
		const fold = current?.fold ?? foldBranch(ctx.sessionManager.getBranch() as EntryLike[]);

		// Owners add nothing on an epoch (the live stack is rendered), so the told maps need no reset here.
		const request: RenderRequest = { epoch, told: fold.told, modes: fold.modes, toldBlocks: fold.blocks, model: ctx.model, blocks: [] };
		pi.events.emit(RENDER_CHANNEL, request);
		const oneShots: OneShot[] = [
			...fold.pending.filter((item) => !deliveredHere.has(item.id)).map(oneShotOf),
			...request.blocks.map((block) => ({ text: block.text, placement: "last-append" as const, ...(block.facts ? { facts: block.facts } : {}) })),
		];
		const stack = live.stackEntries();
		// A sticky state's first delivery is told, so a failed request's revokes and an epoch renders it again.
		const toldBlocks = epoch ? new Map<string, string>() : fold.blocks;
		const sticky = live.stickyEntries().map((entry) => {
			const fact = stickyFact(entry);
			return { ...entry, fact, delivered: toldBlocks.get(fact.key) === fact.hash };
		});
		const rendered = renderReminders(event.messages, { epoch, layout: layout !== undefined, stack, sticky, oneShots });
		const stickyFacts = sticky.filter((entry) => !entry.delivered && rendered.stickyPlaced.includes(entry.key)).map((entry) => entry.fact);

		const consumed = rendered.placed.flatMap((shot) => (shot.id ? [shot.id] : []));
		// Each fact with the text that carries it: a repair that drops the text drops the fact.
		const carried = [
			...(epoch && rendered.stackPlaced ? stack.filter((entry) => layout !== undefined || !entry.systemRoleOnly).map((entry) => ({ text: entry.text, facts: entry.facts ?? [] })) : []),
			...rendered.placed.map((shot) => ({ text: shot.text, facts: shot.facts ?? [] })),
			...sticky.filter((entry) => stickyFacts.includes(entry.fact)).map((entry) => ({ text: entry.text, facts: [entry.fact] })),
		].filter((block) => block.facts.length > 0);
		const facts = carried.flatMap((block) => block.facts);
		if (current) {
			current.consumed.push(...consumed);
			current.facts.push(...facts);
			current.carried.push(...carried);
		} else {
			for (const id of consumed) deliveredHere.add(id);
		}

		moved = rendered.moved;
		epochRequest = epoch;
		// Each tool result's <total_tokens> countdown, lifted for a system message
		// or framed, while the result's blocks are still separate (lib/turn-budget-layout.ts).
		// With the budget off no result carries one, so a tool's own such line stays its output.
		countdowns = new Map();
		const resolved = budgetMarkers() && ctx.model && wireShape(ctx.model.api) ? resolveCountdowns(rendered.messages, layout !== undefined) : undefined;
		if (resolved) countdowns = resolved.left;
		const out = resolved?.messages ?? rendered.messages;
		const changed = out.length !== event.messages.length || out.some((message, i) => message !== event.messages[i]);
		return changed ? { messages: out } : undefined;
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		const shape = model ? wireShape(model.api) : undefined;
		if (!model || !shape) return undefined;
		const layout = systemRoleLayout(model);
		const role = instructionRole(shape, model);
		let payload = event.payload as Record<string, unknown>;
		if (layout) payload = withSystemRoleContext(payload, layout, moved, role) ?? payload;
		// Claude Code's per-turn <total_tokens> shapes; first-party Fable also
		// gets its clear_at nudge after each tool result.
		const firstParty = model.provider === "anthropic";
		const nudge = layout === "anthropic" && firstParty && claudeFamily(model.id) === "fable";
		payload = withTurnBudgetMessages(payload, { shape, systemRole: layout !== undefined, role, left: countdowns, nudge, markers: budgetMarkers(), stackCarrier: epochRequest }) ?? payload;
		if (payload !== event.payload && shape === "anthropic") {
			const key = messagesKey(shape);
			payload = { ...payload, [key]: reseatMessageMark(payload[key] as Array<{ role?: unknown; content?: unknown }>) };
		}
		// The betas go on every request of a model that takes the layout: an
		// earlier request's system messages are part of every later one.
		if (layout === "anthropic" && firstParty) payload = withBetas(payload, nudge ? [MID_CONVERSATION_SYSTEM_BETA, CLEAR_AT_BETA] : [MID_CONVERSATION_SYSTEM_BETA]);
		return payload === event.payload ? undefined : payload;
	});
}
