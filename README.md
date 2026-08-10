# One Code

**The Claude Code experience — on any model you want.**

One Code gives you Claude Code's whole workflow: subagents, ultracode workflows,
skills, MCP, plan mode, hooks, a real permission system, project memory — but
runs it on **any provider**. Anthropic, OpenAI, Gemini, a local Ollama model, or
a gateway like OpenRouter. The **same tool surface**, the same `.claude/` config,
your choice of brain behind it.

Free and open source (MIT). No lock-in, no subscription, no fork of anything —
One Code is a package for the [pi coding agent](https://github.com/earendil-works/pi),
so upstream improvements land as a version bump.

## Install

One project, two npm packages — pick the one that fits you:

| You | Install | Package |
|---|---|---|
| **Most people** (new to pi included) | `npm install -g @one-ai/one-code` | [`@one-ai/one-code`](https://www.npmjs.com/package/@one-ai/one-code) — the app: its own `one-code` command, a pinned pi bundled inside, state isolated in `~/.one-code`, coexists with any existing `pi` |
| Already running pi, want it on your own install | `pi install npm:one-code-extension` | [`one-code-extension`](https://www.npmjs.com/package/one-code-extension) — just the extensions; rides your pi (tested against pi 0.83–0.84, warns outside that range) |

```bash
npm install -g @one-ai/one-code
cd your-project && one-code
```

A Homebrew tap is coming soon.

> Needs **Node 22.19+**.

## Two-minute quickstart — free, no card

You need one model-provider key. Two providers hand out **free frontier-adjacent
models** today, so you can try the whole thing for nothing:

- **OpenCode Zen** ([opencode.ai/zen](https://opencode.ai/zen)) — sign up, copy
  your API key. Free model: `deepseek-v4-flash-free`.
- **OpenRouter** ([openrouter.ai](https://openrouter.ai)) — sign up, create a
  key (or just OAuth from inside One Code). Free models carry a `:free` suffix —
  `nvidia/nemotron-3-ultra-550b-a55b:free` is genuinely good.

Then:

```bash
cd your-project
one-code            # first run asks for a provider — pick one, paste the key
```

Inside the session: `/login` connects more providers (OpenRouter supports
"Sign in with OpenRouter", no key-copying needed), `/model` switches models.
Env vars work too: `OPENCODE_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, and friends are picked up automatically.

*(On the pi-package install, the same applies with `pi` as the command.)*

---

## Why One Code

- **Bring your own model.** Not tied to one vendor. Switch mid-session with
  `/model`, or drive a cheap local model for routine work and a frontier model
  for the hard parts.
- **Your Claude Code setup already works.** `CLAUDE.md`, `.claude/commands`,
  `.claude/skills`, `.claude/agents`, `.mcp.json`, installed plugins, and
  `settings.json` permission rules are all picked up unchanged. Nothing to port.
- **The features that make Claude Code good live in the harness, not the model** —
  and One Code brings all of them across.

---

## What you get

### 🤖 Subagents
Delegate work to child agents that each get their own context window, so only
the answer comes back — not the noise. Define them as markdown in
`.claude/agents/`, pick their model per agent, or `fork` one that inherits your
conversation. Run them in the background and message them while they work, or
isolate each in its own git worktree (below). Three ship in the box:
`general-purpose`, `explore`, and `plan`.

### ⚡ Ultracode workflows
For big jobs — a broad audit, a migration, a review worth double-checking — say
**`ultracode`** and the model writes a short JavaScript script that fans work out
across many agents in parallel. Runs go to the background with a live progress
panel; every run is journaled, so re-running replays the unchanged parts for
free. Save scripts in `.claude/workflows/` to invoke by name.

### 🔒 Permissions & auto mode
A real permission gate reads your existing `allow`/`deny`/`ask` rules from
`.claude/settings.json` (`deny` always wins). Cycle modes with **ctrl+q** —
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
Send the whole session into an isolated git worktree with `enter_worktree` —
branched from your current HEAD under `.claude/worktrees/`, so every command and
relative path runs there and your working tree stays untouched until you
`exit_worktree`. Subagents can each take their own worktree too, so a fan-out
that edits files runs in parallel without ever colliding.

### 🧩 Skills, plugins & MCP
Standard [Agent Skills](https://agentskills.io) from `.claude/skills/`, whole
Claude Code **plugins** (their agents, skills, commands, and MCP servers, all
namespaced), and any **MCP server** from `.mcp.json` — every MCP tool is loaded
on demand so it never bloats the prompt.

### 🪝 Hooks
Claude Code command hooks run unchanged — `PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `SessionStart`, `Stop`, and more — with the same stdin JSON,
exit-code semantics, and output envelope. Project hooks run only after a one-time
consent prompt.

### 🧠 Memory & long sessions
Per-repo auto-memory that persists facts across sessions, a session scratchpad,
and Claude Code's own compaction prompt so long conversations shrink cleanly
instead of falling off a cliff. On Anthropic, old thinking is trimmed
automatically to keep sessions cheap.

### 🛠️ The same tool surface as Claude Code
`read`, `write`, `edit`, `bash` (with background runs), `grep`, `find`, `ls`,
`todo_write`, `notebook_edit`, `web_search`, `web_fetch`, `lsp_diagnostics`
(live language-server diagnostics after edits), `ask_user_question`, task
tracking, background monitors, scheduled wake-ups — and `tool_search`, which
keeps rarely-used schemas out of the prompt until they're needed. On Anthropic
and recent OpenAI models this uses the provider's native deferred-tool
mechanism, so loading a tool never invalidates your cached prompt.

Every Claude Code tool has a counterpart here, so muscle memory and rules carry
over: Claude Code's own PascalCase names — `Read`, `Bash`, `Edit`, `Task`,
`WebFetch`, `TodoWrite`, `EnterWorktree`, and the rest — are accepted verbatim in
your `.claude/settings.json` permission rules and hook matchers, mapped to the
matching tool automatically.

### 🎚️ Reasoning effort & 🎨 themes
An `/effort` slider from `minimal` to `max` (and `ultracode` past the end), on
the same dial shift+tab cycles. Two themes ship — `one-code` (dark) and
`one-code-light` — a warm clay accent in the spirit of Claude Code's terminal.

---

## Everything else, briefly

| | |
|---|---|
| **Slash commands** | `/permissions`, `/auto-mode`, `/agents`, `/skills`, `/todos`, `/subagent`, `/effort`, `/workflows`, `/plugins`, `/mcp`, `/lsp`, and every plugin command (namespaced). |
| **Ported system prompt** | Claude Code's system prompt, adapted and tiered by model capability so smaller models get more guidance. |
| **Steering** | `<system-reminder>` nudges, read-before-write and stale-edit guards, and denial feedback that the model actually learns from. |
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
mode**, not a promise that the model will behave. Every action is gated: `deny`
rules always win, risky operations get stopped, and auto mode's classifier keeps
you in flow without dropping the boundary. Want an OS-level hard wall on top? Run
pi inside a container — the permission gate and the container compose.

## Good to know

- **Web search** uses your provider's own search API (OpenAI, Anthropic,
  Gemini), so it needs a provider that offers one.
- **LSP diagnostics** need the language server on your `PATH` (e.g.
  `npm i -g typescript-language-server typescript`).
- Verified end-to-end on Anthropic and OpenAI models, and through **OpenRouter**
  (which brokers many open models — DeepSeek, Llama, Qwen, and more); other
  providers work but are less exercised.
- **Platforms:** developed and verified on **macOS and Linux**; **WSL** works
  the same way (it *is* Linux). Native Windows is **untested best-effort** for
  now: pi itself requires a bash there (Git Bash — see pi's Windows docs), and
  One Code has known gaps on native Windows (hooks and background shells assume
  `/bin/sh`). Don't rely on it until a Windows smoke test lands in a future
  release.

## License

MIT — see [LICENSE](LICENSE). Contributions welcome.
