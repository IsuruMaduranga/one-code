/**
 * Frontier tier — Anthropic Opus/Fable ≥ 4.8 and Sonnet ≥ 5. The lean register:
 * the same sections pincer shipped before tiering, so the built prompt is
 * byte-identical to the pre-tiering output for these models (regression guard in
 * `test/unit/template.test.ts`). Splitting `IDENTITY`/`SECURITY` into two
 * sections joins back to the old combined constant since sections join on "\n\n".
 */

import {
	CONTEXT_MANAGEMENT,
	CORRECTIONS,
	DELIVERING_WORK,
	HARNESS,
	IDENTITY,
	type PromptBundle,
	SECURITY,
	STYLE,
} from "./common.ts";

export const frontierBundle: PromptBundle = {
	lead: [IDENTITY, SECURITY, HARNESS, STYLE],
	tail: [CONTEXT_MANAGEMENT, DELIVERING_WORK, CORRECTIONS],
	verboseMemory: false,
};
