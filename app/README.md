# One Code

**The Claude Code experience — on any model you want.**

This is the bundled One Code app: one install, batteries included. It ships
its own pinned copy of the [pi coding agent](https://github.com/earendil-works/pi)
and the full One Code extension set, keeps all of its state isolated under
`~/.onecode`, and coexists cleanly with any `pi` you already have — separate
command, separate config, separate sessions. You don't need to know anything
about pi to use it.

```bash
npm install -g @one-ai/one-code
cd your-project && onecode
```

Or via Homebrew (installs Node for you too):

```bash
brew install isurumaduranga/one-ai/one-code
```

The npm route needs **Node 22.19+**.

## Two-minute quickstart — free, no card

You need one model-provider key. Two providers hand out **free models** today,
so you can try everything for nothing:

- **OpenCode Zen** ([opencode.ai/zen](https://opencode.ai/zen)) — sign up,
  copy your API key. Free model: `deepseek-v4-flash-free`.
- **OpenRouter** ([openrouter.ai](https://openrouter.ai)) — sign up and create
  a key, or just OAuth from inside One Code (`/login` → "Sign in with
  OpenRouter"). Free models carry a `:free` suffix —
  `nvidia/nemotron-3-ultra-550b-a55b:free` is genuinely good.

Then:

```bash
cd your-project
onecode            # first run asks for a provider — pick one, paste the key
```

Inside the session: `/login` connects more providers, `/model` switches
models mid-session. Env vars work too: `OPENCODE_API_KEY`,
`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and friends are
picked up automatically.

## What you get

Claude Code's whole workflow — subagents, ultracode workflows, skills, MCP,
plan mode, hooks, a real permission system, project memory, `.claude/`
compatibility — on **any provider**: Anthropic, OpenAI, Gemini, a local Ollama
model, or a gateway like OpenRouter. Full feature tour:
[github.com/IsuruMaduranga/one-code](https://github.com/IsuruMaduranga/one-code#readme).

Every pi command works as `onecode <command>`: `onecode -p "…"` one-shots,
`onecode -c` continues, `onecode --mode json` for scripts, `onecode
--session <id>` resumes.

## The two One Code packages

| npm package | What it is |
|---|---|
| **`@one-ai/one-code`** (this one) | The app. Bundles a pinned, tested pi; isolated state; zero pi knowledge required. The command it installs is `onecode`. **Most people want this.** |
| [`one-code-extension`](https://www.npmjs.com/package/one-code-extension) | Just the extensions, for people already running pi: `pi install npm:one-code-extension`. Rides your pi version. |

Same code either way; the app just pins a tested pi and isolates its state.

MIT © Isuru Wijesiri
