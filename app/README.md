# One Code

**The Claude Code experience — on any model you want.**

This is the bundled One Code app: one install, batteries included. It ships
its own pinned copy of the [pi coding agent](https://github.com/earendil-works/pi)
and the full One Code extension set, keeps all of its state isolated under
`~/.one-code`, and coexists cleanly with any `pi` you already have — separate
command, separate config, separate sessions.

```bash
npm install -g one-code
cd your-project && one-code
```

Or via Homebrew (installs Node for you too):

```bash
brew install IsuruMaduranga/one-code/one-code
```

Needs **Node 22.19+** on the npm route. Credentials for at least one model
provider are asked for on first run (or use `/login`).

## What you get

Claude Code's whole workflow — subagents, ultracode workflows, skills, MCP,
plan mode, hooks, a real permission system, project memory, `.claude/`
compatibility — on **any provider**: Anthropic, OpenAI, Gemini, a local Ollama
model, or a gateway like OpenRouter. Full feature tour:
[github.com/IsuruMaduranga/one-code](https://github.com/IsuruMaduranga/one-code#readme).

Every pi command works as `one-code <command>`: `one-code -p "…"` one-shots,
`one-code -c` continues, `one-code --mode json` for scripts, `one-code
--session <id>` resumes.

## Already running pi?

If you'd rather add One Code to your **own** pi install (shared config, your
pi version), use the pi package instead:

```bash
pi install npm:one-code-extension
```

The app and the package are the same code; the app just pins a tested pi and
isolates its state.

MIT © Isuru Wijesiri
