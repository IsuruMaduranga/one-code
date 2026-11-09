/** Successful PreCompact hook output, scoped to the compaction that requested it. */

import { brandedId } from "../profile/brand.mjs";
export const PRECOMPACT_INSTRUCTIONS_CHANNEL = brandedId("precompact-instructions");

export interface PreCompactInstructions {
	signal: AbortSignal;
	instructions: string;
}
