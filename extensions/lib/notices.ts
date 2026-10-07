/**
 * Lifecycle notices from several extensions, shown as one info line.
 *
 * pi folds back-to-back info notices into a single status line, and every
 * status line renders the latest status text (findings §63). On session_start
 * and model_select several extensions announce something, so each info notice
 * overwrote the one before it. Those extensions call `queueNotice` instead of
 * `ctx.ui.notify`; one owner per event bus collects the notices until the
 * event's handlers have run (pi awaits each handler in turn, so one microtask
 * is not enough: the batch closes on the next macrotask), then shows the
 * warnings and errors first, each on its own, and ONE info notice joining the
 * info texts with newlines.
 *
 * The owner is elected the way `session-model-tier.ts` elects its own: no
 * module state is shared between extensions (each has its own jiti copy), so
 * the first caller on a bus installs the listener and every later caller finds
 * it there. Without a UI the notice goes straight to `ctx.ui.notify`, exactly
 * as before (a no-op in print and json mode).
 *
 * Only lifecycle notices go through here. Command output and a warning or
 * error an extension shows on its own stay direct `ctx.ui.notify` calls.
 */

import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const NOTICE_CHANNEL = "one-code:notice";

export type NoticeLevel = "info" | "warning" | "error";

type NoticeCtx = Pick<ExtensionContext, "hasUI" | "ui">;

interface NoticeMessage {
	ctx: NoticeCtx;
	level: NoticeLevel;
	text: string;
	/** Set by the owner when it took the notice. */
	taken?: boolean;
}

/** Queue a lifecycle notice for the bus's owner, installing the owner if this bus has none. */
export function queueNotice(events: Pick<EventBus, "emit" | "on">, ctx: NoticeCtx, level: NoticeLevel, text: string): void {
	if (!ctx.hasUI) {
		ctx.ui.notify(text, level);
		return;
	}
	const message: NoticeMessage = { ctx, level, text };
	events.emit(NOTICE_CHANNEL, message);
	if (message.taken) return;
	installNoticeOwner(events);
	events.emit(NOTICE_CHANNEL, message);
}

function installNoticeOwner(events: Pick<EventBus, "on">): void {
	let pending: NoticeMessage[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	const flush = () => {
		timer = undefined;
		const batch = pending;
		pending = [];
		showNotices(batch);
	};
	events.on(NOTICE_CHANNEL, (data) => {
		const message = data as NoticeMessage;
		if (message.taken) return;
		message.taken = true;
		pending.push(message);
		timer ??= setTimeout(flush, 0);
	});
}

/** Warnings and errors first, each on its own, then one info notice joining the rest. */
export function showNotices(batch: readonly NoticeMessage[]): void {
	for (const notice of batch) {
		if (notice.level !== "info") notifySafely(notice.ctx, notice.text, notice.level);
	}
	const info = batch.filter((notice) => notice.level === "info");
	if (info.length > 0) notifySafely(info[info.length - 1].ctx, info.map((notice) => notice.text).join("\n"), "info");
}

/** A session replaced before the batch closed leaves a stale ctx: the notice has nowhere to go. */
function notifySafely(ctx: NoticeCtx, text: string, level: NoticeLevel): void {
	try {
		ctx.ui.notify(text, level);
	} catch {
		// Stale session: drop it.
	}
}
