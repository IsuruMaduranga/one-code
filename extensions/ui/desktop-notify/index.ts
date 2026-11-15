/**
 * desktop-notify extension — Claude Code's desktop notifications: when a
 * prompt has waited with no keypress, or a finished turn has sat a minute
 * with the user away, tell them through the terminal and run the
 * `Notification` hooks (lib/notify/desktop.ts has the rules and the bytes).
 *
 * TUI only: a one-shot or RPC run has nobody at a terminal to call back
 * (Claude Code's notifications live in its interactive screen too). Every
 * timer belongs to one session's notifier, stopped at session_shutdown, so
 * nothing fires after the session ends.
 *
 * The sequences go straight to stdout, between pi's frames: an OSC
 * notification draws nothing, so it cannot disturb the screen pi drew.
 */

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	AttentionNotifier,
	DESKTOP_NOTIFICATION_CHANNEL,
	type DesktopNotification,
	notificationChannel,
	notificationWrites,
	isPromptId,
	PROMPT_ATTENTION_CHANNEL,
	PROMPT_ATTENTION_WITHDRAWN_CHANNEL,
	type PromptAttention,
	type PromptAttentionWithdrawn,
} from "../../lib/notify/desktop.ts";
import { brand } from "../../lib/profile/brand.mjs";
import { feature } from "../../lib/profile/feature.ts";
import { unrefAfter, unrefEvery } from "../../lib/core/timer-ops.ts";
import { productSettingsPath, readSettingsForWrite } from "../../lib/profile/product-settings.ts";

/** The user's `preferredNotifChannel` from One Code's settings, read when a notification goes out. */
function preferredChannel() {
	try {
		return notificationChannel(readSettingsForWrite(productSettingsPath(homedir())).preferredNotifChannel);
	} catch {
		return notificationChannel(undefined);
	}
}

function desktopNotifyExtension(pi: ExtensionAPI) {
	let notifier: AttentionNotifier | undefined;
	let inputHookRegistered = false;

	const notify = (notification: DesktopNotification) => {
		pi.events.emit(DESKTOP_NOTIFICATION_CHANNEL, notification satisfies DesktopNotification);
		const writes = notificationWrites(preferredChannel(), notification, brand.name, process.env, Math.floor(Math.random() * 10000));
		for (const bytes of writes) process.stdout.write(bytes);
	};

	pi.on("session_start", (_event, ctx) => {
		notifier?.stop();
		notifier = undefined;
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		notifier = new AttentionNotifier(
			{
				now: () => Date.now(),
				every: unrefEvery,
				after: unrefAfter,
				notify,
			},
			brand.name,
		);
		// Once per process: session_start fires again on /clear and session
		// switches, and the listener reads whichever notifier is current.
		if (inputHookRegistered) return;
		inputHookRegistered = true;
		ctx.ui.onTerminalInput(() => {
			notifier?.interacted();
			return undefined; // observe only
		});
	});
	pi.on("input", (event) => {
		if (event.source === "interactive") notifier?.submittedPrompt();
	});
	pi.events.on(PROMPT_ATTENTION_CHANNEL, (data) => {
		const { message, id } = (data as Partial<PromptAttention> | undefined) ?? {};
		if (typeof message === "string" && isPromptId(id)) notifier?.describeNextPrompt(message, id);
	});
	pi.events.on(PROMPT_ATTENTION_WITHDRAWN_CHANNEL, (data) => {
		const id = (data as Partial<PromptAttentionWithdrawn> | undefined)?.id;
		if (isPromptId(id)) notifier?.withdrawPrompt(id);
	});
	pi.on("agent_start", () => notifier?.turnStarted());
	pi.on("agent_settled", () => notifier?.turnSettled());
	pi.on("ui_prompt_start", () => notifier?.promptOpened());
	pi.on("ui_prompt_end", () => notifier?.promptClosed());
	pi.on("session_shutdown", () => {
		notifier?.stop();
		notifier = undefined;
	});
}

export default feature("desktop-notify", desktopNotifyExtension);
