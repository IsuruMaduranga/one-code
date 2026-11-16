/**
 * Desktop notifications (pure): Claude Code tells the user when it waits for
 * them, through the terminal (an iTerm2, kitty or Ghostty notification, or a
 * bell), and runs the `Notification` hooks with the same message.
 *
 * Two moments, as in Claude Code:
 *
 * - **A prompt waits** (`permission_prompt`): a prompt opened during a turn
 *   (a permission question, the plan approval, a question to the user), or a
 *   described prompt opened at any time (a background subagent's permission
 *   question can arrive while the main session is idle). Every 6 s the
 *   notifier checks for a keypress in the last 6 s, counting from the prompt's
 *   opening, and notifies once when there was none. The opening is not the
 *   user's interaction, so a prompt that opens and closes on its own leaves the
 *   idle notification due. A panel the user opened while idle is theirs and
 *   never notifies.
 * - **The turn ended and the user is away** (`idle_prompt`): 60 s after a run
 *   settles, if the user submitted something this session, has not touched a
 *   key since the run ended, and no prompt is open.
 *
 * The extension that owns a prompt can say what it waits for on
 * `PROMPT_ATTENTION_CHANNEL` just before it opens (the permissions gate names
 * the tool); a prompt nobody described reads "needs your attention". Only the
 * harness describes its prompts (the permissions gate, the plan approval,
 * through `lib/consent/gate-prompt.ts`), so a described prompt waits for the
 * user whether or not a turn is running. The owner withdraws the description
 * once its prompt settles (`PROMPT_ATTENTION_WITHDRAWN_CHANNEL`): one whose
 * prompt never opened (the opener threw, or pi was already tracking an outer
 * prompt) would otherwise describe the next prompt to open, and a panel the
 * user opens while idle would notify as a permission question.
 *
 * Every notification is announced on `DESKTOP_NOTIFICATION_CHANNEL` (the hooks
 * extension runs the `Notification` hooks from it) and then written to the
 * terminal through the channel the user picked (`preferredNotifChannel`,
 * Claude Code's setting and values; `auto` picks by terminal).
 */

import { brandedId } from "../profile/brand.mjs";

/** A notification, announced before it is written: what the `Notification` hooks receive. */
export interface DesktopNotification {
	message: string;
	title?: string;
	/** Claude Code's `notification_type`: `permission_prompt` or `idle_prompt` here; hooks match on it. */
	notificationType: string;
}

/** Every desktop notification, before it reaches the terminal (`DesktopNotification`). */
export const DESKTOP_NOTIFICATION_CHANNEL = brandedId("desktop-notification");

/** What the next prompt waits for, sent by its owner just before it opens (`PromptAttention`). */
export const PROMPT_ATTENTION_CHANNEL = brandedId("prompt-attention");

export interface PromptAttention {
	message: string;
	/** Identifies this description to its withdrawal (`PromptAttentionWithdrawn`). */
	id: object;
}

/** A description whose prompt settled, sent by its owner (`PromptAttentionWithdrawn`). */
export const PROMPT_ATTENTION_WITHDRAWN_CHANNEL = brandedId("prompt-attention-withdrawn");

export interface PromptAttentionWithdrawn {
	id: object;
}

/** Whether a bus payload's `id` is the object `announcePrompt` makes. */
export const isPromptId = (id: unknown): id is object => typeof id === "object" && id !== null;

/**
 * Say what the next prompt waits for, on `PROMPT_ATTENTION_CHANNEL`, just
 * before opening it. Call the returned function once the prompt settles: it
 * withdraws the description if no prompt took it.
 */
export function announcePrompt(events: { emit(channel: string, data: unknown): void }, message: string): () => void {
	const id = {};
	events.emit(PROMPT_ATTENTION_CHANNEL, { message, id } satisfies PromptAttention);
	return () => events.emit(PROMPT_ATTENTION_WITHDRAWN_CHANNEL, { id } satisfies PromptAttentionWithdrawn);
}

/** The words, from the product's name. */
export const desktopNotificationText = {
	permission: (product: string, tool: string) => `${product} needs your permission to use ${tool}`,
	planApproval: (product: string) => `${product} needs your approval for the plan`,
	/** Auto mode's one-time question before its first read outside the working directories. */
	outsideRead: (product: string) => `${product} needs your permission to read outside the working directories`,
	/** The manual approval auto mode falls back to when its review of the call could not run. */
	reviewFallback: (product: string, tool: string) => `${product} needs your permission to use ${tool} (auto mode could not review it)`,
	/** The one-time question whether to trust a repository's allow rules and workspace directories. */
	projectTrust: (product: string) => `${product} needs you to decide whether to trust this repository's permission settings`,
	attention: (product: string) => `${product} needs your attention`,
	idle: (product: string) => `${product} is waiting for your input`,
};

/** How long without a keypress counts as away while a prompt waits, and how often that is checked. */
export const INTERACTION_THRESHOLD_MS = 6000;
/** How long after a run settles an idle user is told the session waits. */
export const IDLE_NOTIFY_MS = 60_000;

/** The timers and clock the scheduler runs on; `every` and `after` return their cancel. */
export interface AttentionIo {
	now(): number;
	every(ms: number, tick: () => void): () => void;
	after(ms: number, fire: () => void): () => void;
	notify(notification: DesktopNotification): void;
}

/** When to notify. Fed by pi's events; writes nothing itself. */
export class AttentionNotifier {
	private lastInteraction: number;
	private working = false;
	private submitted = false;
	private prompts = 0;
	/** The next prompt's description and the id its withdrawal names. */
	private attention: PromptAttention | undefined;
	private cancelPrompt: (() => void) | undefined;
	private cancelIdle: (() => void) | undefined;
	private stopped = false;

	constructor(
		private readonly io: AttentionIo,
		private readonly product: string,
	) {
		this.lastInteraction = io.now();
	}

	/** A keypress, or anything else the user did. */
	interacted(): void {
		this.lastInteraction = this.io.now();
	}

	/** The user submitted a prompt. */
	submittedPrompt(): void {
		this.submitted = true;
		this.interacted();
	}

	/** The owner of the next prompt says what it waits for. */
	describeNextPrompt(message: string, id: object): void {
		this.attention = { message, id };
	}

	/** The owner's prompt settled: drop its description if no prompt took it, never a later one. */
	withdrawPrompt(id: object): void {
		if (this.attention?.id === id) this.attention = undefined;
	}

	turnStarted(): void {
		this.working = true;
		this.cancelIdle?.();
		this.cancelIdle = undefined;
	}

	turnSettled(): void {
		this.working = false;
		if (this.stopped || !this.submitted) return;
		const settledAt = this.io.now();
		this.cancelIdle?.();
		this.cancelIdle = this.io.after(IDLE_NOTIFY_MS, () => {
			this.cancelIdle = undefined;
			if (this.stopped || this.working || this.prompts > 0 || this.lastInteraction > settledAt) return;
			this.io.notify({ message: desktopNotificationText.idle(this.product), notificationType: "idle_prompt" });
		});
	}

	/** An outermost prompt opened (`ui_prompt_start`). */
	promptOpened(): void {
		this.prompts++;
		const described = this.attention !== undefined;
		const message = this.attention?.message ?? desktopNotificationText.attention(this.product);
		this.attention = undefined;
		// While idle, only a described prompt counts: an undescribed one is a panel the user opened.
		if (this.stopped || (!this.working && !described) || this.prompts > 1) return;
		// Not `interacted()`: the user did not open it, and a described prompt
		// opened while idle (a background agent's) must not cancel the idle notice.
		// The 6 s check counts from the opening too.
		const openedAt = this.io.now();
		this.cancelPrompt = this.io.every(INTERACTION_THRESHOLD_MS, () => {
			if (this.io.now() - Math.max(this.lastInteraction, openedAt) < INTERACTION_THRESHOLD_MS) return;
			this.cancelPrompt?.();
			this.cancelPrompt = undefined;
			if (!this.stopped) this.io.notify({ message, notificationType: "permission_prompt" });
		});
	}

	/** The prompt closed (`ui_prompt_end`). */
	promptClosed(): void {
		this.prompts = Math.max(0, this.prompts - 1);
		this.attention = undefined;
		if (this.prompts > 0) return;
		this.cancelPrompt?.();
		this.cancelPrompt = undefined;
	}

	/** The session ended: cancel everything; nothing fires after this. */
	stop(): void {
		this.stopped = true;
		this.cancelPrompt?.();
		this.cancelIdle?.();
		this.cancelPrompt = undefined;
		this.cancelIdle = undefined;
	}
}

// ---- Writing to the terminal ----------------------------------------------

/** Claude Code's `preferredNotifChannel` values. */
export type NotificationChannel = "auto" | "iterm2" | "iterm2_with_bell" | "kitty" | "ghostty" | "terminal_bell" | "notifications_disabled";

const CHANNELS: readonly NotificationChannel[] = ["auto", "iterm2", "iterm2_with_bell", "kitty", "ghostty", "terminal_bell", "notifications_disabled"];

/** A setting's channel; anything else is `auto`. */
export function notificationChannel(value: unknown): NotificationChannel {
	return CHANNELS.includes(value as NotificationChannel) ? (value as NotificationChannel) : "auto";
}

/** The terminal, by Claude Code's order of checks for the ones a channel can reach. */
export function detectTerminal(env: NodeJS.ProcessEnv): string | undefined {
	if (env.TERM === "xterm-ghostty") return "ghostty";
	if (env.TERM?.includes("kitty")) return "kitty";
	if (env.TERM_PROGRAM) return env.TERM_PROGRAM;
	if (env.TMUX) return "tmux";
	if (env.STY) return "screen";
	if (env.KITTY_WINDOW_ID) return "kitty";
	return undefined;
}

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;

/** An OSC sequence; kitty takes the ST terminator, the others BEL. */
function osc(terminal: string | undefined, ...parts: (string | number)[]): string {
	return `${ESC}]${parts.join(";")}${terminal === "kitty" ? ST : BEL}`;
}

/** Pass a sequence through tmux or screen to the terminal outside. */
export function wrapForMultiplexer(sequence: string, env: NodeJS.ProcessEnv): string {
	if (env.TMUX) return `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ST}`;
	if (env.STY) return `${ESC}P${sequence}${ST}`;
	return sequence;
}

/** Strip what would end an OSC early (control characters), so a message cannot break out of it. */
function plain(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove them
	return text.replace(/[\x00-\x1f\x7f]/g, " ");
}

/**
 * The bytes that show `notification` on this terminal, in write order; none
 * when the channel is off or `auto` finds no way (Apple Terminal, a terminal
 * it does not know, or inside tmux, where `TERM_PROGRAM` names tmux).
 */
export function notificationWrites(
	channel: NotificationChannel,
	notification: { message: string; title?: string },
	defaultTitle: string,
	env: NodeJS.ProcessEnv,
	kittyId: number,
): string[] {
	const terminal = detectTerminal(env);
	const message = plain(notification.message);
	// iTerm2 shows a title only when the notification has one; kitty and Ghostty need one.
	const own = notification.title === undefined ? undefined : plain(notification.title);
	const title = own ?? plain(defaultTitle);
	const iterm2 = () => [wrapForMultiplexer(osc(terminal, 9, `\n\n${own ? `${own}:\n${message}` : message}`), env)];
	const kitty = () => [
		wrapForMultiplexer(osc(terminal, 99, `i=${kittyId}:d=0:p=title`, title), env),
		wrapForMultiplexer(osc(terminal, 99, `i=${kittyId}:p=body`, message), env),
		wrapForMultiplexer(osc(terminal, 99, `i=${kittyId}:d=1:a=focus`, ""), env),
	];
	const ghostty = () => [wrapForMultiplexer(osc(terminal, 777, "notify", title, message), env)];
	switch (channel) {
		case "iterm2":
			return iterm2();
		case "iterm2_with_bell":
			return [...iterm2(), BEL];
		case "kitty":
			return kitty();
		case "ghostty":
			return ghostty();
		case "terminal_bell":
			// Raw: inside tmux a bare bell sets the window's bell flag.
			return [BEL];
		case "notifications_disabled":
			return [];
		case "auto":
			if (terminal === "iTerm.app") return iterm2();
			if (terminal === "kitty") return kitty();
			if (terminal === "ghostty") return ghostty();
			return [];
	}
}
