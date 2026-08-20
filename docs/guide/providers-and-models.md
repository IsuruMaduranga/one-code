# Providers and models

One Code talks to each model provider natively, so you choose the provider and
the model, and you can change either one during a session. This page covers
connecting a provider, storing a key, switching models, and running a cheap
model next to a frontier one.

## Connect your first provider

You need one provider API key to start. On the first run, One Code asks you to
pick a provider and paste a key:

```bash
cd your-project
onecode
```

Two providers hand out free models you can try at no cost:

- **OpenCode Zen** ([opencode.ai/zen](https://opencode.ai/zen)): sign up and
  copy your API key. A free model is `deepseek-v4-flash-free`.
- **OpenRouter** ([openrouter.ai](https://openrouter.ai)): sign up and create a
  key, or sign in from inside One Code with no key copying. Free models carry a
  `:free` suffix, such as `nvidia/nemotron-3-ultra-550b-a55b:free`.

## Store keys as environment variables

One Code reads provider keys from the environment automatically, so you can set
them once instead of pasting them each run:

| Provider | Environment variable |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| OpenCode Zen | `OPENCODE_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |

## Add more providers in a session

To connect another provider without leaving your session, run `/login`. It walks
you through adding a key. OpenRouter supports **Sign in with OpenRouter**, so you
authorize in the browser instead of copying a key.

## Switch models

Run `/model` to see the models available from your connected providers and pick
one. The switch takes effect on your next message, so you can start a task on one
model and finish it on another.

## Run a cheap model with a frontier model

Because each provider is native, different parts of the same session can run on
different models. Two common setups:

- **Cheap for routine work, frontier for the hard parts.** Switch with `/model`
  as the task changes, or set a cheaper default and reach for a stronger model
  only when you need it.
- **A cheap subagent tier.** Give a subagent its own model so delegated research
  and review run on an inexpensive model while your main session stays on a
  capable one. See [Subagents and workflows](subagents-and-workflows.md) for how
  to set a per-agent model.

This matters most for `ultracode` workflows, which fan work out across many
agents at once. Running those agents on a cheap tier keeps a large fan-out
affordable while the parent session stays on a frontier model.

## Prompting adapts to the model

One Code adjusts how much guidance the system prompt gives based on the model's
capability, so a smaller model receives more direction than a frontier one. You
do not configure this; it follows the model you select.

## Web search needs a provider that offers it

Web search uses your provider's own search API, available today on OpenAI,
Anthropic, and Gemini. If your current provider has no search API, web search is
unavailable until you switch to one that does.
