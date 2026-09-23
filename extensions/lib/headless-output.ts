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

/** A command's answer in a one-shot run: stdout in print mode, stderr in json mode (stdout is the event stream there). */
export function printAnswer(ctx: Pick<ExtensionContext, "mode">, text: string): void {
	if (ctx.mode === "print") console.log(text);
	else console.error(text);
}
