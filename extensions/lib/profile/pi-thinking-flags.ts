/**
 * Whether pi's launch flags set the thinking level: `--thinking <level>`,
 * `--model <pattern>:<level>` and `--models` entries with a `:<level>`
 * suffix. pi resolves them before any extension loads and exposes none of
 * them to an extension, so the profile's tier default
 * (lib/models/tier-thinking.ts) reads them from the arguments, as the tool
 * flags are read (lib/profile/pi-tool-flags.ts).
 *
 * A copy of pi's rules (pi-coding-agent 1.5.2: `cli/args.js` parseArgs,
 * `main.js` where `--thinking` wins over a model's suffix and a scoped
 * model's level, `core/model-resolver.js` splitThinkingSuffix). A pattern's
 * suffix counts when it is one of pi's levels; pi tries the whole pattern as
 * a model id first, and no model id ends in a level name. A leveled
 * `--models` entry counts for the whole launch: pi applies it at startup and
 * again when ctrl+p cycles to that model. `pi-thinking-flags.test.ts` checks
 * the parse against pi's own `parseArgs`.
 */

import { VALUE_FLAGS } from "./pi-tool-flags.ts";
import { isThinkingLevelName } from "./thinking-defaults.ts";

/** The thinking-related flags, as pi's `parseArgs` returns them. */
export interface ParsedThinkingFlags {
	thinking?: string;
	model?: string;
	models?: string[];
}

/** The thinking-related flags in `args` (the arguments after the command), as pi's `parseArgs` reads them: the last of each wins, nothing after `--` counts. */
export function parseThinkingFlags(args: readonly string[]): ParsedThinkingFlags {
	const flags: ParsedThinkingFlags = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") break;
		if (!VALUE_FLAGS.has(arg) || i + 1 >= args.length) continue;
		const value = args[++i];
		// pi warns about an unknown level and keeps none.
		if (arg === "--thinking" && isThinkingLevelName(value)) flags.thinking = value;
		else if (arg === "--model") flags.model = value;
		else if (arg === "--models") flags.models = value.split(",").map((s) => s.trim()).filter((pattern) => pattern.length > 0);
	}
	return flags;
}

/** Whether a model pattern ends in `:<level>`. */
function hasLevelSuffix(pattern: string): boolean {
	const colon = pattern.lastIndexOf(":");
	return colon !== -1 && isThinkingLevelName(pattern.slice(colon + 1));
}

/** Whether the flags set the thinking level for the launch. */
export function launchSetsThinking(flags: ParsedThinkingFlags): boolean {
	return flags.thinking !== undefined || (flags.model !== undefined && hasLevelSuffix(flags.model)) || (flags.models ?? []).some(hasLevelSuffix);
}
