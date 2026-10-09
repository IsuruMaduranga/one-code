/** User-only model-upgrade advice. No reminders, transcript entries, or request hooks. */
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelSpec } from "../lib/model-policy.ts";
import { MODEL_UNUSABLE_CHANNEL, type ModelUnusableEvent, withoutUnusable } from "../lib/model-unusable.ts";
import { newerModelSuggestion } from "../lib/newer-model.ts";
import { sessionOutlivesTurn } from "../lib/notifications.ts";
import { readSuggestNewerModels } from "../lib/one-code-settings.ts";

export default function newerModelExtension(pi: ExtensionAPI) {
	const shown = new Set<string>();
	const unusable = new Set<string>();
	pi.events.on(MODEL_UNUSABLE_CHANNEL, (data) => unusable.add((data as ModelUnusableEvent).model));

	const suggest = (ctx: ExtensionContext, model = ctx.model) => {
		if (!sessionOutlivesTurn(ctx.mode) || !ctx.hasUI || !model || !readSuggestNewerModels(homedir())) return;
		const key = JSON.stringify([ctx.sessionManager.getSessionId(), modelSpec(model)]);
		if (shown.has(key)) return;
		const suggestion = newerModelSuggestion(withoutUnusable(ctx.modelRegistry.getAvailable(), unusable), model);
		if (!suggestion) return;
		ctx.ui.notify(`${suggestion.text} ${suggestion.fix}`, "info");
		shown.add(key);
	};

	// Local catalog/cache reads only. Never await a network refresh at startup.
	// Session ids also handle RPC's duplicate session_start for a new session.
	pi.on("session_start", (_event, ctx) => suggest(ctx));
	pi.on("model_select", (event, ctx) => suggest(ctx, event.model));
}
