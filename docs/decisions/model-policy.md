# Model policy

Part of [Decisions](../decisions.md).

## Shared role profiles: smaller classifiers and delegated workers by default

A real OpenAI Codex session exposed two different defaults with the same costly
result: selecting `gpt-5.6-sol` made the banner read `classifier 5.6-sol
(planned)` and `subagents 5.6-sol (session)`. The classifier's provider table
predated Luna and 5.4 Mini, so its deliberate "session before anything chosen
only by price" fallback did exactly what it should. Subagents had a separate,
intentional session-model default. Workflow `agent()` had a third path: it
always received `ctx.model`, so it did not actually honour `/subagent` despite
the command and reminder saying it did.

The fix is one pure policy layer (`extensions/lib/model-policy.ts`) shared by
both selectors, but **not one shared capability rule**:

- classifier profiles contain only reviewed small-but-capable families; price
  alone can never promote a model into the security boundary;
- subagent profiles prefer economical coding/reasoning models, then may use a
  cheaper price-ranked model when the provider policy says containment is
  knowable;
- explicit classifier, per-call, agent-frontmatter, and `/subagent` choices
  retain their old precedence and may cross providers because naming one is
  choosing it; `inherit` explicitly suppresses automatic selection;
- both roles finish at the session model rather than breaking the feature.

Automatic subagent selection is a *cost optimisation*, and review tightened it
to demand cost evidence: it engages only when both the session model and the
candidate carry real prices and the candidate is strictly cheaper. Without that
rule an unpriced catalog let the profile's order silently *upgrade* a haiku
session to sonnet-class. The price-ranked fallback (for when the profile has
gone stale) additionally requires one of the known small-model name words and
ranks those tiers ahead of raw price — otherwise the absolute cheapest
contained model became the default coding worker, which on a mainstream catalog
is nano/lite-tier or something wholly unknown. And once any *explicit* choice
(agent frontmatter or configured default) fails to resolve, automatic selection
stays out of it: substituting a cheaper vetted model for a model somebody named
is a model nobody described, so the remaining chain and then the session model
serve.

The profile inventory was checked on 2026-08-06 against pi 0.84.0's generated
catalog and official model pages: [Anthropic](https://platform.claude.com/docs/en/about-claude/models/overview),
[OpenAI](https://developers.openai.com/api/docs/models),
[Google](https://ai.google.dev/gemini-api/docs/models),
[xAI](https://docs.x.ai/developers/models),
[Mistral](https://docs.mistral.ai/getting-started/models/models_overview/),
[DeepSeek](https://api-docs.deepseek.com/quick_start/pricing),
[Z.AI](https://docs.z.ai/), [Qwen Coding Plan](https://help.aliyun.com/en/model-studio/coding-plan),
[Kimi](https://platform.kimi.ai/docs/models),
[MiniMax](https://platform.minimax.io/docs/guides/models-intro),
[Xiaomi](https://mimo.mi.com/docs/quick-start/summary/model), and
[Ant Ling](https://developer.ant-ling.com/en/docs/models/ling/). Hosted-profile
IDs came from the official catalogs for [NVIDIA NIM](https://build.nvidia.com/models),
[Groq](https://console.groq.com/docs/models),
[Cerebras](https://inference-docs.cerebras.ai/models/overview),
[Fireworks](https://fireworks.ai/models),
[Together](https://docs.together.ai/docs/serverless/models),
[Baseten](https://www.baseten.co/products/model-apis/), and
[Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/models/).
The lists are intentionally short prefixes applied to the *live authenticated
catalog*, not copied catalogs; unavailable entries simply fall through.

All 39 built-in pi language-model provider IDs have an explicit policy. Direct
vendors contain to the provider. Stable hosted inference services such as Groq
and NVIDIA contain to that host even when IDs carry publisher-like prefixes.
Gateways require more care:

- OpenRouter's `creator/model` prefix identifies a model namespace, **not the
  serving inference provider**; automatic switching stays in that namespace and
  reuses its direct-family profile, but One Code cannot claim processor
  containment because pi exposes none of OpenRouter's provider-routing options
  ([official routing semantics](https://openrouter.ai/docs/guides/routing/provider-selection)).
- Vercel likewise separates creator IDs from serving providers; profile reuse
  stays in the creator namespace ([provider options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options)).
- Cloudflare's generated pi catalog strips some upstream prefixes, so route
  identity comes from API/base transport rather than slash parsing
  ([provider integrations](https://developers.cloudflare.com/ai-gateway/providers/)).
- Bedrock containment includes geography plus family: an automatic choice may
  not move from `us.` to `eu.` or `global.`. Opaque application-profile ARNs
  stay on the session model ([model IDs](https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html)).
- Hugging Face, Radius, OpenCode Zen, OpenCode Go, unknown aliases, and custom
  providers whose route cannot be established are session-only automatically.
  Hugging Face repository IDs in particular do not name the serving inference
  provider unless a provider suffix is pinned
  ([routing docs](https://huggingface.co/docs/inference-providers/en/index)).

With no explicit default, an OpenAI Codex Sol session now plans both its
classifier and delegated workers on Luna. The banner labels the latter `(auto)`
rather than implying it came from settings. `workflow/index.ts` passes the same
user/managed default into `AgentRunner`, and workflow calls no longer bypass
the automatic resolver when `model` is omitted.

Verified against fresh pi processes: the TUI banner showed `model 5.6-sol ·
subagents 5.6-luna (auto)`; an omitted-model foreground subagent recorded
`openai-codex/gpt-5.6-luna`; and an omitted-model synchronous workflow completed
on the same low-cost path. Luna's classifier was exercised in both directions
without `--dangerously-skip-permissions`: an exact user-named `/tmp` write was
allowed by verified intent, while a delegated outside-project backup path was
blocked under S5. Typecheck and all 682 unit tests passed.

## Upward cost pressure: an informational warning and a per-call gate

Automatic selection only ever moves cost *down*, but two paths still let a
subagent run on something pricier than the session model: a configured default
(deliberate cheap-driver/strong-worker setups exist) and the per-call `model`
field (chosen by the main model itself). Those get different treatment because
their authors differ:

- **Configured default pricier than the session model** → one informational
  line in the every-turn reminder, with both prices. It suggests a cheaper
  listed model for routine tasks but does not tell the model to override the
  user's knob — the user set it, and second-guessing a user setting from the
  reminder would invert authority.
- **Per-call `model` pricier than the session model** → the subagent tool
  errors with both prices and the menu, and workflow `agent()` throws, unless
  the call sets `allow_expensive: true` (`allowExpensive` in agent() opts). The
  schema tells the model to set it only when the user explicitly asked for that
  model. Only `source: "call"` resolutions are gated: `subagentModel`, the env
  var, agent-file frontmatter, and `inherit` are user-installed choices, and
  the codebase rule is that naming a model is choosing it.

The gate opens when either price is unknown — a cost gate that fails closed on
an unpriced catalog blocks the feature outright, the same failure shape as
gating a tool other tools sit behind.

## Tier-based selection replaces the role-profile tables (2026-08-18)

**Choice:** the per-provider `ROLE_PROFILES` tables (and `findRoleProfileModel`,
`hasSmallModelName`/`hintRank`, `allowsDynamicSubagentSelection`) are gone.
Automatic selection for both the classifier and subagents now runs through one
shared tier selector, `economicalContainedCandidates` /
`cheaperContainedCandidates` in `extensions/lib/model-tier.ts`: the cheapest
*capable* same-provider model, ranked cheap → workhorse → frontier, never
`tiny`, never dearer than the session model. The classifier appends the session
model as the terminal fallback; the subagent uses `strict: true` (never upgrade
a cheap session). The reader (`pickEconomicalContainedModel`, web_fetch/recap)
shares the same gate. Supersedes the "Shared role profiles" section above.

**Why:** the reviewed tables were a dated maintenance burden (each new model
generation needed a hand-edit, stamped "reviewed on <date>"), and the tier
classifier already encodes "how capable is this model" from price + a curated
anchor map — the same judgment the tables hand-wrote per provider. One mechanism
now answers both "which prompt register" and "which secondary model". This also
**closes the capability floor** the auto-mode entry recorded as still-open: a
sub-Haiku (`tiny`) model can no longer become the security-gate classifier,
because selection excludes that tier and steps *up* (never down) when a provider
has no `cheap` model. On the classifier this is the deliberate, user-ratified
divergence from Claude Code (which keeps a Sonnet-class screener on an Opus
session): One Code screens on the cheapest capable model for cost, and the
`autoMode.classifierModel` knob is there for anyone who wants otherwise.

**Consequences and the load-bearing rules that survived:**

- **Selection never honors `CC_PROMPT_TIER`.** That env var forces the
  *session's* prompt-scaffolding register; feeding it to the selector would
  collapse every candidate to one tier and let a `tiny` model past the floor.
  `economicalContainedCandidates` classifies with a frozen empty env, so
  selection always judges each model on its intrinsic tier. (Regression-tested.)
- **Unpriced / opaque providers degrade to the session model.** The tier
  selector needs price to rank and treats unpriced/opaque rows as `tiny`, so a
  self-hosted or exotic provider yields no cheaper pick and screens/delegates on
  the session model — correct, merely not cheap. This is the price paid for
  deleting the curated tables; it was judged acceptable because the mainstream
  priced providers (anthropic, openai, google, xai, deepseek, …) are exactly the
  ones the tables covered well.
- **A fork never gets an automatic or default model.** A fork inherits the
  parent transcript, so it must continue on this conversation's exact model; the
  resolution loop skips forks entirely (they already reject per-call `model`).
- **The classifier stamp mirrors the subagent's.** `classifierModelSetFor`
  records the containment a `/auto-mode model` choice was made on; a
  cross-provider setting whose stamp no longer matches the session is treated as
  stale and overridden with a warning — `isStaleContainmentStamp` is the one
  shared predicate. A same-session cross-provider choice is honored with an
  *informational* notice (not a warning — the user asked for it).
- **Subagents fall back to the session model at spawn.** An automatically
  chosen model that can't spawn (withdrawn/not entitled) degrades to the session
  model with a surfaced note rather than failing the whole subagent; a per-call
  model (source `call`) is never swapped — it surfaces its error so the main
  model retries. The resume path carries the same fallback.

**Rejected:** keeping `ROLE_PROFILES` as an unpriced-provider fallback — it
reintroduces the two-mechanism split the change set out to remove, and the
session-model degradation is a safe, already-documented outcome.
