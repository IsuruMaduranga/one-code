/**
 * Tiny-tier-only strict delegation directive (pure prompt text), riding the
 * context stack right after the agent catalog. Static prompt sections
 * measurably move capable models to delegate broad sweeps (workhorse/cheap
 * went 2/6 → 6/6 in the 2026-08-31 probe battery) but a sub-Haiku model
 * ignored the same section (qwen3.6-27b: 0/6 with it verified on the wire); a
 * <system-reminder> sits closer to the user text, where weak models actually
 * attend. Keyed and byte-stable, so it is cache-neutral; removed when a model
 * switch leaves the tiny tier (see index.ts emitDelegationSteer).
 *
 * Sibling texts (same delegation policy, separately tuned registers):
 * DELEGATE_STRICT in system-prompt/tiers/low.ts (tiny prompt) and
 * DELEGATING_WORK in tiers/mid.ts (workhorse/cheap prompt). The shared policy
 * invariants are pinned by test/unit/delegation-prose.test.ts — when editing
 * one register, keep the siblings aligned or that test will say so.
 */

export const DELEGATION_STEER = [
	"Delegation policy: when a request requires reading MANY files (a codebase overview, how a feature works across modules, exploring unfamiliar code), do NOT sweep the files yourself.",
	'Make one Agent tool call per independent question, with subagent_type: "explore" and the complete question as the task; for several independent questions, issue those calls together in one message. The agent searches in its own separate context and returns just the answer; reading file after file yourself fills your context and degrades your answer.',
	"Search directly for a single targeted lookup: one known file or symbol, or a word one grep can find everywhere.",
	"When the agent has answered, report its answer and move on — do not re-read the files it already covered, except one you are about to edit (an edit needs a read first).",
].join("\n");
