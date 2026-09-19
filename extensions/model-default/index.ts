/**
 * model-default extension — remember the interactively chosen model across
 * restarts (Claude Code parity: a /model selection sticks).
 *
 * pi's own selector persists only through its explicit "set as default" action;
 * plain Enter and `/model <name>` switch the session only, so a restart forgets
 * the choice. One Code persists every interactive model change instead:
 * `model_select` fires only for real in-session switches ("set"/"cycle") —
 * never for the startup model, a `--model` launch, or a resumed session's
 * restore — so those paths keep their pi semantics.
 *
 * The value lands in pi's OWN settings.json under getAgentDir()
 * (`defaultProvider`/`defaultModel`), which pi loads natively at the next
 * startup with its normal precedence (an explicit --model still wins). Safe to
 * write externally: pi's settings save re-reads the file under its lock and
 * merges only the fields pi itself modified, so this key survives pi's writes.
 *
 * The switch is also shown to the model the way Claude Code shows `/model`
 * (a local-command breadcrumb before the next prompt — lib/local-command.ts):
 * CC's stdout is "Set model to `<name>` and saved as your default for new
 * sessions", and since persisting is what this extension does, the claim is
 * true here too (a failed write announces the switch without it). pi handles
 * `/model` before any extension sees the text, so `model_select` — which also
 * covers ctrl+p cycling — is the one signal; the debounce means only the model
 * the user settles on is announced.
 */

import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { announceLocalCommand } from "../lib/local-command.ts";
import { readSettingsForWrite, writeSettings } from "../lib/one-code-settings.ts";

/** Pure merge: set the default model, preserving every other settings key. */
export function applyDefaultModel(
	file: Record<string, unknown>,
	provider: string,
	modelId: string,
): Record<string, unknown> {
	return { ...file, defaultProvider: provider, defaultModel: modelId };
}

/** Claude Code's `/model` stdout line, as captured (2.1.278); without the persisted half when the write failed. */
export function modelSwitchStdout(displayName: string, saved: boolean): string {
	return `Set model to \`${displayName}\`${saved ? " and saved as your default for new sessions" : ""}`;
}

/** Quiet period after the last switch before it is written (ctrl+p cycles fire one event per step). */
export const PERSIST_DEBOUNCE_MS = 400;

export default function modelDefaultExtension(pi: ExtensionAPI) {
	let pending: { provider: string; id: string; name: string; notify: (message: string) => void } | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const flush = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		const choice = pending;
		pending = undefined;
		if (!choice) return;
		const path = join(getAgentDir(), "settings.json");
		let saved = true;
		try {
			writeSettings(path, applyDefaultModel(readSettingsForWrite(path), choice.provider, choice.id));
		} catch (error) {
			// Persisting a preference must not break the model switch itself, but
			// say why it will be forgotten (typically a malformed settings.json).
			saved = false;
			choice.notify(`Could not save ${choice.provider}/${choice.id} as the default model: ${(error as Error).message}`);
		}
		announceLocalCommand(pi, { name: "model", stdout: modelSwitchStdout(choice.name, saved) });
	};

	// Debounced: a ctrl+p cycle emits model_select per step, and only the model
	// the user settles on should hit the disk (last one wins).
	pi.on("model_select", (event, ctx) => {
		const model = event.model as { provider?: string; id?: string; name?: string } | undefined;
		if (!model?.provider || !model.id) return;
		pending = {
			provider: model.provider,
			id: model.id,
			name: model.name || model.id,
			notify: (message) => {
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
			},
		};
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(flush, PERSIST_DEBOUNCE_MS);
		timer.unref?.();
	});

	// A quit inside the quiet period must not lose the choice.
	pi.on("session_shutdown", () => flush());
}
