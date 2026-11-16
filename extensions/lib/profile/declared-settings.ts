/**
 * The settings a profile declares for its own extensions (`Profile.settings`,
 * lib/profile/settings-keys.ts), read the way the base reads its own simple
 * keys: leniently, from the product's own files only. The user file first,
 * then, for a setting declared with `project`, the per-project file in the
 * product's state folder, which wins. Never a repository's file, another
 * tool's file or the managed file: a declared setting tunes the product's
 * extension for its user, and nothing a repository supplies reaches it.
 *
 * A product extension reads one through `extensions/sdk/extension.ts`
 * (`productSetting`), and /doctor lists them (commands/doctor/compat.ts).
 */

import { homedir } from "node:os";
import { readJsonFile } from "../core/atomic-write.ts";
import { activeProfile } from "./profile.ts";
import { productProjectSettingsPath, productSettingsPath } from "./product-settings.ts";
import type { ProductSetting } from "./settings-keys.ts";
import { sourceSwitch } from "./sources.ts";

/** A declared setting's value, or undefined when no file sets it with its declared type. */
export type ProductSettingValue = boolean | string | number;

/** `value` when it has the declared type (a number must be finite); /doctor reports by the same test. */
export function typed(value: unknown, setting: ProductSetting): ProductSettingValue | undefined {
	if (typeof value !== setting.type) return undefined;
	return typeof value === "number" && !Number.isFinite(value) ? undefined : (value as ProductSettingValue);
}

/**
 * The value of setting `key`, which the profile must declare (a misspelled
 * key throws, naming the declared ones). A missing file, malformed JSON or a
 * value of another type counts as that file not setting it; undefined when
 * none does.
 */
export function productSetting(key: string, cwd: string, home: string = homedir(), env: NodeJS.ProcessEnv = process.env): ProductSettingValue | undefined {
	const setting = activeProfile().settings.get(key);
	if (!setting) {
		const declared = [...activeProfile().settings.keys()];
		throw new Error(`"${key}" is not a setting the profile declares (declared: ${declared.length > 0 ? declared.join(", ") : "none"}): add it to the profile's \`settings\` first.`);
	}
	// The source provider's switch is saved in the product's user file too, and the provider loads after the profile's load check.
	if (key === sourceSwitch()?.key) throw new Error(`"${key}" is the source provider's switch, which the base reads from the product's settings file: declare the setting under another name.`);
	const paths = [productSettingsPath(home, env), ...(setting.project ? [productProjectSettingsPath(cwd, home, env)] : [])];
	let value: ProductSettingValue | undefined;
	for (const path of paths) {
		const file = readJsonFile<unknown>(path);
		// Own keys only: a declared `constructor` must not read Object.prototype's.
		const found = file !== null && typeof file === "object" && !Array.isArray(file) && Object.hasOwn(file, key) ? typed((file as Record<string, unknown>)[key], setting) : undefined;
		if (found !== undefined) value = found;
	}
	return value;
}

/** The declared settings read from the product's user file (`user`) or its per-project file (`local`), for /doctor. */
export function declaredSettingsIn(scope: "user" | "local"): [string, ProductSetting][] {
	return [...activeProfile().settings].filter(([, setting]) => scope === "user" || setting.project === true);
}
