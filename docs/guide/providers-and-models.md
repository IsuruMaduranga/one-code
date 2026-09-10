# Providers and models

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

Credentials are stored by pi in its agent directory (`~/.onecode/agent/`
under the bundled app). `/logout` removes them.

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
  their own model. By default One Code picks these for you; see the next
  section. `/subagent` and `/auto-mode model` set them by hand.

This matters most for `ultracode` workflows, which fan work out across many
agents at once. Running those agents on a cheap tier keeps a large fan-out
affordable while the parent session stays on a frontier model.

## Automatic model selection

For its side roles, One Code chooses a model from the **same provider** as
your session; automatic picks never send your data to another provider. The
choice is the cheapest model that clears a capability floor:

- **Subagents** need a model at least as capable as your main model's tier,
  with some tolerance.
- **The classifier** needs a Sonnet-class model when your session runs a
  Sonnet-class or stronger model, and a Haiku-class model otherwise. This is
  Claude Code's own rule.
- **The reader** (web fetch answers, recaps) uses the cheapest capable
  model.

Capability is judged by tier (see the next section). Models are excluded
when they cannot call tools, have no price, or are a generation behind: a
model released more than a year after its vendor's newest is demoted one
tier, and one more than two years behind is never picked automatically.
Provider aliases such as `:free` or `:online` variants are skipped.

### Measured selection with Artificial Analysis

If you have an [Artificial Analysis](https://artificialanalysis.ai) API key,
One Code uses measured coding ability instead of name-based tiers for these
picks: a candidate must score at least the lower of your session model's
coding index and a Sonnet 5 reference (with 10 percent tolerance for
subagents). Set `AA_API_KEY`, or add the key to `~/.onecode/settings.json`:

```json
{
  "capabilityIndex": {
    "artificialAnalysisApiKey": "…"
  }
}
```

The snapshot is cached under `~/.onecode/cache/` and refreshed at most once
a day. Without a key, selection uses tiers alone. The measured index never
changes the prompt tier itself.

`/doctor report` shows the model each role gets and why, and `/doctor
presets` offers three coordinated presets; see
[Model presets](doctor.md#model-presets).

## Prompting adapts to the model

One Code classifies every model into one of four prompt tiers and adjusts
the system prompt to match:

| Tier | Models | Prompt |
|---|---|---|
| Frontier | Opus and Fable, current generation. | Claude Code's terse prompt. |
| Workhorse | Sonnet-class models and comparable third-party models. | Claude Code's full prompt. |
| Cheap | Haiku-class models and comparable "flash", "mini", or "small" models. | The verbose prompt Claude Code gives Haiku. |
| Tiny | Sub-Haiku models. | The verbose prompt plus extra scaffolding and the `grep`, `find`, and `ls` tools. |

The tier is derived from the model's name, release date, and price. You do
not configure it; set `CC_PROMPT_TIER` to force one when you want to
experiment. `/doctor report` shows the tier in use.

## Web search on providers without a search API

Web search uses your provider's own search when it has one (Anthropic,
OpenAI, Gemini, xAI). On any other provider (OpenRouter, Z.ai, Ollama,
DeepSeek direct, and the rest) One Code falls back to a third-party search
API, in this order:

1. **Brave Search**, when `BRAVE_SEARCH_API_KEY` is set.
2. **Tavily**, when `TAVILY_API_KEY` is set.
3. **Exa's free keyless endpoint**, when neither key is set. It is
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
  classifier that cannot answer blocks the action; a reader that fails
  returns the raw page.
- Interactive sessions request the provider's extended prompt cache (one
  hour on Anthropic). Subagents and one-shot runs use the short default.
  See [The prompt cache](sessions-and-context.md#the-prompt-cache).
