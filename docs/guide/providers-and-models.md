# Providers and models

[← One Code user guide](README.md)

One Code talks to each model provider natively, so you choose the provider
and the model, and you can change either one during a session. This page
covers connecting a provider, storing a key, switching models, how One Code
picks models for its side roles, and web search on providers without a
search API.

## Connect your first provider

You need one provider API key to start. On the first run there is no
provider yet, so the banner shows `model none` and points you at `/login`.
Start One Code and run `/login` to pick a provider and paste a key, or sign
in through the browser where the provider supports it:

```bash
cd your-project
onecode
# then, inside One Code:
/login
```

Alternatively, set the provider's key as an environment variable before
launching. One Code picks it up and no `/login` is needed.

Two providers hand out free models you can try at no cost:

- **OpenCode Zen** ([opencode.ai/zen](https://opencode.ai/zen)): sign up and
  copy your API key. A free model is `deepseek-v4-flash-free`.
- **OpenRouter** ([openrouter.ai](https://openrouter.ai)): sign up and create
  a key, or sign in from inside One Code with no key copying. Free models
  carry a `:free` suffix, such as `nvidia/nemotron-3-ultra-550b-a55b:free`.

pi stores credentials in its agent directory (`~/.onecode/agent/` under
the bundled app). `/logout` removes them.

## Store keys as environment variables

pi reads provider keys from the environment, so you can set them once:

| Provider | Environment variable |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google | `GEMINI_API_KEY` |
| OpenCode Zen | `OPENCODE_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |

Other providers pi supports follow the same pattern; see pi's provider
documentation for the full list.

## Switch models

Run `/model` to see the models available from your connected providers and
pick one, or pass `--model provider/model-id` at launch. **ctrl+p** cycles
through models. The switch takes effect on your next message, so you can
start a task on one model and finish it on another.

Every interactive `/model` choice is saved as pi's default, so the next
session starts on the same model. A `--model` flag wins for that session
without changing the saved default.

Changing the model re-caches the conversation, so the next request costs
more than usual.

## Run a cheap model with a frontier model

Because each provider is native, different parts of the same session can
run on different models:

- **Switch as the task changes.** Use `/model` to move between a cheap model
  for routine work and a stronger one for the hard parts.
- **A cheaper subagent tier.** Subagents, workflow agents, the auto-mode
  classifier, and the reader model behind web fetch and recaps all run on
  their own model. One Code picks these automatically; see the next section.
  `/subagent` sets the subagent default by hand, and `/auto-mode model` the
  classifier.

This matters most for `ultracode` workflows, which fan work out across many
agents at once. Running those agents on a cheap tier keeps a large fan-out
affordable while the parent session stays on a frontier model.

## Automatic model selection

For its side roles, One Code chooses a model from the **same provider** as
your session; automatic picks never send your data to another provider. The
choice is the cheapest model in your session's tier (see the next section):

- **Subagents** run on the cheapest model in your session's tier or above
  that's cheaper than your main model. An Opus session delegates to Sonnet
  5.5, both frontier; a Haiku-tier session never gets upgraded. If nothing
  cheaper qualifies, subagents use the main model.
- **The classifier** uses the same rule. It also has to fit your session's
  whole context window, and it's never an experimental build (a `-exp`
  model). The pick is redone when you switch models. If nothing qualifies,
  your own model screens its calls.
- **The reader** (web fetch answers, recaps) uses the cheapest model that
  isn't tiny.

You can choose the subagent and classifier models yourself with `/subagent`
and `/auto-mode model`. Naming a model is choosing it, even on another
provider. One Code still tells you when a choice looks off, when you make it
and again when a session starts:

- **A newer model is available** in the same line at about the same price.
  GPT-5.6 Sol gets "GPT-6.1 Sol is newer and costs less". The same notice
  appears when you pick an older main model with `/model`.
- **The model is far weaker than your session's**: two or more tiers below
  it, like a cheap-tier classifier for a frontier session.
- **The classifier's context window is smaller than your session's.** It
  still screens, but once the conversation outgrows it, each call asks for
  your approval until you `/compact`.

`suggestNewerModels: false` in `~/.onecode/settings.json` turns off the
newer-model notices; the other two always show. `/doctor report` lists all
three under the model they apply to.

Claude Code's model aliases work everywhere: `sonnet`, `haiku`, `opus` and
`fable` resolve to a model of that name when your provider has one, and
otherwise to the matching class within your provider (`haiku` the cheapest
non-tiny model, `sonnet` the cheapest workhorse-tier model, `opus` and
`fable` your main model). They never switch providers.

An automatic pick is always a model the public catalogs know and consider
current. It skips a model that a newer one from the same vendor replaces at
about the same price, one more than two years older than its vendor's newest
release, and anything deprecated, unable to call tools, or unpriced.
Provider aliases such as `:free` or `:online` variants are skipped too.

`/doctor report` shows the model each role gets and why, and `/doctor
presets` offers three coordinated presets; see
[Model presets](doctor.md#model-presets).

## Prompting adapts to the model

One Code classifies every model into one of four prompt tiers and adjusts
the system prompt to match:

| Tier | Models | Prompt |
|---|---|---|
| Frontier | Opus and Fable, current generation, Sonnet 5.5 and later, and OpenAI's GPT-6 Astra and Sol, served by Anthropic and OpenAI themselves. | Claude Code's terse prompt. |
| Workhorse | A vendor's large current models. | Claude Code's full prompt. |
| Cheap | A vendor's smaller models, and large ones a year or more behind its newest. | The verbose prompt Claude Code gives Haiku. |
| Tiny | Small models: under 40 billion parameters. | The verbose prompt plus extra scaffolding and the `grep`, `find`, and `ls` tools. |

Frontier follows Claude Code's own rule, by model version. Everything else
comes from three public catalogs: [models.dev](https://models.dev) for
release dates and prices, OpenRouter's model list, and Hugging Face for
parameter counts. Each model is compared with its own vendor's current
lineup, not with other vendors:

- An open-weight model is workhorse when it has at least half the
  parameters of the vendor's largest current model.
- A model with no published size is workhorse when its price is at least
  30 percent of the median price of the vendor's current models. The
  median keeps a premium `-pro` or `-fast` model from setting the bar.
- A vendor with fewer than three current priced models has nothing to
  compare against, so its models count as cheap.
- A workhorse model more than a year older than its vendor's newest one
  drops to cheap. Age never makes a model tiny.

A model no catalog knows is tiny when its name gives a small size (`27b`)
or it has no price or runs on a custom provider, and cheap otherwise.

One Code ships with a copy of all three catalogs and refreshes them once a
day in the background from interactive sessions; a one-shot `-p` run only
reads the copy on disk. A refresh changes the tier at your next session or
model switch, never in the middle of one. Set `"refreshModelCatalog": false`
in `~/.onecode/settings.json` (or `PI_OFFLINE=1`) to stay on the copy you
have.

If you disagree with a tier, set it yourself in `~/.onecode/settings.json`,
by `provider/id` or by bare model id:

```json
{
  "modelTiers": {
    "openrouter/qwen/qwen3.8-max": "workhorse",
    "glm-5.3-flash": "cheap"
  }
}
```

This setting is read from your user settings only, never from a project.
`CC_PROMPT_TIER` forces one tier for the session's prompt when you want to
experiment. `/doctor report` shows the tier in use and the rule that set it.

The tier also decides which permission shortcuts apply in auto and
accept-edits modes (see [What is approved without a classifier
call](permissions-modes-and-auto-mode.md#what-is-approved-without-a-classifier-call)).
`CC_PROMPT_TIER` never changes the permission checks; `modelTiers` does,
because it states what the model is.

Like Claude Code, One Code gives frontier models and Sonnet 5 or later no
task list: the `task_create` family is left out, along with the prompt line
that points at it. Set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` to turn the task
tools back on for them.

## Web search on providers without a search API

Web search uses your provider's own search when it has one (Anthropic,
OpenAI, Gemini, xAI). On any other provider (OpenRouter, Z.ai, Ollama,
DeepSeek direct, and the rest) One Code falls back to a third-party search
API, in this order:

1. **Brave Search**, when `BRAVE_SEARCH_API_KEY` is set.
2. **Tavily**, when `TAVILY_API_KEY` is set.
3. **Exa's free keyless endpoint**, when neither key is set. It's
   rate-limited and best-effort, so One Code warns you the first time a
   session uses it and labels every result that came from it.

Both Brave and Tavily have free tiers. If you would rather not use
environment variables, put the keys in `~/.onecode/settings.json`:

```json
{
  "webSearch": {
    "apiKeys": { "brave": "…", "tavily": "…" },
    "order": ["tavily", "brave", "exa-free"]
  }
}
```

`order` is optional. A backend that fails is skipped and the result says
so. Web fetch works on every provider; it never depends on a search API.

## Provider notes

- Verification has focused on Anthropic, OpenAI, and OpenRouter. Other
  providers are less exercised.
- Some models reject request options others accept (a temperature, a
  reasoning setting). One Code sends minimal options to its side calls for
  this reason, and a side call that still fails does so loudly: a
  classifier that can't answer blocks the action; a reader that fails
  returns the raw page.
- Interactive sessions request the provider's extended prompt cache (one
  hour on Anthropic). Subagents and one-shot runs use the short default.
  See [The prompt cache](sessions-and-context.md#the-prompt-cache).
