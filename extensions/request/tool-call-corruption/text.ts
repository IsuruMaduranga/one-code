/**
 * What the tool-call-corruption extension needs from a profile (types only):
 * why a call's arguments look damaged (request/tool-call-corruption/tool-call-corruption.ts decides),
 * and the block the model gets for a suspect call and a corrupt one.
 */

/** What is wrong with a call's raw arguments. */
export type ArgumentDamage =
	| { kind: "notOneJson" }
	/** The command ends with an option and nothing after it (`option` as it appears). */
	| { kind: "cutAfterOption"; option: string }
	| { kind: "unbalancedQuote" };

export interface ToolCallCorruptionText {
	damage(damage: ArgumentDamage): string;
	/** A suspect call, returned once so the model can resend it; `reason` is the damage worded. */
	suspectBlock(p: { reason: string }): string;
	/** A corrupt call, which ends the turn; `repeat` when an earlier command in the run came through cut the same way. */
	corruptBlock(p: { reason: string; repeat: boolean }): string;
}
