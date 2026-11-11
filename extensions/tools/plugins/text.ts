/**
 * What a `` !`command` `` placeholder in a plugin command's body becomes
 * when its command fails, times out or writes too much. The output itself is
 * the command's.
 */

export const pluginsText = {
	/** The command could not run; `osMessage` is the system's own message. */
	placeholderFailed: ({ osMessage }: { osMessage: string }): string => `command failed: ${osMessage}`,
	/** No bash to run the command in. */
	noBash: "no bash shell found",
	/** After the output the command wrote before its timeout. */
	placeholderTimedOut: ({ seconds }: { seconds: number }): string => `command timed out after ${seconds} seconds`,
	/** After output cut at the collection limit. */
	outputCut: ({ chars }: { chars: number }): string => `[output cut after ${chars} characters]`,
};
