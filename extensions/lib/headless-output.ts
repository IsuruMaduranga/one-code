/**
 * Output from a command in a one-shot run (`-p`, `--mode json`), where
 * `ctx.ui.notify` is a no-op: pi wires no UI context there, so a message sent
 * through it vanishes and the command exits silently.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * A user-facing notice: a TUI/RPC toast where there is UI, otherwise stderr.
 * `console.error` never corrupts the `--mode json` event stream on stdout.
 */
export function notifyOrPrint(ctx: Pick<ExtensionContext, "hasUI" | "ui">, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else console.error(message);
}

/**
 * Whether the session can show a custom TUI component: a panel opened through
 * `ctx.ui.custom`, or a component widget. RPC has UI but forwards only dialogs,
 * notices and string-array widgets: its `custom()` resolves undefined and a
 * component factory vanishes, so a command falls back to text there.
 */
export function canShowCustomUi(ctx: Pick<ExtensionContext, "hasUI" | "mode">): boolean {
	return ctx.hasUI && ctx.mode !== "rpc";
}

/** In RPC, say that a command whose panel cannot open shows a read-only listing instead. */
export function notifyRpcReadOnly(ctx: Pick<ExtensionContext, "mode" | "ui">, command: string, manage: string): void {
	if (ctx.mode === "rpc") ctx.ui.notify(`${command} in RPC is read-only; use the TUI to ${manage}.`, "info");
}

/** A command's answer in a one-shot run: stdout in print mode, stderr in json mode (stdout is the event stream there). */
export function printAnswer(ctx: Pick<ExtensionContext, "mode">, text: string): void {
	if (ctx.mode === "print") console.log(text);
	else console.error(text);
}
