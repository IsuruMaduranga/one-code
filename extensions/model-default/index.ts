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
 * covers ctrl+p cycling — is the one signal.
 *
 * The write and the breadcrumb wait for the model the user settles on: the
 * quiet period after the last switch, or the next prompt, whichever comes
 * first. So a ctrl+p cycle through ten models writes the settings once and
 * queues one breadcrumb, which names the write's real outcome. A quit,
 * /reload, /new or /resume inside the quiet period still writes the settings,
 * but cannot queue the breadcrumb: system-reminder stops persisting one-shots
 * in its `session_shutdown` handler, which runs before this extension's. The
 * choice is recorded on the branch instead, and the next session on that
 * branch (the reload, a resume) announces it while its model is still the
 * one chosen.
 */

import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isObject } from "../lib/ledger/records.ts";
import { readState, recordState } from "../lib/ledger/state.ts";
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

/** Quiet period after the last switch before it is written and announced (ctrl+p cycles fire one event per step). */
export const PERSIST_DEBOUNCE_MS = 400;

/** The `/model` breadcrumb's pending-entry key: a later switch's breadcrumb replaces an undelivered one. */
const BREADCRUMB_KEY = "local-command:model";

/**
 * The `one-code:state` key of a switch not yet announced: recorded at every
 * switch (`saved` unset until the settings write), so the branch, not this
 * process's timer, says a breadcrumb is owed; null once announced or dropped.
 */
const UNANNOUNCED_STATE = "model-breadcrumb";

/** A settled switch, as announced. */
interface Settled {
	provider: string;
	id: string;
	name: string;
	saved: boolean;
}

/** A switch the branch records, as `model_select` or a shutdown left it. */
type Unannounced = Omit<Settled, "saved"> & { saved?: boolean };

export default function modelDefaultExtension(pi: ExtensionAPI) {
	let pending: { provider: string; id: string; name: string; notify: (message: string) => void } | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const announce = (name: string, saved: boolean) => announceLocalCommand(pi, { name: "model", stdout: modelSwitchStdout(name, saved), key: BREADCRUMB_KEY });

	/** Save `provider/id` as the default model, and say whether it was saved. */
	const save = (provider: string, id: string, notify: (message: string) => void): boolean => {
		const path = join(getAgentDir(), "settings.json");
		try {
			writeSettings(path, applyDefaultModel(readSettingsForWrite(path), provider, id));
			return true;
		} catch (error) {
			// Persisting a preference must not break the model switch itself, but
			// say why it will be forgotten.
			notify(`Could not save ${provider}/${id} as the default model: ${(error as Error).message}`);
			return false;
		}
	};

	/** Write the switch the user settled on, if any, and say whether it was saved. */
	const settle = (): Settled | undefined => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		const choice = pending;
		pending = undefined;
		if (!choice) return undefined;
		return { provider: choice.provider, id: choice.id, name: choice.name, saved: save(choice.provider, choice.id, choice.notify) };
	};
	const flush = () => {
		const settled = settle();
		if (!settled) return;
		announce(settled.name, settled.saved);
		recordState(pi, UNANNOUNCED_STATE, null);
	};

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
		// Owed from now on, whatever happens to this process: a fresh one on a
		// copy of the branch owes the same breadcrumb (lifecycle-grid-hunt oracle).
		recordState(pi, UNANNOUNCED_STATE, { provider: model.provider, id: model.id, name: pending.name } satisfies Unannounced);
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(flush, PERSIST_DEBOUNCE_MS);
		timer.unref?.();
	});

	// A prompt sent inside the quiet period carries the switch's breadcrumb, not the request after it.
	pi.on("before_agent_start", () => flush());

	// A quit inside the quiet period must not lose the choice: the write happens
	// now, and the breadcrumb waits on the branch for the next session.
	pi.on("session_shutdown", () => {
		const settled = settle();
		if (settled) recordState(pi, UNANNOUNCED_STATE, settled);
	});
	// A switch the branch still owes a breadcrumb: announced here when the
	// session runs that model, saved first if its own process never got to it.
	pi.on("session_start", (_event, ctx) => {
		const stored = readState(ctx, UNANNOUNCED_STATE);
		if (!isObject(stored)) return;
		recordState(pi, UNANNOUNCED_STATE, null);
		const { provider, id, name, saved } = stored;
		if (typeof provider !== "string" || typeof id !== "string" || typeof name !== "string") return;
		if (ctx.model?.provider !== provider || ctx.model?.id !== id) return;
		const notify = (message: string) => {
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
		};
		announce(name, typeof saved === "boolean" ? saved : save(provider, id, notify));
	});
}
