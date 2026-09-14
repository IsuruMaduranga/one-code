# One Code

**Claude Code with the model slot left open. The full workflow, open source, on any model or provider.**

Claude Code is a good harness. It just ships bolted to one model. One Code
unbolts it, and runs the whole workflow (subagents, git worktrees, auto mode,
ultracode workflows, plan mode) on the model you pick. Keep Claude Code for the
work that earns its best model. Reach for One Code whenever a cheaper or
different model fits the job.

The parts that make the harness good (the steering, the permission gate, the
context management) live in the harness, not the model. One Code brings all of
them across, because the good part was never the logo.

<p align="center">
  <img src="demo/onecode.gif" alt="One Code switching models and running an agentic task" width="820">
</p>

[User guide](docs/guide/README.md) ·
[Bring your Claude Code setup](docs/guide/bring-your-claude-code-setup.md) ·
[Differences from Claude Code](docs/guide/differences-from-claude-code.md) ·
[Command reference](docs/guide/reference.md)

## ✨ What you get

- **Any model, any provider.** Anthropic, OpenAI, Gemini, OpenRouter, or a
  local model. Bring your own and switch mid-session with `/model`. Nothing
  stops you.
- **Mix providers in one session.** The parent and each subagent pick their own
  model and provider, so an ultracode workflow can fan out to a cheap tier while
  the parent stays on a frontier model. A single-gateway setup cannot do this,
  which is usually the reason people switch.
- **Your Claude Code setup runs unchanged.** `CLAUDE.md`, `.claude/commands`,
  `.claude/skills`, `.claude/agents`, `.mcp.json`, plugins, and permission rules
  are picked up as they are. No migration, and no second config file to keep in
  sync.
- **Capability-tiered prompting.** A weaker model gets more guidance, not less.
  Not out of politeness; it is how you get output you can use.
- **A package, not a fork.** One Code is a [pi](https://github.com/earendil-works/pi)
  package, so you extend it with your own extensions, themes, and settings.
  Forks go stale; packages do not have to.
- **Free and open source** under the MIT license.

## 🤔 Can't I just point Claude Code at another model?

You can. Set `ANTHROPIC_BASE_URL` to an Anthropic-compatible endpoint (Ollama,
a gateway, a proxy) and pass `--model`. Claude Code will talk to whatever
answers. If you want Claude Code's exact interface on one model and the
results are good, that's a fine setup and you don't need One Code.

It stops being enough the moment you want more than one model, or a model that
isn't Claude 5-class. Here is what the base URL trick can't do and One Code
does.

**One endpoint means one model for everything.** The main conversation, every
subagent, the permission classifier, compaction, and the small side jobs all go
to the same place. One Code picks a model per role: a frontier model in charge,
a cheap fast model for a fan-out of subagents, a contained model for the
classifier. Each role can sit on a different provider. This is the usual reason
people switch, and no gateway gives it to you.

**Claude Code's prompts were written for Claude.** Recent versions send Opus
and Fable a short prompt, because Claude 5 models need little guidance. Point
that harness at a smaller model and it gets a prompt written for a model that
isn't there. Skills go unused, the task list is ignored, and it edits with prose
instead of tools. One Code reads the model's capability and sends one of four
prompt registers, from Claude Code's lean frontier prompt to a heavily
scaffolded one for small and local models, with explicit search tools switched
on where a model needs them. A weaker model gets more help, not the same prompt
with a different logo.

**Caching is per provider, and the request has to be shaped for it.** Claude
Code's requests carry Anthropic's explicit cache markers with a one-hour
lifetime, deferred tool definitions, and effort settings. A translation layer
has to turn those into another provider's dialect, and what survives depends on
the layer. Other providers also cache differently: most match on an exact
prefix, so one moved byte re-bills the whole context. One Code talks to each
provider through its native API, sets the cache lifetime the provider actually
supports, keeps the system prompt and the first message byte-stable across a
session, and staggers parallel subagents so the first one warms the cache for
the rest. This is measured, not assumed; the repository ships the probe that
checks it.

**Anthropic-only features have to land somewhere.** Deferred tool loading,
Anthropic's server-side web search, and the thinking block are constructs of
Anthropic's API. Behind a translating endpoint they are dropped, rejected, or
turned off, and the model in front of you never had them. One Code does
deferred tool loading on every provider, maps reasoning effort onto the
provider's own dial, and uses the provider's search when it has one, else
Brave, Tavily, or Exa.

**Side jobs name Claude models.** Claude Code asks for specific Claude models
for its cheap side calls. Behind a gateway, either the gateway answers to those
names or the calls fail. One Code selects each side model from your provider's
own catalog, with a capability floor and a check that your account can actually
use it.

**And it's a package, not a fork.** One Code is a set of pi extensions, so you
can add a tool, a theme, a hook, or a whole workflow as one more extension.
Claude Code isn't open source; a base URL is the only knob it gives you.

## 🚀 Get started

You need **Node.js 22.19+**. One Code is developed and verified on macOS and
Linux; WSL works too. Native Windows is untested.

```bash
npm install -g @one-ai/one-code
cd your-project
onecode
```

Inside One Code, run `/login` to connect a provider, then `/model` to pick a
model. You can also pass a provider key through an environment variable such as
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`.

Open a project that already has a `CLAUDE.md` or `.claude/` setup and One Code
reuses it right away. Starting fresh? `/init` drafts a `CLAUDE.md` for you.

Not sure what is wired up? Run `onecode doctor` (or `/doctor report` inside a
session). It reports which providers have credentials, which model each role
uses, what of your Claude Code configuration was picked up, and which programs
are missing. `/doctor` runs the full checkup and has the model fix what it finds.

One Code is free. Model access, usage charges, and rate limits are between you
and your provider. See [Providers and models](docs/guide/providers-and-models.md)
for connection options.

### Other ways to install

**Homebrew** installs Node for you:

```bash
brew install isurumaduranga/one-ai/onecode
```

**Already on pi?** Add the extensions to your existing installation:

```bash
pi install npm:one-code-extension
```

The app package, [`@one-ai/one-code`](https://www.npmjs.com/package/@one-ai/one-code),
bundles a pinned pi and gives you the `onecode` command. The extension package,
[`one-code-extension`](https://www.npmjs.com/package/one-code-extension), runs on
your own pi and is tested against pi 0.83 to 0.85; use `pi` in place of `onecode`
for that install.

The app opens in a full-screen terminal interface by default. See the
[installation guide](docs/guide/installation.md) for display settings and more.

## 🎛️ Put different models to work

A main conversation and a repository-wide investigation do not need the same
model. Keep your preferred model in charge and let subagents use another
provider for exploration, tests, or review.

1. Choose the main model with `/model`.
2. Set the default for subagents and workflow agents with
   `/subagent <provider/model-id>`.
3. Ask for delegated work, for example:

   > Use subagents to investigate the authentication code and its tests.
   > Have them report their findings, then make the fix in the main session.

Agent definitions in `.claude/agents/` can name their own model, tools, and
instructions. Use `/agents` to follow their progress and `/model` to change the
main model as the task changes.

This is where you decide where the money goes. Actual cost and quality depend on
the models, the task, and how much you delegate.

[Subagents and workflows →](docs/guide/subagents-and-workflows.md)

## ♻️ Reuse the setup you already have

One Code reads Claude Code configuration directly. There is no import step.

| Your configuration | How One Code uses it |
|---|---|
| `CLAUDE.md` | Project instructions, including nested files and `@path` imports. Falls back to `AGENTS.md` when a directory has no `CLAUDE.md`. |
| `.claude/skills/` and `.claude/commands/` | Discoverable skills and slash commands. |
| `.claude/agents/` | Subagent definitions with their model, tools, and instructions. |
| `.claude/settings.json` | `allow`, `deny`, and `ask` permission rules, plus supported command hooks. |
| `.mcp.json` | MCP servers with tools loaded on demand. |
| Installed Claude Code plugins | Plugin agents, skills, commands, and MCP servers, namespaced by plugin. |

Claude Code tool names such as `Read`, `Bash`, `Edit`, and `Task` work in
permission rules and hook matchers. One Code keeps its own settings separately
and treats `~/.claude` as read-only, so nothing you already have gets rewritten.

Compatibility covers configuration and workflow surfaces. Features and skills
that need Claude Code's own hosted or desktop services are not included.

[Configuration details →](docs/guide/bring-your-claude-code-setup.md) ·
[Skills, plugins, and MCP →](docs/guide/skills-plugins-and-mcp.md)

## ⚙️ Workflows that scale with the task

### Subagents and git worktrees

Give an investigation its own context window and bring the result back to the
main conversation. Subagents run in the background, take follow-up messages, and
can fork the current conversation when they need its context. Three agent
definitions ship with One Code: `general-purpose`, `explore`, and `plan`.

For parallel edits, give agents their own git worktrees. You can also move the
whole session into a worktree with `enter_worktree` and leave it with
`exit_worktree`.

### Ultracode workflows

Put **`ultracode`** in a request for a broad audit, migration, or review. The
model writes a JavaScript workflow that coordinates agents in parallel, with
progress visible in `/workflows`. Use `/effort ultracode` to keep this behavior
on across turns.

Resume an interrupted run to reuse completed agent calls whose inputs still
match. Save reusable scripts in `.claude/workflows/` to call them by name.
Optional output-token targets stop new and queued agents once reached;
agents already running can finish above the target.

### Permissions and planning

**Auto mode is the default.** A classifier judges actions that need review,
while permission rules and deterministic checks enforce the rest. `deny` rules
beat `allow` rules. Trust approval covers project-provided hooks, MCP servers,
and allow rules.

Press **ctrl+q** to cycle through manual, accept-edits, plan, and auto modes.
Plan mode lets the agent investigate and write a plan file before you approve
implementation. Use `/permissions` to inspect rules and `/auto-mode` to
configure the classifier.

The permission system is an application-level control. For OS-level isolation,
run One Code inside a container. The guide spells out the guarantees and the
known gaps.

[Permissions and modes →](docs/guide/permissions-modes-and-auto-mode.md) ·
[Hooks →](docs/guide/hooks.md)

## 🧰 Everyday tools

| Capability | What you get |
|---|---|
| Code and files | Read, write, edit, shell commands, background processes, repository search, and notebook editing. |
| Web | Search and fetch, with provider search or Brave, Tavily, and Exa fallbacks. |
| Diagnostics | Language-server diagnostics after edits; install the relevant server on your `PATH`. |
| Long sessions | Per-repository memory, a session scratchpad, and context compaction. |
| Task tracking | A pinned progress widget, background monitors, and scheduled wake-ups. |
| Tool discovery | Deferred tools loaded when needed to keep prompt overhead down. |
| Reasoning and appearance | `/effort` or **shift+tab** for reasoning effort; `onecode` and `onecode-light` themes. |
| Customization | Extend One Code with pi extensions, themes, and settings. |

The bundled skills include `simplify`, `code-review`, `security-review`, and
`fewer-permission-prompts`. A project skill with the same name wins.

For scripting and session management:

```bash
onecode -p "Explain how authentication works in this repository"
onecode -c                       # continue the previous session
onecode --mode json              # JSON event output
onecode --permission-mode plan   # start in plan mode
```

See [Tools](docs/guide/tools.md) for every tool the model can call and the
[command reference](docs/guide/reference.md) for every command, shortcut, flag,
and environment variable.

## 📚 Documentation

The [user guide](docs/guide/README.md) covers everything: installation,
providers and models, the terminal interface, configuration, permissions and
auto mode, hooks, subagents and workflows, skills, plugins, and MCP, tools,
sessions and context, background work, the doctor, differences from Claude Code,
troubleshooting, and a full reference.

## 💡 Good to know

- **Providers:** end-to-end testing has focused on Anthropic, OpenAI, and
  OpenRouter. Other providers are less exercised, so expect the occasional rough
  edge.
- **Web search:** set `BRAVE_SEARCH_API_KEY` or `TAVILY_API_KEY` on a provider
  without native search. With neither key, the fallback is Exa's rate-limited
  keyless endpoint, and One Code labels those results.
- **Native Windows:** hooks and background shells assume `/bin/sh` for now. Use
  WSL until native Windows is verified.

## 🔧 Install from source

This installs the local extensions into an existing pi installation:

```bash
git clone https://github.com/IsuruMaduranga/one-code
cd one-code
npm install
cd ..
pi install ./one-code
pi list
```

## 🧠 Learn the ideas behind it

One Code is the practical companion to the Harness Engineering 101 series, which
builds these ideas up from first principles: what a coding harness actually does,
and why the good parts are model-independent.

## 📄 License

[MIT](LICENSE). Contributions welcome.
