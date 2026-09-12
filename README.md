# One Code

**A familiar Claude Code experience, with your choice of model for every agent.**

One Code brings familiar Claude Code workflows to a terminal coding agent that
lets you choose the models. It includes subagents, plan mode, permissions,
skills, and git worktrees. Reuse your existing Claude Code setup, keep a capable model
in the main conversation, delegate routine work to a cheaper one, and switch
providers during a session.

- **Bring your setup.** Reuse `CLAUDE.md`, skills, commands, subagents, hooks,
  permission rules, and MCP configuration.
- **Choose models per task.** The main session and its subagents can use
  different models and providers: Anthropic, OpenAI, Gemini, OpenRouter, or
  local models supported by [pi](https://github.com/earendil-works/pi).
- **Keep control as work grows.** Plan before editing, isolate changes in git
  worktrees, and follow parallel agents from a live progress panel.

Built on pi. Free and open source under the MIT license. Works alongside
Claude Code, with the bundled app's state kept in `~/.onecode`.

<p align="center">
  <img src="demo/onecode.gif" alt="One Code switching models and running an agentic task" width="820">
</p>

[User guide](docs/guide/README.md) ·
[Bring your Claude Code setup](docs/guide/bring-your-claude-code-setup.md) ·
[Differences from Claude Code](docs/guide/differences-from-claude-code.md) ·
[Command reference](docs/guide/reference.md)

## Get started

Requires **Node.js 22.19+**. Developed and verified on **macOS and Linux**;
WSL is also supported. Native Windows is currently untested.

```bash
npm install -g @one-ai/one-code
cd your-project
onecode
```

Inside One Code, run `/login` to connect a provider, then `/model` to choose a
model. You can also supply a provider key through an environment variable such
as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`.

Open a project with an existing `CLAUDE.md` or `.claude/` setup to reuse it
immediately. For a new project, `/init` drafts a `CLAUDE.md`.

Not sure what is ready? `onecode doctor` (or `/doctor report` inside a session)
reports which providers have credentials, which model each role will use, what
of your Claude Code configuration was picked up, and which programs are missing;
`/doctor` runs the full checkup, where the model repairs the findings.

One Code is free; model access, usage charges, and rate limits depend on your
provider. See [Providers and models](docs/guide/providers-and-models.md) for
connection options.

### Other ways to install

**Homebrew** installs Node for you:

```bash
brew install isurumaduranga/one-ai/onecode
```

**Already using pi?** Add the extensions to your existing installation:

```bash
pi install npm:one-code-extension
```

The app package, [`@one-ai/one-code`](https://www.npmjs.com/package/@one-ai/one-code),
bundles a pinned pi version and provides the `onecode` command. The extension
package, [`one-code-extension`](https://www.npmjs.com/package/one-code-extension),
runs on your own pi and is tested against pi 0.83–0.85. Use `pi` in place of
`onecode` for that installation.

The app opens in a full-screen terminal interface by default. See the
[installation guide](docs/guide/installation.md) for display settings and more
details.

## Put different models to work

A main conversation and a repository-wide investigation do not need the same
model. With One Code, you can keep your preferred model in charge while
subagents use another provider for exploration, tests, or review.

1. Choose the main model with `/model`.
2. Set the default for subagents and workflow agents with
   `/subagent <provider/model-id>`.
3. Ask for delegated work, for example:

   > Use subagents to investigate the authentication code and its tests.
   > Have them report their findings, then make the fix in the main session.

Agent definitions in `.claude/agents/` can specify their own models, tools,
and instructions. Use `/agents` to follow their progress and `/model` to
change the main model as the task changes.

This gives you control over where you spend model capacity. Actual cost and
quality depend on the models, task, and amount of delegated work.

[Subagents and workflows →](docs/guide/subagents-and-workflows.md)

## Reuse the setup you already have

One Code reads Claude Code configuration directly, without an import step.

| Your configuration | How One Code uses it |
|---|---|
| `CLAUDE.md` | Project instructions, including nested files and `@path` imports. Falls back to `AGENTS.md` when no `CLAUDE.md` exists in a directory. |
| `.claude/skills/` and `.claude/commands/` | Discoverable skills and slash commands. |
| `.claude/agents/` | Subagent definitions with their model, tools, and instructions. |
| `.claude/settings.json` | `allow`, `deny`, and `ask` permission rules, plus supported command hooks. |
| `.mcp.json` | MCP servers with tools loaded on demand. |
| Installed Claude Code plugins | Plugin agents, skills, commands, and MCP servers, namespaced by plugin. |

Claude Code tool names such as `Read`, `Bash`, `Edit`, and `Task` work in
permission rules and hook matchers. One Code stores its own settings separately
and treats `~/.claude` as read-only.

Compatibility covers these configuration and workflow surfaces. Features and
skills that require Claude Code's own hosted or desktop services are not
included.

[Configuration details →](docs/guide/bring-your-claude-code-setup.md) ·
[Skills, plugins, and MCP →](docs/guide/skills-plugins-and-mcp.md)

## Workflows that scale with the task

### Subagents and git worktrees

Give an investigation its own context window and bring the result back to the
main conversation. Subagents run in the background, can receive follow-up
messages, and can fork the current conversation when they need its context.
Three agent definitions ship with One Code: `general-purpose`, `explore`, and
`plan`.

For parallel edits, give agents separate git worktrees. You can also move the
whole session into a worktree with `enter_worktree` and leave it with
`exit_worktree`.

### Ultracode workflows

Include **`ultracode`** in a request for a broad audit, migration, or review.
The model writes a JavaScript workflow to coordinate agents in parallel, with
progress visible in `/workflows`. Use `/effort ultracode` to keep this behavior
active across turns.

Resume an interrupted run to reuse completed agent calls whose inputs still
match. Save reusable scripts in `.claude/workflows/` to invoke them by name.
Optional output-token targets stop new and queued agents once reached;
already-running agents can finish above the target.

### Permissions and planning

**Auto mode is the default.** A classifier evaluates actions that need review,
while permission rules and deterministic checks enforce additional restrictions.
`deny` rules take precedence over `allow` rules. Trust approval covers
project-provided hooks, MCP servers, and allow rules.

Press **ctrl+q** to cycle through manual, accept-edits, plan, and auto modes.
Plan mode lets the agent investigate and write a dedicated plan file before
you approve implementation. Use `/permissions` to inspect rules and `/auto-mode`
to configure the classifier.

The permission system is an application-level control. For OS-level isolation,
run One Code inside a container. The guarantees and the known gaps are spelled
out in the guide.

[Permissions and modes →](docs/guide/permissions-modes-and-auto-mode.md) ·
[Hooks →](docs/guide/hooks.md)

## Everyday tools

| Capability | What you get |
|---|---|
| Code and files | Read, write, edit, shell commands, background processes, repository search, and notebook editing. |
| Web | Search and fetch, with provider search or Brave, Tavily, and Exa fallbacks. |
| Diagnostics | Language-server diagnostics after edits; install the relevant server on your `PATH`. |
| Long sessions | Per-repository memory, a session scratchpad, and context compaction. |
| Task tracking | A pinned progress widget, background monitors, and scheduled wake-ups. |
| Tool discovery | Deferred tools loaded when needed to reduce prompt overhead. |
| Reasoning and appearance | `/effort` or **shift+tab** for reasoning effort; `onecode` and `onecode-light` themes. |
| Customization | Extend One Code with pi extensions, themes, and settings. |

The bundled skills include `simplify`, `code-review`, `security-review`, and
`fewer-permission-prompts`. A project skill with the same name takes precedence.

For scripting and session management:

```bash
onecode -p "Explain how authentication works in this repository"
onecode -c                       # continue the previous session
onecode --mode json              # JSON event output
onecode --permission-mode plan   # start in plan mode
```

See [Tools](docs/guide/tools.md) for every tool the model can call and the
[command reference](docs/guide/reference.md) for every command, shortcut,
flag, and environment variable.

## Documentation

The [user guide](docs/guide/README.md) covers everything: installation,
providers and models, the terminal interface, configuration, permissions and
auto mode, hooks, subagents and workflows, skills, plugins, and MCP, tools,
sessions and context, background work, the doctor, differences from Claude
Code, troubleshooting, and a full reference.

## Compatibility notes

- **Providers:** end-to-end verification has focused on Anthropic, OpenAI,
  and OpenRouter. Other providers are less exercised.
- **Web search:** set `BRAVE_SEARCH_API_KEY` or `TAVILY_API_KEY` when using a
  provider without native search. With neither key, the fallback is Exa's
  rate-limited keyless endpoint; One Code labels its results.
- **Native Windows:** hooks and background shells currently assume `/bin/sh`.
  Use WSL until native Windows support is verified.

## Install from source

This installs the local extensions into an existing pi installation:

```bash
git clone https://github.com/IsuruMaduranga/one-code
cd one-code
npm install
cd ..
pi install ./one-code
pi list
```

## License

[MIT](LICENSE). Contributions welcome.
