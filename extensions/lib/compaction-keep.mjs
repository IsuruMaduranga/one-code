/**
 * pi's compaction keep window (`compaction.keepRecentTokens`), set to 0 for
 * One Code.
 *
 * One Code's compaction keeps only the last assistant reply, as Claude Code
 * does (`compaction/cut.ts`), so pi's window of recent tokens kept verbatim
 * (20,000 by default) no longer decides what stays. It still decides whether
 * a compaction can happen: pi's `prepareCompaction` gives up with "Nothing to
 * compact (session too small)" when the whole session fits in the window,
 * before any extension sees the request, so `/compact` on a short session
 * failed. At 0, pi cuts at the last reply itself and any session with one
 * finished turn compacts (findings §8).
 *
 * The bundled app writes 0 into its own settings unless the user set a value;
 * on the user's own pi, One Code asks once (`branding/compaction-keep.ts`) and
 * `/doctor` shows the setting.
 *
 * Plain JS with no pi imports, like replaced-builtins.mjs: app/bin.mjs loads it
 * on bare Node before pi does.
 */

/** The keep window One Code wants. */
export const ONE_CODE_KEEP_RECENT_TOKENS = 0;

/** pi's default when no settings file sets one. */
const PI_DEFAULT_KEEP_RECENT_TOKENS = 20000;

/**
 * Settings with the keep window set to One Code's when the user has not set
 * one; `changed` says whether anything was written. An explicit value, pi's
 * default included, is the user's and stays.
 */
export function withCompactionKeepBackfilled(settings) {
	const compaction = settings?.compaction;
	if (compaction !== undefined && (typeof compaction !== "object" || compaction === null || Array.isArray(compaction))) return { settings, changed: false };
	if (compaction?.keepRecentTokens !== undefined) return { settings, changed: false };
	return { settings: { ...settings, compaction: { ...compaction, keepRecentTokens: ONE_CODE_KEEP_RECENT_TOKENS } }, changed: true };
}

/**
 * The keep window pi will use for `modelKey` (`provider/id`), and where it
 * comes from, as pi resolves it: the model's `compaction.modelOverrides` entry
 * first, then the ordinary setting; the project's settings win over the
 * user's in each; `default` when nothing sets it. `model` names the override
 * that supplied the value.
 */
export function compactionKeepView(userSettings, projectSettings, modelKey) {
	// Set means defined, as for the backfill; pi itself rejects a non-integer.
	const read = (value) => (value === undefined ? undefined : Number(value));
	const scopes = [
		["project", projectSettings],
		["user", userSettings],
	];
	if (modelKey !== undefined) {
		for (const [source, settings] of scopes) {
			const value = read(settings?.compaction?.modelOverrides?.[modelKey]?.keepRecentTokens);
			if (value !== undefined) return { value, source, model: modelKey };
		}
	}
	for (const [source, settings] of scopes) {
		const value = read(settings?.compaction?.keepRecentTokens);
		if (value !== undefined) return { value, source };
	}
	return { value: PI_DEFAULT_KEEP_RECENT_TOKENS, source: "default" };
}

export const KEEP_YES = "Yes, set it to 0";
export const KEEP_NO = "No, leave the setting";

/** The startup question on the user's own pi. */
export function keepWindowPrompt(settingsPath) {
	return [
		`One Code compacts like Claude Code: it keeps only the last reply after the summary.`,
		`pi's compaction.keepRecentTokens (${PI_DEFAULT_KEEP_RECENT_TOKENS} by default) no longer changes what is kept; it only makes /compact refuse a session shorter than that.`,
		`Set it to 0 in ${settingsPath}? It takes effect from the next start.`,
	].join("\n");
}

/** The fix /doctor names for a keep window above 0, in the settings file (and model override) that sets it. */
export function keepWindowFix(settingsPath, model) {
	const key = model === undefined ? `"keepRecentTokens": 0` : `"modelOverrides": { "${model}": { "keepRecentTokens": 0 } }`;
	return `Set "compaction": { ${key} } in ${settingsPath}, then restart.`;
}
