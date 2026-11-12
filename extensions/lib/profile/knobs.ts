/**
 * The product's environment knobs (decisions/bi-fork.md, "The brand is one
 * static data file"): each has one base spelling, `<envPrefix>_<suffix>`
 * (One Code: `ONECODE_USE_POWERSHELL_TOOL`), and the source provider may add
 * another tool's spelling of the same knob while it is on (One Code's adds
 * Claude Code's `CLAUDE_CODE_*`; independent mode drops them). The product's
 * own spelling wins when both are set.
 *
 * The same lookup serves the process environment and a settings file's `env`
 * block. A blank spelling gives way to a later one that has a value (an empty
 * `<envPrefix>_X` left by a template must not hide the alias); when every set
 * spelling is blank, the first is returned and each reader keeps its own rule
 * for a blank value.
 *
 * Pure: no pi imports.
 */

import os from "node:os";
import { envName } from "./brand.mjs";
import { type EnvAlias, openSources } from "./sources.ts";

/** A knob's value and the spelling that supplied it. */
export interface Knob {
	value: string;
	/** The variable that was set, for messages that name it. */
	name: string;
	/** Set through the provider's alias (another tool's spelling), not the product's own. */
	borrowed: boolean;
}

/** The provider's spelling of knob `suffix`, while the provider is on. */
function aliasOf(suffix: string): EnvAlias | undefined {
	return openSources(os.homedir()).envAliases?.[suffix];
}

/** The spellings of knob `suffix`, the product's own first. */
export function knobNames(suffix: string): string[] {
	const alias = aliasOf(suffix);
	return alias ? [envName(suffix), alias.name] : [envName(suffix)];
}

/**
 * Whether `knob` applies on `model`: the product's own spelling always does,
 * another tool's where its provider says (One Code's: Claude Code's
 * `CLAUDE_CODE_SUBAGENT_MODEL` only on a Claude model).
 */
export function knobAppliesTo(suffix: string, knob: Pick<Knob, "borrowed">, model: { provider: string; id: string }): boolean {
	return !knob.borrowed || (aliasOf(suffix)?.appliesTo?.(model) ?? true);
}

/** The provider's clause for a borrowed knob `suffix` that does not apply, for messages. */
export function knobLimit(suffix: string): string {
	return aliasOf(suffix)?.limit ?? "not applied on this model";
}

/** Knob `suffix` in `vars`, the process environment by default: the first spelling that is set. */
export function readKnob(suffix: string, vars: Readonly<Record<string, unknown>> = process.env): Knob | undefined {
	const names = knobNames(suffix);
	let blank: Knob | undefined;
	for (const name of names) {
		const value = vars[name];
		if (typeof value !== "string") continue;
		const knob = { value, name, borrowed: name !== names[0] };
		if (value.trim() !== "") return knob;
		blank ??= knob;
	}
	return blank;
}

/** `readKnob`'s value alone. */
export function knobValue(suffix: string, vars: Readonly<Record<string, unknown>> = process.env): string | undefined {
	return readKnob(suffix, vars)?.value;
}
