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
 */

import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSettingsForWrite, writeSettings } from "../lib/one-code-settings.ts";

/** Pure merge: set the default model, preserving every other settings key. */
export function applyDefaultModel(
	file: Record<string, unknown>,
	provider: string,
	modelId: string,
): Record<string, unknown> {
	return { ...file, defaultProvider: provider, defaultModel: modelId };
}

/** Quiet period after the last switch before it is written (ctrl+p cycles fire one event per step). */
export const PERSIST_DEBOUNCE_MS = 400;

export default function modelDefaultExtension(pi: ExtensionAPI) {
	let pending: { provider: string; id: string; notify: (message: string) => void } | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const flush = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		const choice = pending;
		pending = undefined;
		if (!choice) return;
		const path = join(getAgentDir(), "settings.json");
		try {
			writeSettings(path, applyDefaultModel(readSettingsForWrite(path), choice.provider, choice.id));
		} catch (error) {
			// Persisting a preference must not break the model switch itself, but
			// say why it will be forgotten (typically a malformed settings.json).
			choice.notify(`Could not save ${choice.provider}/${choice.id} as the default model: ${(error as Error).message}`);
		}
	};

	// Debounced: a ctrl+p cycle emits model_select per step, and only the model
	// the user settles on should hit the disk (last one wins).
	pi.on("model_select", (event, ctx) => {
		const model = event.model as { provider?: string; id?: string } | undefined;
		if (!model?.provider || !model.id) return;
		pending = {
			provider: model.provider,
			id: model.id,
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
