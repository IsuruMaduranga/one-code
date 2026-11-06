/**
 * What a plugin command's body needs from a profile (types only): the text a
 * `` !`command` `` placeholder becomes when its command fails, times out or
 * writes too much. The output itself is the command's.
 */

export interface PluginsText {
	/** The command could not run; `osMessage` is the system's own message. */
	placeholderFailed(p: { osMessage: string }): string;
	/** No bash to run the command in. */
	noBash: string;
	/** After the output the command wrote before its timeout. */
	placeholderTimedOut(p: { seconds: number }): string;
	/** After output cut at the collection limit. */
	outputCut(p: { chars: number }): string;
}
