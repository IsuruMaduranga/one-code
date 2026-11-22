/**
 * help extension, Claude Code's `/help`: a tabbed panel with the shortcuts
 * (the same rows as the `?` panel under the prompt) and the command list
 * (lib/ui/shortcuts-help.ts draws it). pi has no `/help`; its `/hotkeys`
 * prints pi's own key table.
 *
 * The command list is the slash menu's own: a pass-through autocomplete
 * wrapper keeps the provider beneath it (the skill extension's wrapper loads
 * first, so the rows are already `/name`, untagged and sorted), and `/help`
 * asks it for the bare `/` menu. In RPC and one-shot runs no panel can open
 * and pi builds no menu, so `/help` prints the same content as text, the
 * commands taken from `pi.getCommands()`.
 *
 * Display only: the command is registered with pi directly, not through
 * `registerLocalCommand`, so running it adds nothing to the next request.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
// pi's loader maps this import to pi's own module, so keyText reads the keybindings pi loaded.
import { keyText as piKeyText } from "@earendil-works/pi-coding-agent";
import { canShowCustomUi, printAnswer } from "../../lib/notify/headless-output.ts";
import { PI_BUILTIN_COMMANDS } from "../../lib/plugins/skill-invoke.ts";
import { brand } from "../../lib/profile/brand.mjs";
import { feature } from "../../lib/profile/feature.ts";
import { knobValue } from "../../lib/profile/knobs.ts";
import { featureEnabled } from "../../lib/profile/profile.ts";
import { keyId } from "../../lib/ui/key-input.ts";
import { modeCycleKey, taskToggleKey } from "../../lib/ui/keys.ts";
import { panelUi } from "../../lib/ui/panel-focus.ts";
import { applyHelpKey, type HelpCommand, type HelpData, helpListRows, helpPanelLines, helpText, initialHelpState } from "../../lib/ui/shortcuts-help.ts";
import { shortcutColumns } from "../../lib/ui/shortcuts-model.ts";
import { boundedDockHeight, safeThemeBold, safeThemeInverse, safeThemePaint, truncateLine } from "../../lib/ui/tui-render.ts";

type Provider = Parameters<Parameters<ExtensionContext["ui"]["addAutocompleteProvider"]>[0]>[0];

/** The panel's height cap, as the other docked panels use. */
const HELP_MAX_HEIGHT = 30;

const userKey = (binding: string): string => piKeyText(binding as Parameters<typeof piKeyText>[0]);

function helpExtension(pi: ExtensionAPI) {
	let menu: Provider | undefined;

	pi.on("session_start", (_event, ctx) => {
		menu = undefined;
		if (ctx.hasUI && ctx.mode === "tui") {
			ctx.ui.addAutocompleteProvider((current) => {
				menu = current;
				return current;
			});
		}
	});

	const registered = () => {
		try {
			return pi.getCommands();
		} catch {
			return [];
		}
	};

	/** The bare `/` menu's rows, or the registered commands where pi builds no menu. */
	const commandList = async (): Promise<HelpCommand[]> => {
		if (menu) {
			try {
				const suggestions = await menu.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
				if (suggestions) return suggestions.items.map((item) => ({ name: item.value, ...(item.description ? { description: item.description } : {}) }));
			} catch {
				// Fall back to the registered commands.
			}
		}
		return registered()
			.map((command) => ({ name: command.name, ...(command.description ? { description: command.description } : {}) }))
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	};

	const helpData = async (ctx: ExtensionContext): Promise<HelpData> => {
		const commands = await commandList();
		const custom = new Set(registered().flatMap((command) => (command.source === "prompt" ? [command.name] : [])));
		const names = new Set(registered().map((command) => command.name));
		// The prompt editor's own keys exist only where branding installs it (extensions/ui/branding).
		const editor = ctx.mode === "tui" && featureEnabled("branding") && knobValue("NO_INPUT_MARKER") !== "1";
		return {
			intro: `${brand.name}, ${brand.subtitle}.`,
			shortcuts: shortcutColumns({
				keyText: userKey,
				modeCycleKey: modeCycleKey(),
				taskToggleKey: taskToggleKey(),
				hasCommand: (name) => PI_BUILTIN_COMMANDS.has(name) || names.has(name),
				...(editor ? { editorKeys: { stash: "ctrl+s", historySearch: "ctrl+r" } } : {}),
			}),
			commands: commands.filter((command) => !custom.has(command.name)),
			custom: commands.filter((command) => custom.has(command.name)),
			moreHelp: `${brand.homepage}/tree/master/${brand.guideDir}`,
		};
	};

	pi.registerCommand("help", {
		description: "Show keyboard shortcuts and the command list",
		handler: async (_args, ctx) => {
			const data = await helpData(ctx);
			if (!canShowCustomUi(ctx)) {
				if (ctx.hasUI) ctx.ui.notify(helpText(data), "info");
				else printAnswer(ctx, helpText(data));
				return;
			}
			await panelUi(pi.events, ctx.ui).custom<null>((tui, theme, _keybindings, done) => {
				const paint = { fg: safeThemePaint(theme), bold: safeThemeBold(theme), inverse: safeThemeInverse(theme) };
				const state = initialHelpState();
				const rows = () => (tui as { terminal?: { rows?: number } }).terminal?.rows ?? 30;
				let cache: { width: number; lines: string[] } | undefined;
				let lastWidth = 80;
				return {
					render: (width: number) => {
						lastWidth = width;
						if (cache?.width === width) return cache.lines;
						const height = boundedDockHeight(rows(), HELP_MAX_HEIGHT);
						const lines = helpPanelLines(state, data, width, height, paint).map((line) => truncateLine(line, width));
						cache = { width, lines };
						return lines;
					},
					handleInput: (input: string) => {
						const listRows = helpListRows(boundedDockHeight(rows(), HELP_MAX_HEIGHT), lastWidth, state.tab);
						if (applyHelpKey(state, keyId(input), data, listRows) === "close") {
							done(null);
							return;
						}
						cache = undefined;
						tui.requestRender();
					},
					invalidate: () => {
						cache = undefined;
					},
				};
			});
		},
	});
}

export default feature("help", helpExtension);
