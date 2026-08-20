# One Code

**The full Claude Code experience, on any model you want.**

One Code runs the whole Claude Code workflow (subagents, git worktrees, auto
mode, ultracode workflows, plan mode) on the model of your choice, from your
existing setup. Use it alongside Claude Code:

- **Any model.** Anthropic, OpenAI, Gemini, or a local one. Bring your own, and
  switch mid-session.
- **Save your Claude budget.** Send routine edits and token-heavy ultracode
  workflows to a cheaper model, and keep the frontier one for the work that
  earns it.
- **Mix providers in a single session.** Run subagents on a different, cheaper
  provider than the parent, something a single-gateway setup can't do.
- **Use the subscriptions you already pay for.** Sign in with any AI subscription you have and
  your Claude Code setup works the same.
- **Never get blocked.** Hit a weekly or 5-hour Claude limit, switch providers,
  and keep going.
- **Make it yours.** One Code is built as a [pi](https://github.com/earendil-works/pi) package, not a fork, so you can
  extend and customize it with your own pi extensions, themes, and settings.
- **Free and open source (MIT).** No lock-in, no subscription.

New here? The [user guide](docs/guide/README.md) walks through installing,
connecting a provider, reusing your Claude Code config, and driving every
feature.

## Install

One project, two npm packages. Pick the one that fits you:

| You | Install | Package |
|---|---|---|
| **Most people** (new to pi included) | `npm install -g @one-ai/one-code` | [`@one-ai/one-code`](https://www.npmjs.com/package/@one-ai/one-code): the app, with its own `one-code` command, a pinned pi bundled inside, state isolated in `~/.one-code`, coexisting with any existing `pi` |
| Already running pi, want it on your own install | `pi install npm:one-code-extension` | [`one-code-extension`](https://www.npmjs.com/package/one-code-extension): the extensions only; rides your pi (tested against pi 0.83-0.84, warns outside that range) |

```bash
npm install -g @one-ai/one-code
cd your-project && one-code
```

Or via Homebrew (also installs Node for you):

```bash
brew install isurumaduranga/one-ai/one-code
# or tap once, then run: brew tap isurumaduranga/one-ai && brew install one-code
```

> The npm route needs **Node 22.19+**.

> Tip: the app opens in a **full-screen TUI** (alt-screen, restores your
> terminal on exit) by default. On your own pi that's opt-in: set
> `"tuiMode": "fullscreen"` in `~/.pi/agent/settings.json`, or launch with
> `pi --tui-mode fullscreen`.

## Two-minute quickstart (free, no card)

You need one model-provider key. Two providers hand out **free frontier-adjacent
models** today, so you can try the whole thing for nothing:

- **OpenCode Zen** ([opencode.ai/zen](https://opencode.ai/zen)): sign up, copy
  your API key. Free model: `deepseek-v4-flash-free`.
- **OpenRouter** ([openrouter.ai](https://openrouter.ai)): sign up, create a
  key (or OAuth from inside One Code). Free models carry a `:free` suffix, and
  `nvidia/nemotron-3-ultra-550b-a55b:free` is genuinely good.

Then:

```bash
cd your-project
one-code            # first run asks for a provider: pick one, paste the key
```

Inside the session: `/login` connects more providers (OpenRouter supports
"Sign in with OpenRouter", no key-copying needed), `/model` switches models.
Env vars work too: `OPENCODE_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, and friends are picked up automatically.

*(On the pi-package install, the same applies with `pi` as the command.)*

---

## Why One Code

You've invested in a Claude Code setup (a `CLAUDE.md`, some skills, subagents,
hooks, permission rules), and today only Claude Code can read it. One Code runs
that same setup on any model, so it works as a companion to Claude Code: keep
Claude Code for the work that earns its best model, and reach for One Code
whenever a cheaper or different model fits the job better.

- **Your Claude Code setup runs unchanged.** `CLAUDE.md`, `.claude/commands`,
  `.claude/skills`, `.claude/agents`, `.mcp.json`, installed plugins, and
  `settings.json` permission rules are all picked up as they are. Nothing to
  port, nothing to rewrite.
- **Use a model you already pay for.** Have a ChatGPT subscription but not an
  Anthropic one? Run your Claude config on GPT. Switch providers mid-session
  with `/model`.
- **Stop burning frontier tokens on grunt work.** Point a cheap or free model at
  the routine edits and searches, and save the frontier model for the parts that
  actually need it.
- **Mix providers in one session, the thing a gateway can't do.** Pointing
  Claude Code at a gateway is one base URL per session, so every subagent runs
  on whatever the parent runs on. Here the parent and each subagent choose their
  own model and provider. An `ultracode` workflow that fans out to hundreds of
  agents can run them on a cheap tier while the parent stays frontier, and at
  that scale the subagent tier *is* the bill, so this is arithmetic, not a
  preference.
- **Keep working when Claude cuts you off.** Hit a weekly or 5-hour usage limit?
  Point One Code at another provider and carry on with the same setup, instead
  of waiting for the window to reset.

The features that make Claude Code good (the steering, the permission gate, the
context management) live in the harness, not the model. One Code brings all of
them across, and tiers its prompting by capability so a weaker model gets more
guidance, not less.

---

## What you get

### 🤖 Subagents
Delegate work to child agents that each get their own context window, so only
the answer comes back, not the noise. Define them as markdown in
`.claude/agents/`, pick their model per agent, or `fork` one that inherits your
conversation. Run them in the background and message them while they work, or
isolate each in its own git worktree (see the Git worktrees section). Three
ship in the box: `general-purpose`, `explore`, and `plan`.

### ⚡ Ultracode workflows
For big jobs (a broad audit, a migration, a review worth double-checking), say
**`ultracode`** and the model writes a short JavaScript script that fans work out
across many agents in parallel. Runs go to the background with a live progress
panel; every run is journaled, so re-running replays the unchanged parts for
free. Save scripts in `.claude/workflows/` to invoke by name.

### 🔒 Permissions and auto mode
A real permission gate reads your existing `allow`/`deny`/`ask` rules from
`.claude/settings.json` (`deny` always wins). Cycle modes with **ctrl+q**:
manual → accept-edits → plan → **auto**. Auto mode removes routine prompts
*without* removing the boundary: a classifier screens each action, reads pass
freely, and risky operations (writes outside your project, credential paths,
force pushes, `curl | bash`) get stopped unless *you* named them. A deterministic
safety floor protects the agent's own config no matter what the model decides.

### 📋 Plan mode
Enter a read-only planning mode where the model can only write to a dedicated
plan file. Review the finished plan in an approval dialog before a single line of
code changes. The plan survives context compaction, and you can edit the file
yourself while it works.

### 🌿 Git worktrees
Send the whole session into an isolated git worktree with `enter_worktree`,
branched from your current HEAD under `.claude/worktrees/`, so every command and
relative path runs there and your working tree stays untouched until you
`exit_worktree`. Subagents can each take their own worktree too, so a fan-out
that edits files runs in parallel without ever colliding.

### 🧩 Skills, plugins, and MCP
Standard [Agent Skills](https://agentskills.io) from `.claude/skills/`, whole
Claude Code **plugins** (their agents, skills, commands, and MCP servers, all
namespaced), and any **MCP server** from `.mcp.json`. Every MCP tool is loaded
on demand so it never bloats the prompt. A small catalog of Claude Code's own
built-in skills ships bundled (`simplify`, `code-review`, `security-review`,
and `fewer-permission-prompts`), so they show up in the skill list and run the
same way; a skill of the same name in your `.claude/skills/` takes precedence.

### 🪝 Hooks
Claude Code command hooks run unchanged (`PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `SessionStart`, `Stop`, and more) with the same stdin JSON,
exit-code semantics, and output envelope. Project hooks run only after a one-time
consent prompt.

### 🧠 Memory and long sessions
Per-repo auto-memory that persists facts across sessions, a session scratchpad,
and Claude Code's own compaction prompt so long conversations shrink cleanly
instead of falling off a cliff. On Anthropic, old thinking is trimmed
automatically to keep sessions cheap.

### 🛠️ The same tool surface as Claude Code
`read`, `write`, `edit`, `bash` (with background runs), `grep`, `find`, `ls`,
`notebook_edit`, `web_search`, `web_fetch`, `lsp_diagnostics`
(live language-server diagnostics after edits), `ask_user_question`, stateful
task tracking with a pinned progress widget, background monitors, scheduled
wake-ups, and `tool_search`, which
keeps rarely-used schemas out of the prompt until they're needed. On Anthropic
and recent OpenAI models this uses the provider's native deferred-tool
mechanism, so loading a tool never invalidates your cached prompt.

Every Claude Code tool has a counterpart here, so muscle memory and rules carry
over: Claude Code's own PascalCase names (`Read`, `Bash`, `Edit`, `Task`,
`WebFetch`, `TaskCreate`, `EnterWorktree`, and the rest) are accepted verbatim in
your `.claude/settings.json` permission rules and hook matchers, mapped to the
matching tool automatically.

### 🎚️ Reasoning effort and 🎨 themes
An `/effort` slider from `minimal` to `max` (and `ultracode` past the end), on
the same dial shift+tab cycles. Two themes ship, `one-code` (dark) and
`one-code-light`, with a warm clay accent in the spirit of Claude Code's
terminal.

---

## Everything else, briefly

| | |
|---|---|
| **Slash commands** | `/permissions`, `/auto-mode`, `/agents`, `/skills`, `/todos`, `/subagent`, `/effort`, `/workflows`, `/plugins`, `/mcp`, `/lsp`, and every plugin command (namespaced). |
| **Ported system prompt** | Claude Code's system prompt, adapted and tiered by model capability so smaller models get more guidance. |
| **Customize and extend** | One Code is a stock pi package, so you can add your own pi extensions, drop in more themes, and tune behavior through pi and `.claude` settings. It never forks or patches pi. |
| **Other modes** | `pi -p "…"` one-shot · `pi -c` continue · `pi --mode json` for scripts · `pi --permission-mode plan` · `pi --model <provider/id>`. |

---

## Install from source

```bash
git clone https://github.com/IsuruMaduranga/one-code
cd one-code && npm install && cd ..
pi install ./one-code           # a path install still needs `npm install` first for deps
pi list                        # confirm it registered
```

## A real boundary, not a leap of faith

Like Claude Code, One Code's security model is the **permission system plus auto
mode**, not a promise that the model behaves. Every action is gated: `deny`
rules always win, risky operations get stopped, and auto mode's classifier keeps
you in flow without dropping the boundary. Want an OS-level hard wall on top? Run
pi inside a container: the permission gate and the container compose.

## Good to know

- **Web search** uses your provider's own search API (OpenAI, Anthropic,
  Gemini), so it needs a provider that offers one.
- **LSP diagnostics** need the language server on your `PATH` (for example,
  `npm i -g typescript-language-server typescript`).
- Verified end-to-end on Anthropic and OpenAI models, and through **OpenRouter**
  (which brokers many open models: DeepSeek, Llama, Qwen, and more); other
  providers work but are less exercised.
- **Built-in skills not included:** One Code bundles Claude Code's
  self-contained review/setup skills (`simplify`, `code-review`,
  `security-review`, `fewer-permission-prompts`), but not the ones that depend
  on Claude Code's own hosting or desktop surfaces. Left out: the Artifact and
  claude.ai/design skills (`design`, `design-sync`, `dataviz`, the
  `artifact-*` guides, and the dashboard/report/table/explainer/plan/whiteboard
  publishers); the harness-and-account skills (`update-config`,
  `keybindings-help`, `claude-in-chrome`, `debug`, `usage`/`explain-usage`,
  `setup-cowork`, `schedule` cloud routines, `batch`, and `claude-code-guide`);
  `run`/`run-skill-generator` (One Code uses project-local run skills instead);
  and `claude-api` (a large reference skill, deferred). `commit`, `pr`, `loop`,
  and `init` are covered by One Code's own commands and the `commit-commands`
  plugin.
- **Platforms:** developed and verified on **macOS and Linux**; **WSL** works
  the same way (it *is* Linux). Native Windows is **untested best-effort** for
  now: pi itself requires a bash there (Git Bash, see pi's Windows docs), and
  One Code has known gaps on native Windows (hooks and background shells assume
  `/bin/sh`). Don't rely on it until a Windows smoke test lands in a future
  release.

## License

MIT. See [LICENSE](LICENSE). Contributions welcome.
