# Model tiering decisions

Why One Code tiers models the way it does. Implementation detail + phase plan
live in [`../features/tiering/`](../features/tiering/plan.md); this file is the
durable rationale (choices + rejected alternatives). Settled and ratified
2026-08-17.

## Four capability tiers, not three (2026-08-17)

**Choice:** `frontier / workhorse / cheap / tiny`, up from `frontier / mid /
low`.

**Why:** the tier's only job is to pick a prompt register + tool surface, and
there are four distinct jobs, not three. CC itself ships **two** registers —
terse for Opus (~7.4k, capture `cc-opus.json`), verbose for Sonnet **and**
Haiku (~28.8k; `cc-sonnet.json` and `cc-haiku.json` differ only in boilerplate
+ one steering line: Haiku gets `"Use TaskCreate to plan and track work…"`).
One Code's audience extends **below** Haiku (cheap open models, flash/nano/mini
classes on every provider) where even the verbose prompt under-instructs, so a
fourth `tiny` register (verbose + weak-model scaffolding + search tools) earns
its place. Each tier maps to a real capture we hold:

| tier | register source | search tools |
|---|---|---|
| frontier | cc-opus (terse) | no |
| workhorse | cc-sonnet (verbose) | no |
| cheap | cc-haiku (= workhorse + TaskCreate line) | no |
| tiny | custom (= cheap + scaffolding) | grep/find/ls |

**Rejected:** keeping three tiers — forces `cheap` and `tiny` to share a
register, and the sub-Haiku audience is exactly where scaffolding matters most.

## Frontier is a version-gated Opus/Fable allowlist, not a score cutoff (2026-08-17)

**Choice:** only Anthropic Opus ≥ 4.7, Fable, and Opus-5 get the terse frontier
register. Everything else — Sonnet included — is at most `workhorse`.

**Why:** "frontier = minimal scaffolding" is a claim a model is strong enough
to need almost no prompt help, and CC answers it empirically by giving *only*
Opus the terse prompt (Sonnet+Haiku get verbose). An intelligence-index cutoff
can't make this call: at high/max effort even flash models benchmark into the
"frontier" band (see below), which would hand them the leanest prompt —
backwards. So frontier stays a curated, version-gated allowlist.

**Consequence:** strong third-party models (GPT-5.x, Gemini-Pro, Grok, Kimi,
Qwen-Max) land in `workhorse` — the verbose register — even though they
benchmark as well as Opus. Deliberate: One Code imposes a CC-style harness and
gives capable-but-not-Anthropic-frontier models the fuller instructions.

## Tiering by name-class + curated map; AA index is offline-only (2026-08-17)

**Choice:** the non-frontier tier = the **more-scaffolded** of two signals —
an intel-derived tier (from a **baked, curated anchor map**) and a **name-class
cap** (flash/mini/small/-air/haiku → cheap; nano/-lite/tiny/distill/≤8B →
tiny). Capability can only lower scaffolding; a lean/fast model class can only
raise it. Unlisted models fall back to name-class + price, biased low, never
frontier. The Artificial Analysis Intelligence Index is used **offline** to
build/validate the map — **never** as a runtime classifier.

**Why not wire the AA index at runtime** (measured live, AA v2 API, 2026-08-17):
- **It measures the wrong thing** — capability-at-max-effort on a benchmark,
  not reliability in a long agentic harness at the effort users actually run.
  It splits by effort (`GPT-5.6 Sol (max)` 60.9 vs `(Non-reasoning)` 41.9), and
  at high effort flash/nano models score "frontier" (`Gemini 3.7 Flash (high)`
  = 56 > `GPT-5.5 (high)` = 54.7). The index literally cannot express "flash
  needs more scaffolding"; only the *name* does.
- **No Anthropic mid-effort data** (`claude-sonnet-5-high` = None) — the
  anchors have to be hardcoded regardless (they're also the register sources).
- **Version-variant collisions** misroute flagships (base `GPT-5` = 17.3 → tiny).
- **The index rescales per version**, so absolute cutoffs rot; a runtime
  dependency would also add a network call and a failure mode.

**Rejected:** the pure four-cutoff (50/35/20) algorithm from the design
prototype — it over-promotes flash/nano/luna and has no entry for Haiku. Kept
as an **offline generator** (`model_tiers.py` → a `.claude/skills/` refresh
tool) whose output is human-curated before baking.

## grep/find/ls belong to `tiny` only (2026-08-17)

**Choice:** activate pi's grep/find/ls built-ins only in the `tiny` register;
`frontier`/`workhorse`/`cheap` rely on bash for search.

**Why:** current CC ships **no** standalone Grep/Glob/LS on any tier, Haiku
included — its Haiku (4.5) drives bash for search reliably. So `cheap` (the
Haiku-equivalent register) matches CC exactly by dropping them. But One Code's
`tiny` tier serves models weaker than anything CC ships to, where an explicit
search tool with a rigid schema is cheap insurance against malformed-search
failures. Reserving the crutch for `tiny` keeps CC parity above it and helps
only where it's needed. **Ratified overrides in the anchor map:** GPT-5-full →
workhorse (AA's base variant is a weak-scoring outlier), GPT-5-mini → cheap,
GPT-5.6-Luna → cheap (OpenAI's cheap line despite a high benchmark).
